import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Storage } from './storage';
import { Auth } from './auth';
import { Api } from './api';
import { Pipeline } from './pipeline';
import { Realtime } from './realtime';
import { Search } from './search';

export interface ReelLensStackProps extends StackProps {
  readonly webOrigins: string[];
  readonly retainData: boolean;
  readonly retentionDays?: number;
  readonly analysisModel: string;
  readonly maxFrames: number;
  readonly embeddingModel: string;
  readonly maxOcu: number;
}

/**
 * Media store, tables, sign-in, the drop-in mode API, the reel download and
 * keyframe extraction pipeline, and the WebSocket progress channel.
 * Claude analysis (Phase 3) and the vector index (Phase 4) land later.
 */
export class ReelLensStack extends Stack {
  constructor(scope: Construct, id: string, props: ReelLensStackProps) {
    super(scope, id, props);

    const storage = new Storage(this, 'Storage', {
      webOrigins: props.webOrigins,
      retainData: props.retainData,
      retentionDays: props.retentionDays,
    });

    const auth = new Auth(this, 'Auth', { webOrigins: props.webOrigins });

    const search = new Search(this, 'Search', { maxOcu: props.maxOcu });

    const api = new Api(this, 'Api', {
      storage,
      auth,
      webOrigins: props.webOrigins,
      search,
      analysisModel: props.analysisModel,
      embeddingModel: props.embeddingModel,
    });

    const pipeline = new Pipeline(this, 'Pipeline', {
      storage,
      search,
      analysisModel: props.analysisModel,
      maxFrames: props.maxFrames,
      embeddingModel: props.embeddingModel,
    });
    const realtime = new Realtime(this, 'Realtime', { storage, auth });

    // Both ingest routes kick off the pipeline: a completed upload goes straight
    // to extraction, a pasted permalink is downloaded first.
    for (const fn of [api.completeUploadFunction, api.createFromUrlFunction]) {
      pipeline.stateMachine.grantStartExecution(fn);
      fn.addEnvironment('STATE_MACHINE_ARN', pipeline.stateMachine.stateMachineArn);
    }

    new CfnOutput(this, 'ApiUrl', { value: api.httpApi.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'HostedUiDomain', { value: `${auth.domain.domainName}.auth.${this.region}.amazoncognito.com` });
    new CfnOutput(this, 'MediaBucketName', { value: storage.mediaBucket.bucketName });
    new CfnOutput(this, 'MediaTableName', { value: storage.mediaTable.tableName });
    new CfnOutput(this, 'WsUrl', { value: realtime.url });
    new CfnOutput(this, 'StateMachineArn', { value: pipeline.stateMachine.stateMachineArn });
    new CfnOutput(this, 'AnalysisModel', { value: props.analysisModel });
    new CfnOutput(this, 'WebSearchSecretArn', { value: api.webSearchSecret.secretArn });
  }
}
