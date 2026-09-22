import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { openSearchClient, INDEX_NAME } from '../search/client';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const CAPTION_FACTS_TABLE = process.env.CAPTION_FACTS_TABLE!;
const TRANSCRIPT_SEGMENTS_TABLE = process.env.TRANSCRIPT_SEGMENTS_TABLE!;

export interface PurgeResult {
  framesRemoved: number;
  segmentsRemoved: number;
  removedFromIndex: number;
}

/**
 * Removes everything derived from a reel: frames, transcript segments, caption
 * facts and index documents.
 *
 * Shared by delete and retry. Retry needs it because a half-finished pipeline
 * leaves partial frames behind, and re-running over them would mix one run's
 * output with another's.
 */
export async function purgeDerived(mediaId: string): Promise<PurgeResult> {
  const [framesRemoved, segmentsRemoved, removedFromIndex] = await Promise.all([
    clearRows(TABLES.frames, mediaId, 'media_id, ts_ms'),
    clearRows(TRANSCRIPT_SEGMENTS_TABLE, mediaId, 'media_id, start_ms'),
    deleteFromIndex(mediaId),
  ]);
  await ddb.send(new DeleteCommand({ TableName: CAPTION_FACTS_TABLE, Key: { media_id: mediaId } }));
  return { framesRemoved, segmentsRemoved, removedFromIndex };
}

/** Frame images and, on a delete, the original. Keeps the prefix tidy. */
export async function purgeObjects(mediaId: string, options: { keepOriginal: boolean }): Promise<number> {
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `media/${mediaId}/` }),
  );
  const keys = (listed.Contents ?? [])
    .map(({ Key }) => Key!)
    // A retry re-extracts from the original, so that one object stays.
    .filter((key) => !(options.keepOriginal && /\/original\.[a-z0-9]+$/.test(key)));
  if (keys.length === 0) return 0;

  await s3.send(
    new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }),
  );
  return keys.length;
}

async function clearRows(table: string, mediaId: string, keyAttributes: string): Promise<number> {
  const rows = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'media_id = :id',
      ExpressionAttributeValues: { ':id': mediaId },
      ProjectionExpression: keyAttributes,
    }),
  );
  const items = rows.Items ?? [];
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [table]: items.slice(i, i + 25).map((key) => ({ DeleteRequest: { Key: key } })) },
      }),
    );
  }
  return items.length;
}

/**
 * By id from a search, not delete_by_query: OpenSearch Serverless does not
 * serve that endpoint, and the frame rows may already be gone.
 */
async function deleteFromIndex(mediaId: string): Promise<number> {
  const client = openSearchClient();
  let ids: string[];
  try {
    const found = await client.search({
      index: INDEX_NAME,
      body: { size: 500, _source: false, query: { term: { media_id: mediaId } } },
    });
    ids = ((found.body.hits.hits ?? []) as unknown as Array<{ _id: string }>).map((hit) => hit._id);
  } catch (err) {
    const type = (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type;
    if (type === 'index_not_found_exception') return 0;
    throw err;
  }
  if (ids.length === 0) return 0;

  const response = await client.bulk({
    body: ids.map((documentId) => ({ delete: { _index: INDEX_NAME, _id: documentId } })) as never,
  });
  const items = (response.body.items ?? []) as Array<Record<string, { status?: number }>>;
  return items.filter((item) => Object.values(item).some((op) => op.status === 200)).length;
}
