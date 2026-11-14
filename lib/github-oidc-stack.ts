import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface GitHubOidcStackProps extends cdk.StackProps {
  /** "owner/repo", e.g. "dguan/cloud-video-platform" (set in cdk.json → context.githubRepo) */
  githubRepo: string;
  /**
   * Optional: how GitHub names your repo inside its sign-in token (cdk.json → context.githubSubjectPrefix).
   * Newer repos use "immutable subjects" with permanent numeric IDs, e.g.
   * "repo:dguan@123/cloud-video-platform@456", so a renamed or re-created repo can't impersonate yours.
   * Find yours with: gh api repos/OWNER/REPO/actions/oidc/customization/sub (the sub_claim_prefix field).
   * Leave unset for the classic format "repo:owner/repo".
   */
  githubSubjectPrefix?: string;
}

/**
 * Lets GitHub Actions deploy to AWS with short-lived credentials instead of stored access keys.
 *
 * GitHub signs a token saying "this job is running in repo X on branch main". AWS trusts
 * GitHub's signature (the OIDC provider below) and lets that job, and only that job,
 * assume the deploy role for up to an hour.
 */
export class GitHubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, props);

    if (!props.githubRepo || !/^[\w.-]+\/[\w.-]+$/.test(props.githubRepo)) {
      throw new Error('Set context.githubRepo in cdk.json to "your-github-username/your-repo"');
    }

    // Must match the "sub" claim GitHub puts in the token exactly, or AWS refuses the sign-in.
    const subjectPrefix = props.githubSubjectPrefix || `repo:${props.githubRepo}`;

    const provider = new iam.OpenIdConnectProvider(this, 'GitHubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const deployRole = new iam.Role(this, 'GitHubDeployRole', {
      roleName: 'cloud-video-platform-github-deploy',
      description: `Assumed by GitHub Actions in ${props.githubRepo} (main branch only)`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': `${subjectPrefix}:ref:refs/heads/main` },
      }),
    });

    // The role can only hand off to the CDK bootstrap roles (created by `cdk bootstrap`),
    // which CloudFormation uses to do the actual deploy.
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
    }));

    new cdk.CfnOutput(this, 'GitHubDeployRoleArn', {
      value: deployRole.roleArn,
      description: 'Put this in GitHub → Settings → Secrets and variables → Actions → Variables as AWS_DEPLOY_ROLE_ARN',
    });
  }
}
