/**
 * One-time fix: set each video's viewCount from people's existing watch history.
 *
 * Why: view counts launched after some people had already watched videos. Those plays are in
 * each user's `watched` map but were never counted, and because a view only counts the first
 * time someone watches, replaying them now doesn't count either.
 *
 * Each user's `watched` map is exactly "the set of videos this person has viewed", so the
 * correct count for a video is simply how many users have it in their map. That makes this
 * script safe to run more than once: it always lands on the same, correct number.
 *
 * Usage (dry run first; it only prints what it would change):
 *   npx ts-node scripts/backfill-views.ts <UsersTableName> <VideosTableName>
 *   npx ts-node scripts/backfill-views.ts <UsersTableName> <VideosTableName> --apply
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/** Pure helper (unit-tested): video key -> number of distinct users who watched it. */
export function countViewers(users: { watched?: Record<string, unknown> }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const user of users) {
    for (const key of Object.keys(user.watched ?? {})) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Reads every item in a table. Scan returns at most 1 MB per call, so follow the pages. */
async function scanAll(db: DynamoDBDocumentClient, table: string, projection: string) {
  const items: Record<string, any>[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const page = await db.send(new ScanCommand({ TableName: table, ProjectionExpression: projection, ExclusiveStartKey: startKey }));
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

async function main() {
  const [usersTable, videosTable, flag] = process.argv.slice(2);
  if (!usersTable || !videosTable) {
    console.error('Usage: npx ts-node scripts/backfill-views.ts <UsersTableName> <VideosTableName> [--apply]');
    process.exit(1);
  }
  const apply = flag === '--apply';
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

  const counts = countViewers(await scanAll(db, usersTable, 'watched'));
  const videos = await scanAll(db, videosTable, 'videoKey, viewCount');

  let changed = 0;
  for (const video of videos) {
    const correct = counts.get(video.videoKey) ?? 0;
    const current = video.viewCount ?? 0;
    if (correct === current) continue;
    changed++;
    console.log(`${video.videoKey}: ${current} -> ${correct}`);
    if (apply) {
      await db.send(new UpdateCommand({
        TableName: videosTable,
        Key: { videoKey: video.videoKey },
        UpdateExpression: 'SET viewCount = :n',
        ExpressionAttributeValues: { ':n': correct },
      }));
    }
  }

  // Keys in someone's history with no Videos row are usually deleted videos. Skip them so we
  // don't create empty rows for videos that no longer exist.
  const known = new Set(videos.map((v) => v.videoKey));
  const skipped = [...counts.keys()].filter((k) => !known.has(k));
  if (skipped.length) console.log(`Skipped ${skipped.length} watched key(s) with no Videos row (probably deleted).`);

  console.log(apply ? `Updated ${changed} video(s).` : `${changed} video(s) would change. Re-run with --apply to write.`);
}

// Only run when called from the command line, not when a test imports countViewers.
if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
