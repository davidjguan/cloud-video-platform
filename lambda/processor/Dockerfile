# Video processor Lambda: Node.js 22 + static ffmpeg/ffprobe.
# Built by `cdk deploy` (GitHub Actions has Docker) and stored in Amazon ECR.
# dist/index.js is bundled from index.ts by the CDK app before the image is built.

# Prebuilt static ffmpeg binaries (no package manager needed)
FROM --platform=linux/amd64 mwader/static-ffmpeg:7.1 AS ffmpeg

FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:22
COPY --from=ffmpeg /ffmpeg /ffprobe /opt/bin/
COPY dist/index.js ${LAMBDA_TASK_ROOT}/
CMD ["index.handler"]
