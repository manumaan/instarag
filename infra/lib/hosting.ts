import { Construct } from 'constructs';
import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as deployment from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Static hosting for the web app: S3 behind CloudFront.
 *
 * The bucket stays private — CloudFront reaches it through Origin Access
 * Control, so the only way in is the distribution. The app is a static export,
 * so there is no server to run and nothing to keep warm.
 */
export class Hosting extends Construct {
  readonly distribution: cloudfront.Distribution;
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Reel Lens web app',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      // The export writes 404.html; without this a bad path returns S3's XML.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.minutes(5) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    // Only deploy if the app has been built; otherwise `cdk deploy` would
    // silently publish an empty site.
    const siteDirectory = path.join(__dirname, '..', '..', 'web', 'out');
    if (fs.existsSync(path.join(siteDirectory, 'index.html'))) {
      new deployment.BucketDeployment(this, 'DeploySite', {
        sources: [deployment.Source.asset(siteDirectory)],
        destinationBucket: this.bucket,
        distribution: this.distribution,
        // Without this a deploy serves stale HTML from the edge cache.
        distributionPaths: ['/*'],
        prune: true,
      });
    }

    new CfnOutput(this, 'SiteUrl', { value: `https://${this.distribution.distributionDomainName}` });
  }

  get origin(): string {
    return `https://${this.distribution.distributionDomainName}`;
  }
}
