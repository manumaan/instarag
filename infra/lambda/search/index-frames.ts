import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import type { MediaRecord } from '../shared/media';
import { documentId, openSearchClient, INDEX_NAME, type IndexedDocument } from './client';
import { embed } from './embed';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const CAPTION_FACTS_TABLE = process.env.CAPTION_FACTS_TABLE!;
const TRANSCRIPT_SEGMENTS_TABLE = process.env.TRANSCRIPT_SEGMENTS_TABLE!;

export interface IndexEvent {
  mediaId: string;
}

export interface IndexResult {
  mediaId: string;
  indexed: number;
  frames: number;
  speechSegments: number;
  skipped: number;
}

/**
 * Embeds every keyframe and writes one document per frame.
 *
 * Each vector covers the frame image *and* its description and OCR text
 * together, which is what lets one index serve both "find similar" from a
 * screenshot and a written question.
 */
export async function handler(event: IndexEvent): Promise<IndexResult> {
  const { mediaId } = event;
  if (!mediaId) throw new Error('mediaId is required');

  const [mediaResult, factsResult, frameRows, segmentRows] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id: mediaId } })),
    ddb.send(new GetCommand({ TableName: CAPTION_FACTS_TABLE, Key: { media_id: mediaId } })),
    ddb.send(
      new QueryCommand({
        TableName: TABLES.frames,
        KeyConditionExpression: 'media_id = :id',
        ExpressionAttributeValues: { ':id': mediaId },
      }),
    ),
    ddb.send(
      new QueryCommand({
        TableName: TRANSCRIPT_SEGMENTS_TABLE,
        KeyConditionExpression: 'media_id = :id',
        ExpressionAttributeValues: { ':id': mediaId },
      }),
    ),
  ]);

  const media = mediaResult.Item as MediaRecord | undefined;
  if (!media) throw new Error(`media ${mediaId} not found`);

  const caption = media.caption_normalized ?? media.caption_raw ?? '';
  const places = ((factsResult.Item?.places as Array<{ name?: string }> | undefined) ?? [])
    .map((place) => place.name)
    .filter(Boolean)
    .join(', ');

  const frames = (frameRows.Items ?? [])
    .filter((frame) => typeof frame.s3_key === 'string')
    .sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms));

  const client = openSearchClient();
  const operations: unknown[] = [];
  let skipped = 0;

  for (const frame of frames) {
    const description = (frame.description as string | undefined) ?? '';
    const ocrText = (frame.ocr_text as string | undefined) ?? '';
    // Without analysis there is nothing textual to match on; the image alone
    // still embeds, so index it rather than dropping the frame.
    if (!description && !ocrText) skipped += 1;

    const imageBase64 = await fetchFrame(frame.s3_key as string);
    const embedding = await embed({
      imageBase64,
      text: [description, ocrText, places, caption].filter(Boolean).join('\n'),
    });

    const document: IndexedDocument = {
      media_id: mediaId,
      ts_ms: Number(frame.ts_ms),
      kind: 'frame',
      description,
      ocr_text: ocrText,
      speech: '',
      caption,
      places,
      taken_at: media.taken_at,
      embedding,
    };
    operations.push({ index: { _index: INDEX_NAME, _id: documentId(mediaId, Number(frame.ts_ms), 'frame') } });
    operations.push(document);
  }

  // Speech segments are embedded from their text alone: there is no image for
  // a spoken moment, and Titan takes text on its own.
  const segments = (segmentRows.Items ?? []).sort((a, b) => Number(a.start_ms) - Number(b.start_ms));
  for (const segment of segments) {
    const text = String(segment.text ?? '').trim();
    if (!text) continue;
    const startMs = Number(segment.start_ms);
    const document: IndexedDocument = {
      media_id: mediaId,
      ts_ms: startMs,
      kind: 'speech',
      description: '',
      ocr_text: '',
      speech: text,
      caption,
      places,
      taken_at: media.taken_at,
      end_ms: Number(segment.end_ms ?? startMs),
      embedding: await embed({ text: [text, places].filter(Boolean).join('\n') }),
    };
    operations.push({ index: { _index: INDEX_NAME, _id: documentId(mediaId, startMs, 'speech') } });
    operations.push(document);
  }

  const frameCount = frames.length;
  const speechCount = operations.length / 2 - frameCount;
  if (operations.length === 0) {
    return { mediaId, indexed: 0, frames: 0, speechSegments: 0, skipped };
  }

  // No refresh param: OpenSearch Serverless rejects it ("true refresh policy is
  // not supported") and refreshes on its own within a few seconds.
  const response = await client.bulk({ body: operations as never });
  const errored = (response.body.items ?? []).filter((item: Record<string, { error?: unknown }>) =>
    Object.values(item).some((op) => op.error),
  );
  if (errored.length > 0) {
    throw new Error(`indexing failed for ${errored.length} frames: ${JSON.stringify(errored[0]).slice(0, 400)}`);
  }

  const result = {
    mediaId,
    indexed: operations.length / 2,
    frames: frameCount,
    speechSegments: speechCount,
    skipped,
  };
  console.log('indexed', result);
  return result;
}

async function fetchFrame(key: string): Promise<string> {
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await object.Body!.transformToByteArray()).toString('base64');
}
