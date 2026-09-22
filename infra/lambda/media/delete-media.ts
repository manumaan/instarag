import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { openSearchClient, INDEX_NAME } from '../search/client';
import { ddb, TABLES } from '../shared/ddb';
import { handler, pathParam } from '../shared/http';
import type { MediaRecord } from '../shared/media';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const CAPTION_FACTS_TABLE = process.env.CAPTION_FACTS_TABLE!;
const TRANSCRIPT_SEGMENTS_TABLE = process.env.TRANSCRIPT_SEGMENTS_TABLE!;

/**
 * DELETE /media/{id} — drop the record, its frames, its caption facts, every
 * object under its prefix, and its documents in the vector index.
 *
 * The index matters: a document left behind stays retrievable, so Ask would go
 * on citing a reel the user deleted.
 */
export const main = handler(async (event) => {
  const id = pathParam(event, 'id');

  const result = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id } }));
  const media = result.Item as MediaRecord | undefined;

  // Deliberately idempotent: a delete that failed halfway leaves objects,
  // frame rows or index documents behind, and retrying has to finish the job
  // rather than 404 because the media row is already gone.
  if (!media) console.log('media row already gone; cleaning up whatever remains', { id });

  const objects = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `media/${id}/` }));
  if (objects.Contents?.length) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key: Key! })) },
      }),
    );
  }

  const frames = await ddb.send(
    new QueryCommand({
      TableName: TABLES.frames,
      KeyConditionExpression: 'media_id = :id',
      ExpressionAttributeValues: { ':id': id },
      ProjectionExpression: 'media_id, ts_ms',
    }),
  );
  for (let i = 0; i < (frames.Items?.length ?? 0); i += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLES.frames]: frames.Items!.slice(i, i + 25).map((key) => ({ DeleteRequest: { Key: key } })),
        },
      }),
    );
  }

  await ddb.send(
    new DeleteCommand({ TableName: CAPTION_FACTS_TABLE, Key: { media_id: id } }),
  );
  await deleteAllRows(TRANSCRIPT_SEGMENTS_TABLE, id, 'media_id, start_ms');

  const removedFromIndex = await deleteFromIndex(id);

  await ddb.send(new DeleteCommand({ TableName: TABLES.media, Key: { id } }));

  return { deleted: id, removedFromIndex };
});

/**
 * Deletes the reel's documents from the index.
 *
 * The ids come from the index itself rather than from the frame rows: not
 * delete_by_query, which OpenSearch Serverless answers 404 for, and not the
 * frame timestamps, because those rows may already be gone from an earlier
 * half-finished delete.
 */
async function deleteFromIndex(mediaId: string): Promise<number> {
  const client = openSearchClient();

  let ids: string[];
  try {
    const found = await client.search({
      index: INDEX_NAME,
      body: {
        size: 500,
        _source: false,
        query: { term: { media_id: mediaId } },
      },
    });
    const hits = (found.body.hits.hits ?? []) as unknown as Array<{ _id: string }>;
    ids = hits.map((hit) => hit._id);
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

/** Clears every row for one media id from a table keyed on media_id. */
async function deleteAllRows(table: string, mediaId: string, keyAttributes: string) {
  const rows = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'media_id = :id',
      ExpressionAttributeValues: { ':id': mediaId },
      ProjectionExpression: keyAttributes,
    }),
  );
  for (let i = 0; i < (rows.Items?.length ?? 0); i += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [table]: rows.Items!.slice(i, i + 25).map((key) => ({ DeleteRequest: { Key: key } })),
        },
      }),
    );
  }
}
