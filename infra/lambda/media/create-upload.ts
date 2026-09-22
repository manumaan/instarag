import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, MEDIA_ENTITY } from '../shared/ddb';
import { badRequest, handler, parseJsonBody } from '../shared/http';
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, type MediaRecord } from '../shared/media';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const URL_TTL_SECONDS = 900;

interface Body {
  filename?: string;
  contentType?: string;
  bytes?: number;
}

/** POST /uploads — reserve a media id and hand back a presigned PUT URL. */
export const main = handler(async (event) => {
  const body = parseJsonBody<Body>(event);

  const contentType = body.contentType?.toLowerCase();
  if (!contentType) throw badRequest('contentType is required');
  const spec = ALLOWED_CONTENT_TYPES[contentType];
  if (!spec) {
    throw badRequest(`unsupported contentType ${contentType}; allowed: ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')}`);
  }
  if (typeof body.bytes !== 'number' || body.bytes <= 0) throw badRequest('bytes must be a positive number');
  if (body.bytes > MAX_UPLOAD_BYTES) throw badRequest(`file exceeds the ${MAX_UPLOAD_BYTES} byte limit`);

  const id = randomUUID();
  const s3Key = `media/${id}/original${spec.ext}`;

  const record: MediaRecord = {
    id,
    entity: MEDIA_ENTITY,
    source: 'upload',
    type: spec.type,
    status: 'awaiting_upload',
    created_at: new Date().toISOString(),
    s3_key: s3Key,
    content_type: contentType,
    bytes: body.bytes,
    original_filename: body.filename?.slice(0, 256),
  };
  await ddb.send(new PutCommand({ TableName: TABLES.media, Item: record }));

  // signableHeaders puts content-type in SignedHeaders, so S3 rejects a PUT
  // that sends anything else. Without it the presigner signs host alone and the
  // URL would accept an object of any type under our key.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: contentType }),
    { expiresIn: URL_TTL_SECONDS, signableHeaders: new Set(['content-type']) },
  );

  return { mediaId: id, s3Key, uploadUrl, expiresIn: URL_TTL_SECONDS, media: record };
});
