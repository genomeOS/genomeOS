/** Explicit mock renderer for browser chat isolation, never a scientific map result. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AtlasChat } from '../../src/components/atlas/AtlasChat';
import { parseExplorerState } from '../../src/atlas/url-state';
import { atlasCatalogSchema } from '../../src/atlas/contracts';
import type { AtlasSceneController } from '../../src/atlas/scene/atlas-scene';
import {
  initializeChatSession,
  sessionRequestOptions,
  type ChatSession,
} from '../../src/atlas/chat-session';

const endpoint = 'http://127.0.0.1:8017';
Object.assign(window, {
  bootstrap: () => initializeChatSession(endpoint),
  send: async (session: ChatSession, body: unknown) => {
    const res = await fetch(`${endpoint}/v1/atlas/chat`, {
      ...sessionRequestOptions(session),
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  },
  mountChat: async () => {
    const catalog = atlasCatalogSchema.parse(
      await (await fetch('/data/atlas/catalog.json')).json(),
    );
    let state = parseExplorerState('', catalog).state;
    const root = createRoot(document.getElementById('chat-root')!);
    const controller = {
      setMetric: async () => {},
      setLayerVisibility: () => {},
      setCamera: () => {},
    } as unknown as AtlasSceneController;
    const render = () =>
      root.render(
        React.createElement(AtlasChat, {
          catalog,
          state,
          ready: true,
          displayedId: state.entityId,
          controller,
          siteBase: '/',
          onState: (next) => {
            state = next;
            render();
          },
        }),
      );
    render();
  },
  fixtureReady: true,
});
