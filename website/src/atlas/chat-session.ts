/** Anonymous browser identity transport, with no shared transcript store; Atlas design §16. */
import { z } from 'zod';

const sessionSchema = z.strictObject({
  session_id: z.string().regex(/^[a-f0-9]{64}$/),
  csrf_token: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.int().positive(),
});
export type ChatSession = z.infer<typeof sessionSchema>;

export async function initializeChatSession(
  endpoint: string,
  signal?: AbortSignal,
): Promise<ChatSession> {
  const response = await fetch(
    `${endpoint.replace(/\/$/, '')}/v1/atlas/chat/session`,
    {
      credentials: 'include',
      cache: 'no-store',
      signal,
    },
  );
  if (!response.ok)
    throw new Error('A private chat session could not be established.');
  return sessionSchema.parse(await response.json());
}

export function sessionRequestOptions(
  session: ChatSession,
): Pick<RequestInit, 'credentials' | 'headers'> {
  return {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrf_token,
    },
  };
}
