/**
 * Videos: catalog, playback, uploads, likes and deletes.
 *
 * S3 (videos/ folder) is the source of truth for which videos exist. The Videos table holds
 * optional extra info per video: title, who uploaded it, and the like count.
 */
import {
  ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  BatchGetCommand, PutCommand, GetCommand, DeleteCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb, s3, config } from './aws';
import { HttpError, titleFromKey, slugify, requireText, chunk, thumbnailStatus } from './lib';
import type { UserRecord } from './users';
import { deleteAllComments } from './comments';
import type { Caller } from './handler';

interface VideoMeta {
  videoKey: string;
  title?: string;
  description?: string;
  keywords?: string[];
  uploaderId?: string;
  uploaderName?: string;
  source?: string;        // where the clip came from, e.g. "Pixabay"
  sourceUrl?: string;
  credit?: string;
  durationSeconds?: number;
  thumbnailKey?: string;  // image in the videos bucket, under thumbnails/
  status?: string;        // 'processing' | 'ready' | 'failed' (set by upload + processor)
  createdAt?: number;
  likeCount?: number;
  viewCount?: number;     // unique viewers: each person counts once per video
}

const THUMBNAIL_URL_SECONDS = 3600;

async function getMeta(key: string): Promise<VideoMeta | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: config.videosTable, Key: { videoKey: key } }));
  return r.Item as VideoMeta | undefined;
}

export async function requireVideoExists(key: string): Promise<void> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.videosBucket, Key: key }));
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'NotFound' || name === 'NoSuchKey') throw new HttpError(404, 'Video not found');
    throw err;
  }
}

function canDelete(caller: Caller, meta?: VideoMeta): boolean {
  return caller.isAdmin || (!!meta?.uploaderId && meta.uploaderId === caller.userId);
}

export async function listVideos(caller: Caller) {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: config.videosBucket, Prefix: 'videos/' }));
  const objects = (listed.Contents ?? []).filter((o) => o.Key?.toLowerCase().endsWith('.mp4'));

  // Look up extra info for all of them, 100 keys per BatchGet call.
  const meta = new Map<string, VideoMeta>();
  for (const keys of chunk(objects.map((o) => o.Key!), 100)) {
    const r = await ddb.send(new BatchGetCommand({
      RequestItems: { [config.videosTable]: { Keys: keys.map((videoKey) => ({ videoKey })) } },
    }));
    for (const item of r.Responses?.[config.videosTable] ?? []) meta.set(item.videoKey, item as VideoMeta);
  }

  const videos = await Promise.all(objects.map(async (o) => {
    const m = meta.get(o.Key!);
    // Presigning is a local signature calculation (no network call), so this is fast.
    const thumbnailUrl = m?.thumbnailKey
      ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: config.videosBucket, Key: m.thumbnailKey }),
        { expiresIn: THUMBNAIL_URL_SECONDS })
      : null;
    return {
      key: o.Key!,
      title: m?.title ?? titleFromKey(o.Key!),
      description: m?.description ?? '',
      keywords: m?.keywords ?? [],
      sizeMB: Math.round((o.Size ?? 0) / 100_000) / 10,
      durationSeconds: m?.durationSeconds ?? null,
      uploadedAt: m?.createdAt ?? Math.floor((o.LastModified?.getTime() ?? 0) / 1000),
      uploader: m?.uploaderName ?? null,
      credit: m?.credit ?? null,
      sourceUrl: m?.sourceUrl ?? null,
      thumbnailUrl,
      thumbnailStatus: thumbnailStatus(m),
      likeCount: Math.max(0, m?.likeCount ?? 0),
      viewCount: Math.max(0, m?.viewCount ?? 0),
      canDelete: canDelete(caller, m),
    };
  }));
  videos.sort((a, b) => b.uploadedAt - a.uploadedAt); // newest first
  return { videos };
}

export async function play(user: UserRecord, key: string) {
  await requireVideoExists(key);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.videosBucket, Key: key }),
    { expiresIn: config.playUrlSeconds },
  );
  const newView = await recordView(user.userId, key);
  return { url, expiresIn: config.playUrlSeconds, resumeAt: user.progress?.[key] ?? 0, newView };
}

/**
 * Counts a view the first time each person plays a video (replays don't count again).
 *
 * One DynamoDB transaction does both writes, so they can't get out of sync:
 *   1. Users table: record when this person first watched the video, only if they never had
 *   2. Videos table: add 1 to viewCount
 * If the person already watched it, the condition in step 1 fails, DynamoDB cancels the whole
 * transaction, and nothing changes. Returns true when a new view was counted.
 */
async function recordView(userId: string, key: string): Promise<boolean> {
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: config.usersTable,
            Key: { userId },
            UpdateExpression: 'SET watched.#k = :t',
            ConditionExpression: 'attribute_not_exists(watched.#k)',
            ExpressionAttributeNames: { '#k': key },
            ExpressionAttributeValues: { ':t': Math.floor(Date.now() / 1000) },
          },
        },
        {
          Update: {
            TableName: config.videosTable,
            Key: { videoKey: key },
            UpdateExpression: 'ADD viewCount :one', // ADD is atomic, so simultaneous plays all count
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
      ],
    }));
    return true;
  } catch (err) {
    // Cancelled = this person already watched the video. Not an error, just not a new view.
    if ((err as Error).name !== 'TransactionCanceledException') throw err;
    return false;
  }
}

/**
 * Step 1 of an upload: returns a presigned POST form the browser uses to send the file
 * straight to S3. S3 itself enforces the size limit and content type, and the upload
 * never passes through Lambda or API Gateway (which have small payload limits).
 */
export async function createUpload(caller: Caller, body: Record<string, unknown>) {
  const title = requireText(body.title, 'title', 80);
  const size = Number(body.sizeBytes);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'sizeBytes is required');
  if (size > config.maxUploadBytes) {
    throw new HttpError(400, `Videos must be ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB or smaller`);
  }
  if (body.contentType !== 'video/mp4') throw new HttpError(400, 'Only .mp4 videos are supported');

  const key = `videos/${slugify(title)}-${Date.now().toString(36)}.mp4`;
  const post = await createPresignedPost(s3, {
    Bucket: config.videosBucket,
    Key: key,
    Fields: { 'Content-Type': 'video/mp4' },
    Conditions: [
      ['content-length-range', 1, config.maxUploadBytes],
      ['eq', '$Content-Type', 'video/mp4'],
    ],
    Expires: 600, // the form is valid for 10 minutes
  });

  const meta: VideoMeta = {
    videoKey: key,
    title,
    uploaderId: caller.userId,
    uploaderName: caller.name,
    createdAt: Math.floor(Date.now() / 1000),
    likeCount: 0,
    status: 'processing', // the processor flips this to 'ready' or 'failed'
  };
  await ddb.send(new PutCommand({ TableName: config.videosTable, Item: meta }));

  return { key, upload: { url: post.url, fields: post.fields } };
}

/** Uploader or admin only. Removes the file, its info and its comments. */
export async function deleteVideo(caller: Caller, key: string) {
  const meta = await getMeta(key);
  if (!canDelete(caller, meta)) throw new HttpError(403, 'Only the uploader or an admin can delete this video');

  await s3.send(new DeleteObjectCommand({ Bucket: config.videosBucket, Key: key }));
  if (meta?.thumbnailKey) {
    await s3.send(new DeleteObjectCommand({ Bucket: config.videosBucket, Key: meta.thumbnailKey }));
  }
  await ddb.send(new DeleteCommand({ TableName: config.videosTable, Key: { videoKey: key } }));
  const removedComments = await deleteAllComments(key);
  return { deleted: true, key, removedComments };
}

/**
 * Like / unlike. One transaction updates both the user's likes and the video's counter,
 * so the count can't drift, and the condition makes double-likes a no-op.
 */
export async function setLike(user: UserRecord, key: string, like: boolean) {
  await requireVideoExists(key);
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: config.usersTable,
            Key: { userId: user.userId },
            UpdateExpression: like ? 'SET likes.#k = :t' : 'REMOVE likes.#k',
            ConditionExpression: like ? 'attribute_not_exists(likes.#k)' : 'attribute_exists(likes.#k)',
            ExpressionAttributeNames: { '#k': key },
            ExpressionAttributeValues: like ? { ':t': Math.floor(Date.now() / 1000) } : undefined,
          },
        },
        {
          Update: {
            TableName: config.videosTable,
            Key: { videoKey: key },
            UpdateExpression: 'ADD likeCount :d',
            ExpressionAttributeValues: { ':d': like ? 1 : -1 },
          },
        },
      ],
    }));
  } catch (err) {
    // Condition failed = already liked (or already not liked). Nothing to change.
    if ((err as Error).name !== 'TransactionCanceledException') throw err;
  }
  const meta = await getMeta(key);
  return { key, liked: like, likeCount: Math.max(0, meta?.likeCount ?? 0) };
}
