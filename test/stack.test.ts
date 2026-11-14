import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CloudVideoPlatformStack } from '../lib/video-platform-stack';
import { GitHubOidcStack } from '../lib/github-oidc-stack';

const env = { account: '123456789012', region: 'us-east-1' };

describe('CloudVideoPlatformStack', () => {
  const app = new cdk.App({ context: { cloudfrontPrefixListId: 'pl-3b927c52' } });
  const template = Template.fromStack(new CloudVideoPlatformStack(app, 'TestStack', { env }));

  it('keeps every bucket private', () => {
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  });

  it('creates a Cognito user pool with email sign-in and self sign-up', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
    });
  });

  it('protects every API route with the Cognito JWT authorizer', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes)).toHaveLength(11);
    for (const r of Object.values(routes)) {
      expect(r.Properties.AuthorizationType).toBe('JWT');
    }
  });

  it('has an admins group and tables for users, videos and comments', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admins' });
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'videoKey', KeyType: 'HASH' },
        { AttributeName: 'commentId', KeyType: 'RANGE' },
      ],
    });
  });

  it('lets browsers upload to the videos bucket only from the CloudFront site', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ['POST'] })] },
    });
  });

  it('runs the processor as a container image, triggered by new videos via EventBridge', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { PackageType: 'Image', MemorySize: 2048 });
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
        detail: Match.objectLike({ object: { key: [{ prefix: 'videos/' }] } }),
      }),
    });
  });

  it('serves the site and /api/* through one HTTPS CloudFront distribution', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        CacheBehaviors: Match.arrayWith([Match.objectLike({ PathPattern: '/api/*' })]),
      }),
    });
  });

  it('only lets CloudFront reach the web server, with no SSH', () => {
    // Prefix-list rules are emitted as a separate ingress resource.
    const ingress = template.findResources('AWS::EC2::SecurityGroupIngress');
    expect(Object.values(ingress).map((r) => r.Properties)).toEqual([
      expect.objectContaining({ FromPort: 80, ToPort: 80, IpProtocol: 'tcp', SourcePrefixListId: 'pl-3b927c52' }),
    ]);
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  it('runs a free-tier t3.micro with an Elastic IP', () => {
    template.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't3.micro' });
    template.resourceCountIs('AWS::EC2::EIP', 1);
  });
});

describe('GitHubOidcStack', () => {
  it('only trusts the main branch of the configured repo', () => {
    const app = new cdk.App();
    const template = Template.fromStack(new GitHubOidcStack(app, 'Oidc', { env, githubRepo: 'dave/cloud-video-platform' }));
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({
          Condition: Match.objectLike({
            StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:dave/cloud-video-platform:ref:refs/heads/main' },
          }),
        })],
      }),
    });
  });

  it('refuses a missing repo name', () => {
    expect(() => new GitHubOidcStack(new cdk.App(), 'Bad', { env, githubRepo: '' })).toThrow();
  });
});
