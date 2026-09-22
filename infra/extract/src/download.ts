import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createReadStream } from 'node:fs';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { run } from './ffmpeg';
import { explainDownloadFailure, toMediaFields, type YtDlpInfo } from './metadata';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const BUCKET = process.env.MEDIA_BUCKET!;
const MEDIA_TABLE = process.env.MEDIA_TABLE!;
const YT_DLP = process.env.YT_DLP_PATH ?? 'yt-dlp';
/**
 * Python needs the system OpenSSL, not the Node runtime's, or its ssl module
 * fails to load. Set on the subprocess only. See the Dockerfile.
 */
const YT_DLP_ENV = { LD_LIBRARY_PATH: process.env.PY_LD_LIBRARY_PATH ?? '/usr/lib64:/lib64' };
const FFMPEG_DIR = '/usr/local/bin';
/** Keep a reel comfortably under the extractor's ephemeral storage. */
const MAX_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES ?? 500 * 1024 * 1024);

export interface DownloadEvent {
  mediaId: string;
}

export interface DownloadResult {
  mediaId: string;
  s3Key: string;
  bytes: number;
  hasCaption: boolean;
}

/**
 * Fetches the video behind a public reel permalink into the media store, then
 * hands off to the same extraction the upload path uses.
 *
 * Public reels only: no credentials, no cookies, no logged-in session.
 */
export async function handler(event: DownloadEvent): Promise<DownloadResult> {
  const { mediaId } = event;
  if (!mediaId) throw new Error('mediaId is required');

  const record = await ddb.send(new GetCommand({ TableName: MEDIA_TABLE, Key: { id: mediaId } }));
  const media = record.Item as { permalink?: string } | undefined;
  if (!media) throw new Error(`media ${mediaId} not found`);
  if (!media.permalink) throw new Error(`media ${mediaId} has no permalink to download`);

  const workDir = await mkdtemp(path.join(tmpdir(), `download-${mediaId}-`));
  try {
    const info = await probeRemote(media.permalink);
    const declared = info.filesize ?? info.filesize_approx;
    if (declared && declared > MAX_BYTES) {
      throw new Error(`reel is ${declared} bytes, over the ${MAX_BYTES} byte limit`);
    }

    const file = await download(media.permalink, workDir);
    const { size } = await stat(file);
    if (size > MAX_BYTES) throw new Error(`downloaded ${size} bytes, over the ${MAX_BYTES} byte limit`);

    const s3Key = `media/${mediaId}/original.mp4`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: 'video/mp4',
      }),
    );

    const fields = toMediaFields(info);

    // Only set what the metadata actually gave us: a reel with no caption would
    // otherwise leave :raw referenced but undefined, which DynamoDB rejects.
    const sets = ['s3_key = :key', 'content_type = :type', '#bytes = :bytes'];
    const values: Record<string, unknown> = { ':key': s3Key, ':type': 'video/mp4', ':bytes': size };
    const optional: Array<[attribute: string, placeholder: string, value: unknown]> = [
      ['caption_raw', ':raw', fields.caption_raw],
      ['caption_normalized', ':norm', fields.caption_normalized],
      ['taken_at', ':taken', fields.taken_at],
      ['uploader', ':uploader', fields.uploader],
    ];
    for (const [attribute, placeholder, value] of optional) {
      if (value === undefined) continue;
      sets.push(`${attribute} = ${placeholder}`);
      values[placeholder] = value;
    }

    // attribute_exists: never resurrect a record deleted while this ran.
    await ddb.send(
      new UpdateCommand({
        TableName: MEDIA_TABLE,
        Key: { id: mediaId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: { '#bytes': 'bytes' },
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(id)',
      }),
    );

    console.log('downloaded', {
      mediaId,
      bytes: size,
      hasCaption: Boolean(fields.caption_raw),
      uploader: fields.uploader,
    });
    return { mediaId, s3Key, bytes: size, hasCaption: Boolean(fields.caption_raw) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Metadata pass first: it is cheap and tells us the size before we commit to it. */
async function probeRemote(url: string): Promise<YtDlpInfo> {
  try {
    const { stdout } = await run(
      YT_DLP,
      [...baseArgs(), '--dump-single-json', '--skip-download', url],
      YT_DLP_ENV,
    );
    return JSON.parse(stdout.toString('utf8')) as YtDlpInfo;
  } catch (err) {
    throw asDownloadError(err);
  }
}

async function download(url: string, workDir: string): Promise<string> {
  try {
    await run(
      YT_DLP,
      [
      ...baseArgs(),
      // Prefer a single progressive mp4; fall back to merging the best streams.
      '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG_DIR,
      '-o', path.join(workDir, 'reel.%(ext)s'),
      url,
      ],
      YT_DLP_ENV,
    );
  } catch (err) {
    throw asDownloadError(err);
  }

  const files = await readdir(workDir);
  const downloaded = files.find((f) => f.startsWith('reel.'));
  if (!downloaded) throw new Error('yt-dlp reported success but wrote no file');
  return path.join(workDir, downloaded);
}

function baseArgs(): string[] {
  return [
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '--no-cache-dir',
    // No cookies, no credentials: public reels only.
    '--no-cookies',
    '--socket-timeout', '30',
    '--retries', '3',
  ];
}

/** Surfaces a login wall as a login wall rather than a generic exit code. */
function asDownloadError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const { message, loginWalled } = explainDownloadFailure(raw);
  const error = new Error(message);
  error.name = loginWalled ? 'InstagramLoginWall' : 'DownloadFailed';
  return error;
}
