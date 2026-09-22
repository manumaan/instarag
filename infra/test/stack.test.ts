import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ReelLensStack } from '../lib/reel-lens-stack';

function synth() {
  const app = new App();
  const stack = new ReelLensStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    webOrigins: ['http://localhost:3000'],
    retainData: false,
    analysisModel: 'us.anthropic.claude-sonnet-5',
    maxFrames: 20,
    embeddingModel: 'amazon.titan-embed-image-v1',
    maxOcu: 2,
  });
  return Template.fromStack(stack);
}

test('every API route is authorised by the user pool', () => {
  const template = synth();
  const routes = Object.entries(template.findResources('AWS::ApiGatewayV2::Route')).filter(
    ([, route]) => !String(route.Properties.RouteKey).startsWith('$'),
  );
  assert.equal(routes.length, 12);
  for (const [name, route] of routes) {
    assert.equal(route.Properties.AuthorizationType, 'JWT', `${name} must require a JWT`);
  }
});

test('the user pool refuses self-signup and hands out no client secret', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Cognito::UserPool', {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  });
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    GenerateSecret: false,
    AllowedOAuthFlows: ['code'],
  });
});

test('the media bucket is private, encrypted and TLS-only', () => {
  const template = synth();
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    BucketEncryption: Match.objectLike({ ServerSideEncryptionConfiguration: Match.anyValue() }),
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
      ]),
    }),
  });
});

test('no handler policy grants a wildcard action or an unscoped table', () => {
  const template = synth();
  for (const [name, policy] of Object.entries(template.findResources('AWS::IAM::Policy'))) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      const actions: string[] = [statement.Action].flat();
      for (const action of actions) {
        assert.ok(
          !/^(\*|s3:\*|dynamodb:\*)$/.test(action),
          `${name} grants overly broad action ${action}`,
        );
      }
      // dynamodb:ListStreams is the one action IAM cannot scope to a resource;
      // everything else must name its table, index or stream.
      const unscoped = actions.filter((a) => a.startsWith('dynamodb:') && a !== 'dynamodb:ListStreams');
      assert.ok(
        !(statement.Resource === '*' && unscoped.length > 0),
        `${name} grants ${unscoped.join(', ')} on *`,
      );
    }
  }
});

test('handlers only see table and bucket names, never credentials', () => {
  const template = synth();
  for (const [name, fn] of Object.entries(template.findResources('AWS::Lambda::Function'))) {
    // CDK's own custom-resource providers (bucket deployment, auto-delete) set
    // their own env vars; this check is about the handlers we write.
    if (name.startsWith('Custom')) continue;
    const env = fn.Properties.Environment?.Variables ?? {};
    for (const key of Object.keys(env)) {
      assert.ok(
        // Resource identifiers only — never a secret, key or token.
        /^(MEDIA_BUCKET|MEDIA_TABLE|FRAMES_TABLE|JOBS_TABLE|CONNECTIONS_TABLE|CAPTION_FACTS_TABLE|TRANSCRIPT_SEGMENTS_TABLE|STATE_MACHINE_ARN|USER_POOL_ID|USER_POOL_CLIENT_ID|WS_MANAGEMENT_ENDPOINT|SCENE_THRESHOLD|MAX_FRAMES|PHASH_THRESHOLD|MAX_DOWNLOAD_BYTES|YT_DLP_PATH|HOME|XDG_CACHE_HOME|ANALYSIS_MODEL_ID|SEARCH_SECRET_ARN|ANALYSIS_EFFORT|ANALYSIS_MAX_TOKENS|THREADS_TABLE|MESSAGES_TABLE|SEARCH_ENDPOINT|SEARCH_INDEX|EMBEDDING_MODEL_ID|EMBEDDING_DIMENSION|AWS_NODEJS_CONNECTION_REUSE_ENABLED)$/.test(
          key,
        ),
        `${name} has unexpected env var ${key}`,
      );
    }
  }
});

test('extraction and download are containers with room for a 500 MB reel', () => {
  const template = synth();
  const functions = Object.values(template.findResources('AWS::Lambda::Function')).filter(
    (fn) => fn.Properties.PackageType === 'Image',
  );
  assert.equal(functions.length, 2, 'extraction and download run from container images');
  for (const fn of functions) {
    assert.deepEqual(fn.Properties.Architectures, ['arm64']);
    assert.equal(fn.Properties.EphemeralStorage.Size, 2048);
    assert.ok(fn.Properties.Timeout >= 300, `timeout ${fn.Properties.Timeout}s is too short`);
  }
  // Both come from the same image asset; only the CMD differs.
  const images = new Set(functions.map((fn) => JSON.stringify(fn.Properties.Code.ImageUri)));
  assert.equal(images.size, 1, 'one image asset, two handlers');
  const overrides = functions.filter((fn) => fn.Properties.ImageConfig?.Command);
  assert.deepEqual(overrides[0].Properties.ImageConfig.Command, ['download.handler']);
});

test('a pasted permalink is downloaded before extraction, an upload is not', () => {
  const template = synth();
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
  const definition = JSON.stringify(machine.Properties.DefinitionString);
  for (const state of ['NeedsDownload', 'MarkDownloading', 'Download']) {
    assert.ok(definition.includes(state), `definition is missing ${state}`);
  }
  // The branch keys off the execution input's source field.
  assert.ok(definition.includes('$.source'), 'download branch must test $.source');
  assert.ok(definition.includes('url'), 'download branch must match source url');
});

test('the pipeline is a state machine that cannot leave an item mid-flight', () => {
  const template = synth();
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
  const definition = JSON.stringify(machine.Properties.DefinitionString);
  for (const state of ['StartJob', 'MarkExtracting', 'Extract', 'MarkReady', 'MarkFailed', 'FailJob']) {
    assert.ok(definition.includes(state), `definition is missing ${state}`);
  }
  assert.ok(definition.includes('Catch'), 'extraction failures must be caught and recorded');
});

test('only the ingest handlers may start the pipeline, and only that one', () => {
  const template = synth();
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>,
  );
  // Two ingest routes start the pipeline: completed upload and pasted permalink.
  const starts = statements.filter((s) => [s.Action].flat().includes('states:StartExecution'));
  assert.equal(starts.length, 2, 'only the two ingest handlers may start the pipeline');
  for (const statement of starts) {
    assert.ok(
      !JSON.stringify(statement.Resource).includes('"*"'),
      'StartExecution must name the state machine',
    );
  }
});

test('the media table streams changes to a broadcaster', () => {
  const template = synth();
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  });
  template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
});

test('the websocket connect route is authorised, disconnect is not', () => {
  const template = synth();
  const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties);
  const connect = routes.find((r) => r.RouteKey === '$connect');
  const disconnect = routes.find((r) => r.RouteKey === '$disconnect');
  assert.ok(connect, '$connect route exists');
  assert.equal(connect.AuthorizationType, 'CUSTOM');
  assert.ok(disconnect, '$disconnect route exists');
  template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    AuthorizerType: 'REQUEST',
    IdentitySource: ['route.request.querystring.token'],
  });
});

test('the analysis pass runs between extraction and ready', () => {
  const template = synth();
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
  const definition = JSON.stringify(machine.Properties.DefinitionString);
  for (const state of ['MarkAnalysing', 'Analyse']) {
    assert.ok(definition.includes(state), `definition is missing ${state}`);
  }
  // Order matters: analysis needs the frames extraction produced.
  assert.ok(
    definition.indexOf('Extract') < definition.indexOf('MarkAnalysing'),
    'analysis must follow extraction',
  );
});

test('Bedrock access is invoke-only and limited to named models', () => {
  const template = synth();
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>,
  );
  const invokes = statements.filter((s) => [s.Action].flat().some((a) => String(a).startsWith('bedrock:')));
  // Four callers, and adding a fifth should be a deliberate edit here: the
  // vision pass, the embedding stage, Ask, and Lens find-similar.
  assert.equal(
    invokes.length,
    5,
    'only the analysis, indexing, Ask and two Lens handlers may call Bedrock',
  );
  for (const statement of invokes) {
    assert.deepEqual(
      [statement.Action].flat(),
      ['bedrock:InvokeModel'],
      'invoke only, no training or model management',
    );
    const resources = JSON.stringify(statement.Resource);
    assert.ok(!resources.includes('"*"'), 'must not grant every model');
    assert.ok(
      /claude-sonnet-5|titan-embed/.test(resources),
      `unexpected model granted: ${resources}`,
    );
  }
});

test('the frame cap reaching the extractor is the one we configured', () => {
  const template = synth();
  const extract = Object.values(template.findResources('AWS::Lambda::Function')).find(
    (fn) => fn.Properties.PackageType === 'Image' && !fn.Properties.ImageConfig?.Command,
  );
  assert.equal(extract?.Properties.Environment.Variables.MAX_FRAMES, '20');
});

test('the vector index scales to zero rather than billing an idle floor', () => {
  const template = synth();
  // NEXTGEN is the whole point: a CLASSIC collection bills a 2-OCU minimum
  // (~$350/month) even when idle. NEXTGEN has no minimum and scales to zero.
  // It also rejects StandbyReplicas: DISABLED, so that is not the lever here.
  template.hasResourceProperties('AWS::OpenSearchServerless::CollectionGroup', {
    Generation: 'NEXTGEN',
  });
  template.hasResourceProperties('AWS::OpenSearchServerless::Collection', {
    Type: 'VECTORSEARCH',
  });
  const group = Object.values(template.findResources('AWS::OpenSearchServerless::CollectionGroup'))[0];
  assert.ok(group.Properties.CapacityLimits.MaxSearchCapacityInOcu <= 2, 'OCU ceiling must stay small');
});

test('the frames index is a knn index matching the embedding dimension', () => {
  const template = synth();
  const index = Object.values(template.findResources('AWS::OpenSearchServerless::Index'))[0];
  assert.equal(index.Properties.IndexName, 'frames');
  assert.equal(index.Properties.Settings.Index.Knn, true);
  const embedding = index.Properties.Mappings.Properties.embedding;
  assert.equal(embedding.Type, 'knn_vector');
  assert.equal(embedding.Dimension, 1024, 'must match Titan Multimodal output length');
  // ocr_text must be a searchable text field: exact signage matching depends on it.
  assert.equal(index.Properties.Mappings.Properties.ocr_text.Type, 'text');
});

test('indexing writes and Ask only reads', () => {
  const template = synth();
  const policy = Object.values(template.findResources('AWS::OpenSearchServerless::AccessPolicy'))[0];
  // Role ARNs are tokens, so the document renders as an Fn::Join rather than
  // a plain string: flatten the literal parts and assert on those.
  const flattened = JSON.stringify(policy.Properties.Policy);

  const writeGrants = flattened.split('aoss:WriteDocument').length - 1;
  assert.equal(writeGrants, 1, 'exactly one stanza may grant writes');
  assert.ok(
    flattened.includes('aoss:DescribeIndex\\",\\"aoss:ReadDocument\\"]'),
    'the reader stanza must be read-only',
  );
  assert.ok(flattened.includes('IndexFrames'), 'the index stage must be the writer');
  assert.ok(flattened.includes('Ask'), 'Ask must be granted read access');
});

test('the index stage runs after analysis and before ready', () => {
  const template = synth();
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
  const definition = JSON.stringify(machine.Properties.DefinitionString);
  assert.ok(definition.includes('MarkIndexing'), 'definition is missing MarkIndexing');
  assert.ok(
    definition.indexOf('Analyse') < definition.indexOf('MarkIndexing'),
    'indexing must follow analysis so descriptions are embedded',
  );
});

test('Lens query uploads are separate from media and expire', () => {
  const template = synth();
  // A query screenshot must not be able to land in the media prefix.
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>,
  );
  const lensPuts = statements.filter(
    (s) => [s.Action].flat().includes('s3:PutObject') && JSON.stringify(s.Resource).includes('lens/*'),
  );
  assert.equal(lensPuts.length, 1, 'exactly one role may write lens uploads');
  assert.ok(
    !JSON.stringify(lensPuts[0].Resource).includes('media/*'),
    'the lens upload role must not be able to write into media/',
  );

  template.hasResourceProperties('AWS::S3::Bucket', {
    LifecycleConfiguration: {
      Rules: Match.arrayWith([
        Match.objectLike({ Id: 'lens-queries', Prefix: 'lens/', ExpirationInDays: 1 }),
      ]),
    },
  });
});

test('the web search key lives in Secrets Manager, not in the template', () => {
  const template = synth();
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  const secret = Object.values(template.findResources('AWS::SecretsManager::Secret'))[0];
  // No literal value anywhere: CDK generates a placeholder and the real key is
  // put in out of band.
  assert.ok(!('SecretString' in secret.Properties), 'a key must never be in the template');

  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>,
  );
  const readers = statements.filter((s) =>
    [s.Action].flat().some((a) => String(a).startsWith('secretsmanager:GetSecretValue')),
  );
  assert.equal(readers.length, 1, 'only the web search handler may read the key');
});

test('no handler takes the search key through its environment', () => {
  const template = synth();
  for (const [name, fn] of Object.entries(template.findResources('AWS::Lambda::Function'))) {
    const env = fn.Properties.Environment?.Variables ?? {};
    for (const [key, value] of Object.entries(env)) {
      const rendered = JSON.stringify(value);
      assert.ok(
        !/BRAVE|SEARCH_API_KEY|SUBSCRIPTION_TOKEN/i.test(key),
        `${name} carries what looks like a key in ${key}`,
      );
      // The ARN is fine; the value must not be resolved into the env.
      if (key === 'SEARCH_SECRET_ARN') {
        assert.ok(rendered.includes('Ref') || rendered.includes('secret'), `${name} SEARCH_SECRET_ARN looks wrong`);
      }
    }
  }
});

test('the site bucket is private and only reachable through CloudFront', () => {
  const template = synth();
  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  const buckets = Object.values(template.findResources('AWS::S3::Bucket'));
  for (const bucket of buckets) {
    assert.deepEqual(
      bucket.Properties.PublicAccessBlockConfiguration,
      {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      'no bucket may be public, including the site bucket',
    );
  }
  // Origin Access Control, not a public bucket or a legacy OAI.
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
  const config = distribution.Properties.DistributionConfig;
  assert.equal(config.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
  assert.equal(config.DefaultRootObject, 'index.html');
});

test('sign-in and the API both accept the CloudFront origin', () => {
  const template = synth();
  const client = Object.values(template.findResources('AWS::Cognito::UserPoolClient'))[0];
  const callbacks = JSON.stringify(client.Properties.CallbackURLs);
  // The distribution domain is a token, so it renders as a Join/GetAtt.
  assert.ok(
    callbacks.includes('DomainName') || callbacks.includes('Fn::Join'),
    'the CloudFront domain must be a Hosted UI callback, or sign-in breaks on the deployed site',
  );

  const api = Object.values(template.findResources('AWS::ApiGatewayV2::Api'))[0];
  const cors = JSON.stringify(api.Properties.CorsConfiguration ?? {});
  assert.ok(
    cors.includes('DomainName') || cors.includes('Fn::Join'),
    'the API must allow the CloudFront origin, or every request from the deployed site is blocked',
  );
});
