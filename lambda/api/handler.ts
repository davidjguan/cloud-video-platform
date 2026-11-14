/**
 * Cloud Video Platform API, behind API Gateway (HTTP API) with a Cognito JWT authorizer.
 *
 * API Gateway has already verified the user's Cognito token before this runs, so who the
 * caller is (and whether they're an admin) comes from the verified token claims, never
 * from anything the browser sends in the request body.
 *
 * Routes (all require sign-in):
 *   GET    /api/me                   your profile (created on first visit) + admin flag
 *   GET    /api/videos               catalog with uploader, likes, and whether you can delete
 *   POST   /api/play       {key}     15-minute presigned S3 URL + mark as watched
 *   PUT    /api/progress   {key, seconds, finished?}
 *   POST   /api/uploads    {title, sizeBytes, contentType}  -> presigned S3 upload form
 *   DELETE /api/videos     {key}     uploader or admin
 *   POST   /api/likes      {key, like}
 *   GET    /api/comments?key=...
 *   POST   /api/comments   {key, text}
 *   DELETE /api/comments   {key, commentId}   author or admin
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { json, parseBody, requireVideoKey, toSeconds, parseGroups, displayName, HttpError, JsonResponse } from './lib';
import { getOrCreateUser, saveProgress } from './users';
import { listVideos, play, createUpload, deleteVideo, setLike, requireVideoExists } from './videos';
import { listComments, addComment, deleteComment } from './comments';

export interface Caller {
  userId: string;   // Cognito "sub": a permanent, unique user ID
  email: string;
  name: string;     // public display name
  isAdmin: boolean; // member of the Cognito "admins" group
}

function callerFrom(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  const userId = String(claims.sub ?? '');
  if (!userId) throw new HttpError(401, 'Not signed in');
  const email = String(claims.email ?? '');
  return {
    userId,
    email,
    name: displayName(email),
    isAdmin: parseGroups(claims['cognito:groups']).includes('admins'),
  };
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<JsonResponse> {
  try {
    const caller = callerFrom(event);
    const route = event.routeKey; // e.g. "GET /api/me"
    const body = parseBody(event.body, event.isBase64Encoded);

    switch (route) {
      case 'GET /api/me': {
        const { user, isNew } = await getOrCreateUser(caller);
        return json(200, { user, isNew, isAdmin: caller.isAdmin, name: caller.name });
      }
      case 'GET /api/videos':
        return json(200, await listVideos(caller));
      case 'POST /api/play': {
        const key = requireVideoKey(body.key); // validate input before touching the database
        const { user } = await getOrCreateUser(caller);
        return json(200, await play(user, key));
      }
      case 'PUT /api/progress':
        return json(200, await saveProgress(
          caller.userId, requireVideoKey(body.key), toSeconds(body.seconds), body.finished === true,
        ));
      case 'POST /api/uploads':
        return json(200, await createUpload(caller, body));
      case 'DELETE /api/videos':
        return json(200, await deleteVideo(caller, requireVideoKey(body.key)));
      case 'POST /api/likes': {
        const key = requireVideoKey(body.key);
        const { user } = await getOrCreateUser(caller);
        return json(200, await setLike(user, key, body.like !== false));
      }
      case 'GET /api/comments':
        return json(200, await listComments(caller, requireVideoKey(event.queryStringParameters?.key)));
      case 'POST /api/comments': {
        const key = requireVideoKey(body.key);
        await requireVideoExists(key);
        return json(201, await addComment(caller, key, body.text));
      }
      case 'DELETE /api/comments':
        return json(200, await deleteComment(caller, requireVideoKey(body.key), body.commentId));
      default:
        throw new HttpError(404, `No route for ${route}`);
    }
  } catch (err) {
    if (err instanceof HttpError) return json(err.statusCode, { error: err.message });
    console.error('Unhandled error', err);
    return json(500, { error: 'Internal error' });
  }
}
