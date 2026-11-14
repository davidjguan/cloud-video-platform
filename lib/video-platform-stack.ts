import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwAuthorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { buildSync } from 'esbuild';

/**
 * Request flow:
 *
 *   Browser ──HTTPS──► CloudFront ─┬─ /*      ──► EC2 (Nginx serves the site)
 *      │                           └─ /api/*  ──► API Gateway ──(JWT check)──► Lambda ──► DynamoDB / S3
 *      └── sign up / sign in ──► Cognito (issues the JWT the API checks)
 *
 * Videos are played from the private S3 bucket through presigned URLs made by the Lambda.
 *
 * Processing pipeline (runs in the background after every upload):
 *
 *   S3 (videos/) ──"Object Created"──► EventBridge rule ──► Processor Lambda (container image in ECR, ffmpeg)
 *                                                               ├─► thumbnail JPEG ──► S3 (thumbnails/)
 *                                                               └─► duration + size ──► DynamoDB Videos table
 */
export class CloudVideoPlatformStack extends cdk.Stack {
  // Fixed AZ list so `cdk synth` (and the tests) don't need to call AWS to look them up.
  get availabilityZones(): string[] {
    return ['us-east-1a', 'us-east-1b'];
  }

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- Storage
    // Private bucket for the videos (videos/ folder). Users upload here with presigned POST forms.
    const videosBucket = new s3.Bucket(this, 'VideosBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // keep your uploaded videos even if the stack is deleted
      eventBridgeEnabled: true, // send "Object Created" events to EventBridge (starts the processor)
    });

    // Private bucket holding the website files. EC2 pulls from here every minute.
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // One item per user, keyed on the Cognito user ID ("sub").
    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Extra info per video: title, uploader and like count.
    const videosTable = new dynamodb.Table(this, 'VideosTable', {
      partitionKey: { name: 'videoKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Comments: all comments for a video share a partition; the sort key starts with a timestamp.
    const commentsTable = new dynamodb.Table(this, 'CommentsTable', {
      partitionKey: { name: 'videoKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'commentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------- Cognito auth
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },          // users sign in with their email
      autoVerify: { email: true },             // Cognito emails a 6-digit code on sign-up
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The "app client" the website uses. No secret, because browser code can't keep one.
    const userPoolClient = userPool.addClient('WebClient', {
      generateSecret: false,
      authFlows: { userPassword: true },
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(7),
      preventUserExistenceErrors: true,
    });

    // Members of this group can delete any video or comment. Its name shows up in the
    // user's ID token ("cognito:groups"), which the Lambda checks.
    new cognito.CfnUserPoolGroup(this, 'AdminsGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'admins',
      description: 'Moderators: can delete any video or comment',
    });

    // ------------------------------------------------------------------ Lambda
    const apiFunction = new nodejs.NodejsFunction(this, 'ApiFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'api', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        USERS_TABLE: usersTable.tableName,
        VIDEOS_TABLE: videosTable.tableName,
        COMMENTS_TABLE: commentsTable.tableName,
        VIDEOS_BUCKET: videosBucket.bucketName,
        URL_EXPIRES_SECONDS: '900',
        MAX_UPLOAD_BYTES: String(100 * 1024 * 1024),
      },
      bundling: { minify: true, externalModules: [] }, // bundle the AWS SDK so the presigner is included
      logGroup: new logs.LogGroup(this, 'ApiFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Least privilege: only these three tables, and only the videos/ folder of the bucket.
    for (const table of [usersTable, videosTable, commentsTable]) table.grantReadWriteData(apiFunction);
    videosBucket.grantRead(apiFunction, 'videos/*');   // play + check a video exists
    videosBucket.grantPut(apiFunction, 'videos/*');    // sign upload forms
    videosBucket.grantDelete(apiFunction, 'videos/*'); // delete videos
    videosBucket.grantRead(apiFunction, 'thumbnails/*');   // show thumbnails
    videosBucket.grantDelete(apiFunction, 'thumbnails/*'); // remove a deleted video's thumbnail
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],                      // list the catalog
      resources: [videosBucket.bucketArn],
    }));

    // ------------------------------------------ Video processor (EventBridge + ECR)
    // Bundle the processor's TypeScript into one file; the Dockerfile copies it into the image.
    const processorDir = path.join(__dirname, '..', 'lambda', 'processor');
    buildSync({
      entryPoints: [path.join(processorDir, 'index.ts')],
      outfile: path.join(processorDir, 'dist', 'index.js'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      minify: true,
      logLevel: 'warning',
    });

    // A container image (built by `cdk deploy`, stored in ECR) because ffmpeg is too big
    // and too awkward to ship in a normal Lambda zip.
    const processorFunction = new lambda.DockerImageFunction(this, 'ProcessorFunction', {
      description: 'Makes thumbnails and reads duration for uploaded videos (ffmpeg)',
      code: lambda.DockerImageCode.fromImageAsset(processorDir),
      architecture: lambda.Architecture.X86_64,
      memorySize: 2048,                     // more memory = more CPU for ffmpeg
      timeout: cdk.Duration.minutes(15),    // a backfill processes many videos in one run
      environment: {
        VIDEOS_BUCKET: videosBucket.bucketName,
        VIDEOS_TABLE: videosTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'ProcessorFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    videosBucket.grantRead(processorFunction, 'videos/*');     // read videos (ffmpeg streams them)
    videosBucket.grantPut(processorFunction, 'thumbnails/*');  // write thumbnails only
    processorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],                               // backfill lists the videos
      resources: [videosBucket.bucketArn],
    }));
    videosTable.grantReadWriteData(processorFunction);

    // Every new .mp4 in videos/ triggers the processor.
    new events.Rule(this, 'VideoUploadedRule', {
      description: 'New video in S3 -> make thumbnail',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [videosBucket.bucketName] },
          object: { key: [{ prefix: 'videos/' }] },
        },
      },
      targets: [new targets.LambdaFunction(processorFunction, { retryAttempts: 2 })],
    });

    // The API can start a backfill (admin-only button on the site).
    apiFunction.addEnvironment('PROCESSOR_FUNCTION', processorFunction.functionName);
    processorFunction.grantInvoke(apiFunction);

    // ------------------------------------------------- API Gateway (HTTP API)
    // Every route requires a valid Cognito ID token; API Gateway rejects anything else
    // with 401 before the Lambda ever runs.
    const authorizer = new apigwAuthorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );

    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      description: 'Cloud Video Platform API (served through CloudFront at /api)',
      defaultAuthorizer: authorizer,
    });

    const integration = new apigwIntegrations.HttpLambdaIntegration('ApiIntegration', apiFunction);
    const routes: Array<[string, apigw.HttpMethod]> = [
      ['/api/me', apigw.HttpMethod.GET],
      ['/api/videos', apigw.HttpMethod.GET],
      ['/api/play', apigw.HttpMethod.POST],
      ['/api/progress', apigw.HttpMethod.PUT],
      ['/api/uploads', apigw.HttpMethod.POST],
      ['/api/videos', apigw.HttpMethod.DELETE],
      ['/api/likes', apigw.HttpMethod.POST],
      ['/api/comments', apigw.HttpMethod.GET],
      ['/api/comments', apigw.HttpMethod.POST],
      ['/api/comments', apigw.HttpMethod.DELETE],
      ['/api/admin/thumbnails', apigw.HttpMethod.POST],
    ];
    for (const [routePath, method] of routes) {
      httpApi.addRoutes({ path: routePath, methods: [method], integration });
    }

    // Basic rate limiting so a public demo can't run up a bill.
    const defaultStage = httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    defaultStage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    // --------------------------------------------------------------------- EC2
    // Small VPC with public subnets only (no NAT gateway, so no hourly NAT cost).
    // We pin the AZs on purpose (see availabilityZones above) so synth needs no AWS calls.
    cdk.Annotations.of(this).acknowledgeWarning('CloudFormation-Validate::W3010', 'AZs pinned so synth needs no AWS lookup');
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });

    // Only CloudFront may reach port 80; nobody can hit the server directly. No SSH port at all:
    // you connect with Session Manager instead.
    const webSg = new ec2.SecurityGroup(this, 'WebServerSg', {
      vpc,
      description: 'HTTP from CloudFront only',
      allowAllOutbound: true,
    });
    webSg.addIngressRule(
      ec2.Peer.prefixList(this.node.tryGetContext('cloudfrontPrefixListId')),
      ec2.Port.tcp(80),
      'CloudFront origin-facing servers',
    );

    const webRole = new iam.Role(this, 'WebServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    siteBucket.grantRead(webRole);

    // Startup script. Order matters: install Nginx first, then copy the site, so the
    // Nginx package can't overwrite our index.html.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y nginx',
      'cat > /usr/local/bin/sync-site <<EOF',
      '#!/bin/bash',
      `aws s3 sync s3://${siteBucket.bucketName}/ /usr/share/nginx/html/ --delete --exact-timestamps --quiet`,
      'EOF',
      'chmod +x /usr/local/bin/sync-site',
      // systemd timer: re-sync the site from S3 every minute, so a git push shows up on its own.
      'cat > /etc/systemd/system/sync-site.service <<EOF',
      '[Unit]',
      'Description=Sync website from S3',
      '[Service]',
      'Type=oneshot',
      'ExecStart=/usr/local/bin/sync-site',
      'EOF',
      'cat > /etc/systemd/system/sync-site.timer <<EOF',
      '[Unit]',
      'Description=Sync website from S3 every minute',
      '[Timer]',
      'OnBootSec=30s',
      'OnUnitActiveSec=60s',
      '[Install]',
      'WantedBy=timers.target',
      'EOF',
      '/usr/local/bin/sync-site || true',
      'systemctl daemon-reload',
      'systemctl enable --now nginx sync-site.timer',
    );

    const webServer = new ec2.Instance(this, 'WebServer', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: webSg,
      role: webRole,
      userData,
      userDataCausesReplacement: true,
      requireImdsv2: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(8, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
      }],
    });

    // Elastic IP so the server's address (and therefore CloudFront's origin) never changes,
    // even after a stop/start.
    const eip = new ec2.CfnEIP(this, 'WebServerEip', { instanceId: webServer.instanceId });
    const eipDashed = cdk.Fn.join('-', cdk.Fn.split('.', eip.attrPublicIp));
    const webServerDns = cdk.Fn.join('', ['ec2-', eipDashed, '.compute-1.amazonaws.com']);

    // ------------------------------------------------------ CloudFront CDN
    // One HTTPS domain for both the site and the API, so the browser never makes
    // cross-origin calls (no CORS setup needed).
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Cloud Video Platform',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: new origins.HttpOrigin(webServerDns, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // pushes show up right away
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiDomain),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forwards the Authorization header (the JWT) to API Gateway.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    distribution.node.addDependency(eip);

    // Browsers upload straight to S3 from our CloudFront domain, so S3 must allow that origin.
    videosBucket.addCorsRule({
      allowedOrigins: [`https://${distribution.distributionDomainName}`],
      allowedMethods: [s3.HttpMethods.POST],
      allowedHeaders: ['*'],
      maxAge: 3000,
    });

    // -------------------------------------------------- Deploy the website files
    // Copies site/ to the site bucket and writes config.json with this deployment's IDs.
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: siteBucket,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', 'site')),
        s3deploy.Source.jsonData('config.json', {
          region: this.region,
          userPoolClientId: userPoolClient.userPoolClientId,
          apiBase: '/api',
        }),
      ],
      prune: true,
    });

    // ----------------------------------------------------------------- Outputs
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'VideosBucketName', { value: videosBucket.bucketName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'UsersTableName', { value: usersTable.tableName });
    new cdk.CfnOutput(this, 'VideosTableName', { value: videosTable.tableName });
    new cdk.CfnOutput(this, 'AddAdminCommand', {
      value: `aws cognito-idp admin-add-user-to-group --user-pool-id ${userPool.userPoolId} --group-name admins --username YOUR_EMAIL`,
      description: 'Run this (with your email) to make yourself an admin, then sign out and back in',
    });
    new cdk.CfnOutput(this, 'WebServerInstanceId', { value: webServer.instanceId });
  }
}
