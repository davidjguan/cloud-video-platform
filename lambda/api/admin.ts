/** Admin-only actions. Admin status comes from the Cognito "admins" group in the verified token. */
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { lambdaClient, config } from './aws';
import { HttpError } from './lib';
import type { Caller } from './handler';

/**
 * Starts a thumbnail backfill: the processor makes thumbnails for every video that doesn't
 * have one yet (e.g. videos uploaded before the processor existed). Runs in the background
 * ("Event" invocation), so this returns right away.
 */
export async function startThumbnailBackfill(caller: Caller, force: boolean) {
  if (!caller.isAdmin) throw new HttpError(403, 'Admins only');
  if (!config.processorFunction) throw new HttpError(500, 'Processor is not configured');
  await lambdaClient.send(new InvokeCommand({
    FunctionName: config.processorFunction,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ action: 'backfill', force })),
  }));
  return { started: true, force };
}
