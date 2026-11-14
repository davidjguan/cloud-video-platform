#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CloudVideoPlatformStack } from '../lib/video-platform-stack';
import { GitHubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

// Everything lives in N. Virginia. The account comes from your AWS CLI credentials.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

new CloudVideoPlatformStack(app, 'CloudVideoPlatformStack', {
  env,
  description: 'Cloud Video Platform: Cognito + API Gateway + CloudFront in front of EC2, Lambda, S3 and DynamoDB',
});

// Deployed once from your laptop. Lets GitHub Actions deploy without stored AWS keys.
new GitHubOidcStack(app, 'GitHubOidcStack', {
  env,
  githubRepo: app.node.tryGetContext('githubRepo'),
  githubSubjectPrefix: app.node.tryGetContext('githubSubjectPrefix'),
  description: 'Keyless GitHub Actions deploy role (OIDC)',
});
