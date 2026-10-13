import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initializeChatSession,
  sessionRequestOptions,
} from '../src/atlas/chat-session';

afterEach(() => vi.unstubAllGlobals());
const session = {
  session_id: 'a'.repeat(64),
  csrf_token: 'b'.repeat(64),
  expires_at: 2000000000,
};
describe('browser chat session transport', () => {
  it('lets the browser own its HttpOnly cookie and disables shared response caching', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(session)));
    vi.stubGlobal('fetch', fetcher);
    expect(await initializeChatSession('https://api.genome-os.org/')).toEqual(
      session,
    );
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.genome-os.org/v1/atlas/chat/session',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
    expect(sessionRequestOptions(session)).toEqual({
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrf_token,
      },
    });
  });
  it('rejects unverified, missing and malformed sessions instead of using a shared fallback ID', async () => {
    for (const value of [
      {},
      { ...session, session_id: 'shared' },
      { ...session, csrf_token: '' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify(value))),
      );
      await expect(
        initializeChatSession('https://api.genome-os.org'),
      ).rejects.toThrow();
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 403 })),
    );
    await expect(
      initializeChatSession('https://api.genome-os.org'),
    ).rejects.toThrow('could not be established');
  });
  it('uses the proof for the current browser without injecting session IDs into conversation bodies', () => {
    const other = {
      ...session,
      session_id: 'c'.repeat(64),
      csrf_token: 'd'.repeat(64),
    };
    expect(sessionRequestOptions(other).headers).not.toEqual(
      sessionRequestOptions(session).headers,
    );
    expect(JSON.stringify(sessionRequestOptions(session))).not.toContain(
      session.session_id,
    );
  });
});
