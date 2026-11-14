/** The signed-in user's record: watch history, playback progress and likes. */
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, config } from './aws';
import type { Caller } from './handler';

export interface UserRecord {
  userId: string;
  email: string;
  createdAt: number;
  watched: Record<string, number>;   // video key -> unix time first watched
  progress: Record<string, number>;  // video key -> seconds in (removed once finished)
  likes: Record<string, number>;     // video key -> unix time liked
}

export async function getOrCreateUser(caller: Caller): Promise<{ user: UserRecord; isNew: boolean }> {
  const existing = await ddb.send(new GetCommand({ TableName: config.usersTable, Key: { userId: caller.userId } }));
  if (existing.Item) return { user: existing.Item as UserRecord, isNew: false };

  const user: UserRecord = {
    userId: caller.userId,
    email: caller.email,
    createdAt: Math.floor(Date.now() / 1000),
    watched: {},
    progress: {},
    likes: {},
  };
  try {
    await ddb.send(new PutCommand({
      TableName: config.usersTable,
      Item: user,
      ConditionExpression: 'attribute_not_exists(userId)', // don't clobber a record made by a parallel request
    }));
    return { user, isNew: true };
  } catch (err) {
    if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
    const again = await ddb.send(new GetCommand({ TableName: config.usersTable, Key: { userId: caller.userId } }));
    return { user: again.Item as UserRecord, isNew: false };
  }
}

export async function markWatched(userId: string, key: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: config.usersTable,
    Key: { userId },
    UpdateExpression: 'SET watched.#k = if_not_exists(watched.#k, :t)',
    ExpressionAttributeNames: { '#k': key },
    ExpressionAttributeValues: { ':t': Math.floor(Date.now() / 1000) },
  }));
}

/** Saves where the user paused. Finishing a video removes it from "Continue Watching". */
export async function saveProgress(userId: string, key: string, seconds: number, finished: boolean) {
  await ddb.send(new UpdateCommand({
    TableName: config.usersTable,
    Key: { userId },
    UpdateExpression: finished ? 'REMOVE progress.#k' : 'SET progress.#k = :s',
    ExpressionAttributeNames: { '#k': key },
    ExpressionAttributeValues: finished ? undefined : { ':s': seconds },
  }));
  return { saved: true, seconds: finished ? 0 : seconds, finished };
}
