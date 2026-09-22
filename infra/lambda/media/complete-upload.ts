import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { badRequest, handler, notFound, pathParam } from '../shared/http';
import type { MediaRecord } from '../shared/media';

const s3 = new S3Client({});
const sfn = new SFNClient({});
const BUCKET = process.env.MEDIA_BUCKET!;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;
/** How long a job row survives before the jobs table's TTL removes it. */
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * POST /media/{id}/complete — the browser finished its presigned PUT.
 * Verifies the object really landed, then moves the item to `queued`.
 */
export const main = handler(async (event) => {
  const id = pathParam(event, 'id');

  const existing = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id } }));
  const media = existing.Item as MediaRecord | undefined;
  if (!media) throw notFound('media not found');
  if (!media.s3_key) throw badRequest('media has no upload to complete');
  if (media.status !== 'awaiting_upload') return media; // idempotent

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: media.s3_key }));
  } catch {
    throw badRequest('upload not found in the media store; retry the PUT');
  }

  // Defence in depth behind the signed content-type: never hand Phase 2's
  // ffmpeg an object whose real type is not the one we recorded.
  if (head.ContentType && media.content_type && head.ContentType !== media.content_type) {
    throw badRequest(`uploaded object is ${head.ContentType}, expected ${media.content_type}`);
  }
  if (!head.ContentLength) throw badRequest('uploaded object is empty');

  const updated = await ddb.send(
    new UpdateCommand({
      TableName: TABLES.media,
      Key: { id },
      UpdateExpression: 'SET #status = :queued, #bytes = :bytes',
      ExpressionAttributeNames: { '#status': 'status', '#bytes': 'bytes' },
      ExpressionAttributeValues: { ':queued': 'queued', ':bytes': head.ContentLength ?? media.bytes },
      ReturnValues: 'ALL_NEW',
    }),
  );

  // Analysis runs on ingest: the pipeline owns every status after `queued`.
  if (STATE_MACHINE_ARN) {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        // Execution names must be unique; a retried completion starts a fresh run.
        name: `${id}-${Date.now()}`,
        input: JSON.stringify({
          mediaId: id,
          source: media.source,
          // A string, because the state machine writes it as a DynamoDB 'N'.
          jobExpiresAt: String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS),
        }),
      }),
    );
  }

  return updated.Attributes as MediaRecord;
});
