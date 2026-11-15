# Cloud Video Platform

[![Test and deploy](https://github.com/davidjguan/cloud-video-platform/actions/workflows/deploy.yml/badge.svg)](https://github.com/davidjguan/cloud-video-platform/actions/workflows/deploy.yml)

A video-sharing platform with real accounts, uploads, view counts, likes and comments, built on AWS and deployed entirely from code.

![Home page: rows for Continue watching, Recently added and Most viewed, with automatic thumbnails, view counts and watch progress](docs/home.jpg)

Everything (servers, database, auth, the event-driven video processor) is defined as infrastructure as code and deployed by CI/CD on every push.

**Stack:** Amazon Cognito · API Gateway (HTTP API) · CloudFront · EC2 (Nginx) · Lambda (TypeScript) · S3 · DynamoDB · EventBridge · ECR (container image with ffmpeg) · AWS CDK · GitHub Actions

## Features

- **Accounts:** sign up with email verification, sign in, stay signed in (Cognito).
- **Streaming:** videos are stored in a private S3 bucket and played through 15-minute presigned URLs.
- **Uploads:** any signed-in user can upload an .mp4 (up to 100 MB) from the Upload button: drag and drop, a preview before sending, a suggested title, and live progress. The browser sends the file straight to S3.
- **View counts:** each person counts once per video, so replays and refreshes can't inflate the number.
- **Likes and comments** on every video. The author's identity comes from the verified login token, so it can't be faked.
- **Moderation:** members of the Cognito `admins` group can delete any video or comment. Everyone else can only delete their own.
- **Automatic thumbnails:** every upload is processed in the background. A container Lambda running ffmpeg grabs a frame and reads the duration. New uploads show "Processing…" until it finishes; if ffmpeg can't read a video it is marked `failed` and shows "No preview" instead of spinning forever. Admins can backfill thumbnails for older videos (and retry failed ones) with one click.
- **Continue Watching:** playback position is saved every few seconds and shown as a progress bar on the thumbnail; finished videos drop off the list.
- **Browsing:** a thumbnail grid plus rows for Continue watching, Recently added, Most viewed and Your liked videos. Each video has its own watch page (`#/watch/<video>`) with comments and an "Up next" list, so links and the Back button work.
- **Your data:** an Account window shows your activity and lets you download your stored record as JSON.

![Watch page: video player, view and like counts, comments, and an Up next list](docs/watch.jpg)
*The watch page: views count each person once, likes and comments are tied to the signed-in account, and "Up next" lists unwatched videos first.*

![A new upload shows "Processing…", then about 10 seconds later has a thumbnail and its 0:22 length](docs/thumbnail-before-after.png)
*Automatic thumbnails: the upload lands in S3, EventBridge triggers the ffmpeg processor, and the card updates on its own.*

## Architecture

![Architecture: browser to CloudFront, EC2 and API Gateway/Lambda, with DynamoDB, S3 and an EventBridge-triggered ffmpeg processor](docs/architecture.svg)

| Service | Role |
|---|---|
| **Cognito** | User accounts: sign-up, email verification, sign-in, and the `admins` group |
| **API Gateway** | The only way into the Lambda. Rejects any request without a valid Cognito token. |
| **CloudFront** | One HTTPS domain for the site and the API. Only CloudFront can reach the EC2 server. |
| EC2 | Nginx serves the static site, synced from S3 every minute |
| Lambda | Business logic: catalog, playback, view counts, uploads, likes, comments |
| S3 | Private storage for videos and the website files |
| DynamoDB | Users (history, progress, likes), video info, comments |
| **EventBridge** | Routes S3 "Object Created" events for new videos to the processor |
| **ECR** | Stores the processor's container image (Node.js + ffmpeg) |

### Design decisions

- **Identity comes from the token, not the request.** The Lambda reads the user ID and admin group from claims API Gateway has already verified. A user can't impersonate someone by editing a request.
- **Uploads skip the API.** The API returns a presigned S3 POST form, so large files never pass through Lambda or API Gateway, which have small payload limits. S3 itself enforces the 100 MB limit and the content type.
- **The site and API share one domain.** CloudFront routes `/api/*` to API Gateway, so the browser makes no cross-origin calls and CORS isn't needed.
- **Like and view counts can't drift.** One DynamoDB transaction updates the user's record and the video's counter together, with a condition that makes a repeat like (or a replay) a no-op. Views are unique viewers, not raw plays.
- **Locked-down server.** The EC2 security group only allows CloudFront's IP ranges on port 80, there's no SSH port, and admin access goes through SSM Session Manager.
- **No stored AWS keys.** GitHub Actions signs in to AWS with OIDC: short-lived credentials, limited to this repo's `main` branch.
- **Least privilege.** Each role can only reach the specific tables and bucket folders it needs.
- **Heavy work happens off the request path.** Uploads return immediately; thumbnails are made asynchronously by an event-driven processor, with automatic retries.
- **ffmpeg reads only what it needs.** The processor streams the video from S3 through a presigned URL, so making a thumbnail doesn't download the whole file.
- **No front-end framework or build step.** The site is plain HTML, CSS and JavaScript served as-is, with hash-based routing (`#/watch/...`) and the browser's built-in `<dialog>` for pop-up windows. Asset URLs carry a version (`app.js?v=3`) so a release isn't hidden by a cached copy.
- **A container image for the processor.** ffmpeg is too large and awkward for a zipped Lambda, so the processor ships as a Docker image built by CDK and stored in ECR.

## Project layout

```
bin/app.ts                    CDK app entry point
lib/video-platform-stack.ts   All application infrastructure
lib/github-oidc-stack.ts      Keyless deploy role for GitHub Actions
lambda/api/                   Lambda: router (handler.ts) + users, videos, comments, admin
lambda/processor/             Container Lambda (Dockerfile + ffmpeg): thumbnails and duration
site/                         Front end (plain HTML/CSS/JS)
test/                         Jest: helpers, handler authorization, infrastructure assertions
.github/workflows/            Test on every push, deploy on main
```

## Testing

```bash
npm run build   # TypeScript type-check
npm test        # 52 Jest tests, a few seconds, no AWS account needed
```

- **Pure helpers** (input validation, parsing, ffmpeg output) have unit tests.
- **API authorization** is tested against a mocked AWS SDK (`aws-sdk-client-mock`). For example, a non-admin can't delete someone else's video or comment, and a repeat like doesn't double-count.
- **Infrastructure** is tested by synthesizing the CDK stack and asserting on the CloudFormation template: no SSH port on the server, a JWT authorizer on every route, CORS limited to browser uploads, and the EventBridge rule wired to the processor.

## Trade-offs and next steps

- **EC2 serves the site.** Serving it straight from S3 behind CloudFront would be simpler and cheaper. EC2 is kept to show a locked-down server (CloudFront-only security group, no SSH, Session Manager access).
- **The catalog loads in one request.** The API lists the bucket (one page, up to 1,000 videos) and batch-reads their metadata. That's fine at this scale (dozens of videos). Beyond it, the next steps are pagination and a search index.
- **No adaptive streaming.** Videos play as single MP4 files. HLS transcoding (multiple bitrates) would be the next step for slow connections.
- **Not yet measured:** load testing and monitoring (CloudWatch dashboards and alarms) are planned.

## Setup (first time)

You need **Node.js 20+**, **git** and the **AWS CLI**.

1. **Install the AWS CLI and sign in.** Install from https://aws.amazon.com/cli/. Then sign in with `aws configure` using an access key for an IAM user with admin rights (or use `aws configure sso`). Check it works:
   ```bash
   aws sts get-caller-identity
   ```
2. **Install dependencies and run the tests.**
   ```bash
   npm ci
   npm test
   ```
3. **Set your GitHub repo** in `cdk.json` → `context.githubRepo`, e.g. `"dguan/cloud-video-platform"`.
   If your repo uses GitHub's *immutable subject* sign-in tokens (newer repos do), also set `context.githubSubjectPrefix` to the `sub_claim_prefix` from `gh api repos/OWNER/REPO/actions/oidc/customization/sub`. Otherwise AWS rejects the deploy with "Not authorized to perform sts:AssumeRoleWithWebIdentity".
4. **Bootstrap CDK** (once per account/region):
   ```bash
   npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1
   ```
5. **Deploy both stacks:**
   ```bash
   npx cdk deploy --all
   ```
   This takes about 10 minutes; CloudFront is the slow part. Note the outputs: `SiteUrl`, `GitHubDeployRoleArn` and `AddAdminCommand`.
6. **Open `SiteUrl`**, sign up and confirm your email. Wait about a minute after the first deploy for the server to finish setting up.
7. **Make yourself an admin:** run the `AddAdminCommand` output with your email, then sign out and back in.
8. **Add videos:** upload through the site, or in bulk:
   ```bash
   aws s3 cp ./my-videos/ s3://<VideosBucketName>/videos/ --recursive --exclude "*" --include "*.mp4"
   ```

## Continuous deployment

1. In GitHub, go to the repo → **Settings → Secrets and variables → Actions → Secrets**. Add `AWS_DEPLOY_ROLE_ARN` = the `GitHubDeployRoleArn` output. It's a secret rather than a variable so GitHub masks it in the (public) logs.
2. Every push to `main` type-checks, runs the tests and deploys `CloudVideoPlatformStack`. Pull requests only run the tests. The deploy step keeps CDK's full output (which lists the site URL and resource names) out of the log and only prints errors if it fails.

The processor is a Docker image, so `cdk deploy` needs Docker. GitHub Actions has it built in. To deploy from your own laptop instead, install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and keep it running while you deploy.

## Cost

Built to stay within the AWS free tier at demo scale. The things that can cost money:
- **EC2 t3.micro:** free-tier eligible.
- **Public IPv4 / Elastic IP:** about $3.60/month, charged whether the instance runs or not, unless covered by free-tier credits.
- **S3 storage** for videos: cents.

Cognito, API Gateway, CloudFront, Lambda and DynamoDB are free at this usage. To remove everything:
```bash
npx cdk destroy --all
```
The videos bucket is kept on purpose, so delete it in the S3 console if you want it gone.
