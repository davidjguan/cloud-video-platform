/**
 * Handler tests with mocked AWS calls. These focus on who is allowed to do what.
 */
process.env.USERS_TABLE = 'Users';
process.env.VIDEOS_TABLE = 'Videos';
process.env.COMMENTS_TABLE = 'Comments';
process.env.VIDEOS_BUCKET = 'videos-bucket';

import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, TransactWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler } from '../lambda/api/handler';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const VIDEO = 'videos/beach-day.mp4';

function event(
  routeKey: string,
  { body, query, sub = 'user-1', email = 'dave@example.com', groups }: {
    body?: unknown; query?: Record<string, string>; sub?: string; email?: string; groups?: string;
  } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, string> = { sub, email };
  if (groups) claims['cognito:groups'] = groups;
  return {
    routeKey,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    queryStringParameters: query,
    requestContext: { authorizer: { jwt: { claims, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const parse = (r: { body: string }) => JSON.parse(r.body);

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  s3Mock.on(HeadObjectCommand).resolves({});
});

describe('authentication', () => {
  it('rejects requests without a user id', async () => {
    const r = await handler(event('GET /api/me', { sub: '' }));
    expect(r.statusCode).toBe(401);
  });

  it('creates a profile on first visit and reports admin status from the token', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    const r = await handler(event('GET /api/me', { groups: '[admins]' }));
    expect(r.statusCode).toBe(200);
    expect(parse(r)).toMatchObject({ isNew: true, isAdmin: true, name: 'dave', user: { userId: 'user-1', likes: {} } });
  });
});

describe('comments', () => {
  it('uses the token identity as the author, ignoring anything in the body', async () => {
    ddbMock.on(PutCommand).resolves({});
    const r = await handler(event('POST /api/comments', {
      body: { key: VIDEO, text: '  great   clip ', author: 'someone-else', userId: 'user-2' },
    }));
    expect(r.statusCode).toBe(201);
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item).toMatchObject({ userId: 'user-1', author: 'dave', text: 'great clip', videoKey: VIDEO });
  });

  it("won't let you delete someone else's comment", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { videoKey: VIDEO, commentId: 'c1', userId: 'user-2' } });
    const r = await handler(event('DELETE /api/comments', { body: { key: VIDEO, commentId: 'c1' } }));
    expect(r.statusCode).toBe(403);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it('lets an admin delete any comment', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { videoKey: VIDEO, commentId: 'c1', userId: 'user-2' } });
    ddbMock.on(DeleteCommand).resolves({});
    const r = await handler(event('DELETE /api/comments', { body: { key: VIDEO, commentId: 'c1' }, groups: '[admins]' }));
    expect(r.statusCode).toBe(200);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it('rejects empty and oversized comments', async () => {
    expect((await handler(event('POST /api/comments', { body: { key: VIDEO, text: '   ' } }))).statusCode).toBe(400);
    expect((await handler(event('POST /api/comments', { body: { key: VIDEO, text: 'x'.repeat(501) } }))).statusCode).toBe(400);
  });

  it('marks which comments you can delete', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { videoKey: VIDEO, commentId: '1', userId: 'user-1', author: 'dave', text: 'mine', createdAt: 1 },
        { videoKey: VIDEO, commentId: '2', userId: 'user-2', author: 'amy', text: 'theirs', createdAt: 2 },
      ],
    });
    const r = parse(await handler(event('GET /api/comments', { query: { key: VIDEO } })));
    expect(r.comments.map((c: { canDelete: boolean }) => c.canDelete)).toEqual([true, false]);
    expect(r.comments[0]).not.toHaveProperty('userId'); // other users' IDs aren't exposed
  });
});

describe('videos', () => {
  it("won't let you delete a video someone else uploaded", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { videoKey: VIDEO, uploaderId: 'user-2' } });
    const r = await handler(event('DELETE /api/videos', { body: { key: VIDEO } }));
    expect(r.statusCode).toBe(403);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it('lets the uploader delete their video and its comments', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { videoKey: VIDEO, uploaderId: 'user-1' } });
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    s3Mock.on(DeleteObjectCommand).resolves({});
    const r = await handler(event('DELETE /api/videos', { body: { key: VIDEO } }));
    expect(r.statusCode).toBe(200);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it('rejects uploads over the size limit or of the wrong type', async () => {
    const big = await handler(event('POST /api/uploads', {
      body: { title: 'Big', sizeBytes: 200 * 1024 * 1024, contentType: 'video/mp4' },
    }));
    expect(big.statusCode).toBe(400);
    const mov = await handler(event('POST /api/uploads', {
      body: { title: 'Mov', sizeBytes: 1000, contentType: 'video/quicktime' },
    }));
    expect(mov.statusCode).toBe(400);
  });

  it('rejects keys outside the videos/ folder', async () => {
    const r = await handler(event('POST /api/play', { body: { key: 'site/index.html' } }));
    expect(r.statusCode).toBe(400);
  });

  it('treats a repeat like as a no-op instead of double counting', async () => {
    ddbMock.on(GetCommand, { TableName: 'Users' }).resolves({ Item: { userId: 'user-1', likes: { [VIDEO]: 1 } } });
    ddbMock.on(GetCommand, { TableName: 'Videos' }).resolves({ Item: { videoKey: VIDEO, likeCount: 1 } });
    const cancelled = Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
    ddbMock.on(TransactWriteCommand).rejects(cancelled);
    const r = await handler(event('POST /api/likes', { body: { key: VIDEO, like: true } }));
    expect(r.statusCode).toBe(200);
    expect(parse(r).likeCount).toBe(1);
  });
});
