import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export interface StorageProps {
  /** Web origins allowed to PUT/GET presigned URLs directly against the bucket. */
  readonly webOrigins: string[];
  /** RETAIN data on stack deletion. Default false while the app is a skeleton. */
  readonly retainData: boolean;
  /** Lifecycle expiration for media objects. Undefined = keep forever (Phase 7 owns the setting UI). */
  readonly retentionDays?: number;
}

/**
 * S3 media store + DynamoDB tables.
 *
 * Single-user app: no user_id / tenant prefix anywhere. Media objects live at
 * media/{mediaId}/... and table items are keyed by media id alone.
 */
export class Storage extends Construct {
  readonly mediaBucket: s3.Bucket;
  readonly mediaTable: dynamodb.Table;
  readonly framesTable: dynamodb.Table;
  readonly jobsTable: dynamodb.Table;
  readonly connectionsTable: dynamodb.Table;
  readonly captionFactsTable: dynamodb.Table;
  readonly transcriptSegmentsTable: dynamodb.Table;
  readonly threadsTable: dynamodb.Table;
  readonly messagesTable: dynamodb.Table;

  /** Constant partition key value for the media recency index. */
  static readonly MEDIA_ENTITY = 'media';
  /** GSI on the media table: newest-first library listing. */
  static readonly MEDIA_BY_CREATED_AT = 'byCreatedAt';
  /** GSI on the jobs table: all jobs for one media item. */
  static readonly JOBS_BY_MEDIA = 'byMedia';
  /** GSI on the threads table: newest-first thread list. */
  static readonly THREADS_BY_CREATED_AT = 'byCreatedAt';

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    const removalPolicy = props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !props.retainData,
      cors: [
        {
          allowedOrigins: props.webOrigins,
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(7) },
        // Lens query screenshots are used once, to search with. Nothing refers
        // to them afterwards, so they expire rather than accumulate.
        { id: 'lens-queries', prefix: 'lens/', expiration: Duration.days(1) },
        ...(props.retentionDays
          ? [{ id: 'media-retention', prefix: 'media/', expiration: Duration.days(props.retentionDays) }]
          : []),
      ],
    });

    this.mediaTable = new dynamodb.Table(this, 'MediaTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Feeds the WebSocket broadcaster: every status change is pushed to the UI.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.retainData },
      removalPolicy,
    });
    // Library grid: one hot partition is fine for a single-user library.
    this.mediaTable.addGlobalSecondaryIndex({
      indexName: Storage.MEDIA_BY_CREATED_AT,
      partitionKey: { name: 'entity', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // One row per media item: hashtags, mentions, entities, places, language, cta.
    this.captionFactsTable = new dynamodb.Table(this, 'CaptionFactsTable', {
      partitionKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    // One row per spoken segment, keyed like frames so a citation can point at
    // either and the player can seek to it.
    this.transcriptSegmentsTable = new dynamodb.Table(this, 'TranscriptSegmentsTable', {
      partitionKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'start_ms', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    this.threadsTable = new dynamodb.Table(this, 'ThreadsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });
    this.threadsTable.addGlobalSecondaryIndex({
      indexName: Storage.THREADS_BY_CREATED_AT,
      partitionKey: { name: 'entity', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // created_at as the sort key keeps a thread's turns in order.
    this.messagesTable = new dynamodb.Table(this, 'MessagesTable', {
      partitionKey: { name: 'thread_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    this.framesTable = new dynamodb.Table(this, 'FramesTable', {
      partitionKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ts_ms', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      timeToLiveAttribute: 'expires_at',
    });
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: Storage.JOBS_BY_MEDIA,
      partitionKey: { name: 'media_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'started_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Open WebSocket connections. TTL sweeps any that never sent $disconnect.
    this.connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      partitionKey: { name: 'connection_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expires_at',
    });
  }
}
