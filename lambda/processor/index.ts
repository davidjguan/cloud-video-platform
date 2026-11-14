/**
 * Video processor: makes a thumbnail and reads duration/resolution for each video.
 *
 * Triggered two ways:
 *   1. EventBridge, whenever a new object lands in videos/ (every upload, automatically)
 *   2. Directly with {"action":"backfill"}, to catch up videos that existed before this
 *      feature (the admin "Generate missing thumbnails" button sends this)
 *
 * ffmpeg reads the video straight from S3 over a presigned URL, so the Lambda never
 * downloads the whole file. It only fetches the bytes it needs for one frame.
 */
import { spawn } from 'child_process';
import { readFile, rm } from 'fs/promises';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, BatchGetCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { parseProbe, pickSeekSeconds, thumbnailKeyFor, decodeS3Key, isVideoKey } from './lib';

const VIDEOS_BUCKET = process.env.VIDEOS_BUCKET!; // videos in videos/, thumbnails in thumbnails/
const VIDEOS_TABLE = process.env.VIDEOS_TABLE!;
const FFMPEG = process.env.FFMPEG_PATH ?? '/opt/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? '/opt/bin/ffprobe';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

export async function processVideo(videoKey: string, force = false) {
  // Keep a thumbnail that already exists (e.g. one an admin uploaded by hand) unless forced.
  if (!force) {
    const existing = await ddb.send(new GetCommand({ TableName: VIDEOS_TABLE, Key: { videoKey } }));
    if (existing.Item?.thumbnailKey) return { videoKey, skipped: true, reason: 'already has a thumbnail' };
  }

  // Skip if the video was deleted before we got to it.
  try {
    await s3.send(new HeadObjectCommand({ Bucket: VIDEOS_BUCKET, Key: videoKey }));
  } catch {
    console.log('Video no longer exists, skipping', videoKey);
    return { videoKey, skipped: true };
  }

  try {
    return await makeThumbnail(videoKey);
  } catch (e) {
    // Record the failure so the site shows "No preview" instead of "Processing…" forever.
    // Then re-throw, so the error shows in CloudWatch and EventBridge's retries still happen.
    const message = (e as Error).message.slice(0, 300);
    await ddb.send(new UpdateCommand({
      TableName: VIDEOS_TABLE,
      Key: { videoKey },
      UpdateExpression: 'SET #s = :failed, processError = :e, processedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':failed': 'failed', ':e': message, ':now': Math.floor(Date.now() / 1000) },
    })).catch((dbErr) => console.error('Could not record failure for', videoKey, dbErr));
    throw e;
  }
}

/** The actual work: probe the video, grab a frame, save it, record the results. */
async function makeThumbnail(videoKey: string) {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: VIDEOS_BUCKET, Key: videoKey }), { expiresIn: 900 });

  // 1. Read duration and resolution.
  const probe = parseProbe(await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url,
  ]));

  // 2. Grab one frame, scaled to 640 px wide.
  const out = `/tmp/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  const thumbnailKey = thumbnailKeyFor(videoKey);
  try {
    await run(FFMPEG, [
      '-v', 'error', '-ss', String(pickSeekSeconds(probe.durationSeconds)), '-i', url,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', out,
    ]);

    // 3. Save the thumbnail next to the videos (the API hands out presigned links to it).
    await s3.send(new PutObjectCommand({
      Bucket: VIDEOS_BUCKET,
      Key: thumbnailKey,
      Body: await readFile(out),
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=86400',
    }));
  } finally {
    await rm(out, { force: true }); // /tmp is reused between invocations, so always tidy up
  }

  // 4. Record the results (creates the row for videos that had none).
  await ddb.send(new UpdateCommand({
    TableName: VIDEOS_TABLE,
    Key: { videoKey },
    UpdateExpression: 'SET thumbnailKey = :t, durationSeconds = :d, width = :w, height = :h, #s = :ready, processedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':t': thumbnailKey, ':d': probe.durationSeconds, ':w': probe.width, ':h': probe.height,
      ':ready': 'ready', ':now': Math.floor(Date.now() / 1000),
    },
  }));

  console.log('Processed', videoKey, probe);
  return { videoKey, thumbnailKey, ...probe };
}

/** Processes every video that has no thumbnail yet (or all of them with force). */
async function backfill(force: boolean) {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: VIDEOS_BUCKET, Prefix: 'videos/', ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key && isVideoKey(o.Key)) keys.push(o.Key);
    token = page.NextContinuationToken;
  } while (token);

  let todo = keys;
  if (!force) {
    const done = new Set<string>();
    for (let i = 0; i < keys.length; i += 100) {
      const r = await ddb.send(new BatchGetCommand({
        RequestItems: { [VIDEOS_TABLE]: { Keys: keys.slice(i, i + 100).map((videoKey) => ({ videoKey })), ProjectionExpression: 'videoKey, thumbnailKey' } },
      }));
      for (const item of r.Responses?.[VIDEOS_TABLE] ?? []) if (item.thumbnailKey) done.add(item.videoKey);
    }
    todo = keys.filter((k) => !done.has(k));
  }

  const results: Array<{ videoKey: string; ok: boolean; error?: string }> = [];
  for (const key of todo) {
    try { await processVideo(key, force); results.push({ videoKey: key, ok: true }); }
    catch (e) { console.error('Failed', key, e); results.push({ videoKey: key, ok: false, error: (e as Error).message }); }
  }
  console.log(`Backfill: ${results.filter((r) => r.ok).length}/${todo.length} processed`);
  return { total: keys.length, attempted: todo.length, results };
}

interface S3ObjectCreatedEvent { 'detail-type'?: string; detail?: { object?: { key?: string } } }
interface BackfillEvent { action: 'backfill'; force?: boolean }

export async function handler(event: S3ObjectCreatedEvent | BackfillEvent) {
  if ('action' in event && event.action === 'backfill') return backfill(event.force === true);

  const rawKey = (event as S3ObjectCreatedEvent).detail?.object?.key;
  if (!rawKey) throw new Error('Unrecognized event: ' + JSON.stringify(event).slice(0, 300));
  const key = decodeS3Key(rawKey);
  if (!isVideoKey(key)) return { skipped: true, key };
  return processVideo(key);
}
