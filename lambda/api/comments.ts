/**
 * Comments, stored in the Comments table:
 *   partition key = videoKey  (all comments for a video live together)
 *   sort key      = commentId (starts with a timestamp, so a query returns them oldest-first)
 */
import { QueryCommand, PutCommand, GetCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, config } from './aws';
import { HttpError, requireText, newCommentId, chunk } from './lib';
import type { Caller } from './handler';

interface Comment {
  videoKey: string;
  commentId: string;
  userId: string;
  author: string;
  text: string;
  createdAt: number;
}

export async function listComments(caller: Caller, key: string) {
  const r = await ddb.send(new QueryCommand({
    TableName: config.commentsTable,
    KeyConditionExpression: 'videoKey = :k',
    ExpressionAttributeValues: { ':k': key },
    Limit: 200,
  }));
  const comments = ((r.Items ?? []) as Comment[]).map((c) => ({
    commentId: c.commentId,
    author: c.author,
    text: c.text,
    createdAt: c.createdAt,
    mine: c.userId === caller.userId,
    canDelete: caller.isAdmin || c.userId === caller.userId,
  }));
  return { comments };
}

/** The author comes from the verified token, so nobody can post as someone else. */
export async function addComment(caller: Caller, key: string, rawText: unknown) {
  const text = requireText(rawText, 'text', 500);
  const comment: Comment = {
    videoKey: key,
    commentId: newCommentId(),
    userId: caller.userId,
    author: caller.name,
    text,
    createdAt: Math.floor(Date.now() / 1000),
  };
  await ddb.send(new PutCommand({ TableName: config.commentsTable, Item: comment }));
  return { comment: { ...comment, userId: undefined, mine: true, canDelete: true } };
}

/** Author or admin only. */
export async function deleteComment(caller: Caller, key: string, commentId: unknown) {
  if (typeof commentId !== 'string' || !commentId) throw new HttpError(400, 'commentId is required');
  const r = await ddb.send(new GetCommand({ TableName: config.commentsTable, Key: { videoKey: key, commentId } }));
  const comment = r.Item as Comment | undefined;
  if (!comment) throw new HttpError(404, 'Comment not found');
  if (!caller.isAdmin && comment.userId !== caller.userId) {
    throw new HttpError(403, 'Only the author or an admin can delete this comment');
  }
  await ddb.send(new DeleteCommand({ TableName: config.commentsTable, Key: { videoKey: key, commentId } }));
  return { deleted: true, commentId };
}

/** Used when a video is deleted. BatchWrite handles 25 deletes per call. */
export async function deleteAllComments(key: string): Promise<number> {
  let removed = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: config.commentsTable,
      KeyConditionExpression: 'videoKey = :k',
      ExpressionAttributeValues: { ':k': key },
      ProjectionExpression: 'videoKey, commentId',
      ExclusiveStartKey: startKey,
    }));
    for (const batch of chunk(page.Items ?? [], 25)) {
      await ddb.send(new BatchWriteCommand({
        RequestItems: {
          [config.commentsTable]: batch.map((i) => ({
            DeleteRequest: { Key: { videoKey: i.videoKey, commentId: i.commentId } },
          })),
        },
      }));
      removed += batch.length;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return removed;
}
