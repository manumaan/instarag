import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, MEDIA_BY_CREATED_AT, MEDIA_ENTITY, decodeCursor, encodeCursor } from '../shared/ddb';
import { handler } from '../shared/http';
import type { MediaRecord } from '../shared/media';

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

/** GET /media?limit&cursor — newest-first library listing. */
export const main = handler(async (event) => {
  const limitParam = Number(event.queryStringParameters?.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLES.media,
      IndexName: MEDIA_BY_CREATED_AT,
      KeyConditionExpression: '#entity = :entity',
      ExpressionAttributeNames: { '#entity': 'entity' },
      ExpressionAttributeValues: { ':entity': MEDIA_ENTITY },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: decodeCursor(event.queryStringParameters?.cursor),
    }),
  );

  return {
    items: (result.Items ?? []) as MediaRecord[],
    cursor: encodeCursor(result.LastEvaluatedKey),
  };
});
