#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ReelLensStack } from '../lib/reel-lens-stack';

const app = new App();

/** Origins allowed to call the API and hold Hosted UI redirects. Override with -c webOrigins=... */
const webOrigins = (app.node.tryGetContext('webOrigins') ?? 'http://localhost:3000')
  .split(',')
  .map((o: string) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

/** Data survives `cdk destroy` when true. Default false while this is a skeleton. */
const retainData = app.node.tryGetContext('retainData') === 'true';

const retentionDaysRaw = app.node.tryGetContext('retentionDays');
const retentionDays = retentionDaysRaw ? Number(retentionDaysRaw) : undefined;

/**
 * Vision model for the analysis pass. Sonnet 5 is the decided model; this
 * account is not yet entitled to it on Bedrock, so the default stays on
 * Sonnet 4.6 until it is. Both are covered by the handler's IAM policy, so
 * switching is `-c analysisModel=us.anthropic.claude-sonnet-5`.
 */
const analysisModel = app.node.tryGetContext('analysisModel') ?? 'us.anthropic.claude-sonnet-4-6';

/** Keyframe cap. The main cost lever: every frame is an image in the reel's one call. */
const maxFrames = Number(app.node.tryGetContext('maxFrames') ?? 20);

/** Titan Multimodal Embeddings: one vector covers a frame's image and its text. */
const embeddingModel = app.node.tryGetContext('embeddingModel') ?? 'amazon.titan-embed-image-v1';

/**
 * OCU ceiling for the vector index. The collection is NEXTGEN and scales to
 * zero, so this caps the worst case rather than setting a floor.
 */
const maxOcu = Number(app.node.tryGetContext('maxOcu') ?? 2);

new ReelLensStack(app, 'ReelLens', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  webOrigins,
  retainData,
  retentionDays,
  analysisModel,
  maxFrames,
  embeddingModel,
  maxOcu,
  description: 'Reel Lens - Instagram reel/post analysis (Phase 1 skeleton)',
});
