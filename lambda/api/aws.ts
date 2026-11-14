/** Shared AWS clients and config (created once per Lambda container, reused across requests). */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';

export const config = {
  usersTable: process.env.USERS_TABLE!,
  videosTable: process.env.VIDEOS_TABLE!,
  commentsTable: process.env.COMMENTS_TABLE!,
  videosBucket: process.env.VIDEOS_BUCKET!,
  playUrlSeconds: Number(process.env.URL_EXPIRES_SECONDS ?? '900'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? String(100 * 1024 * 1024)),
};

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const s3 = new S3Client({});
