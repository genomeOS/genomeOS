/** Private browser-memory map assistant; Atlas design §§4, 11, 16. */

import { useEffect, useRef, useState } from 'react';
import '../../styles/atlas-chat.css';
import type { AtlasSceneController } from '../../atlas/scene/atlas-scene';
import { acknowledgeMapView } from '../../atlas/chat-rendering';
import type { AtlasCatalog } from '../../atlas/contracts';
import {
  comparisonLink,
  proposedStates,
  responseSchema,
  sameAppliedView,
} from '../../atlas/chat-actions';
import {
  serializeExplorerState,
  type ExplorerState,
} from '../../atlas/url-state';

interface Props {
  catalog: AtlasCatalog;
  state: ExplorerState;
  ready: boolean;
  displayedId: string;
  controller: AtlasSceneController | null;
  siteBase: string;
  onState: (state: ExplorerState) => void;
}
interface Message {
  role: 'user' | 'assistant';
  text: string;
  sources?: { label: string; url: string }[];
}

export function AtlasChat({
  catalog,
  state,
  ready,
  displayedId,
  controller,
  siteBase,
  onState,
}: Props) {
  const endpoint = import.meta.env.PUBLIC_ATLAS_CHAT_URL as string | undefined;
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState('');
  const [revision, setRevision] = useState('');
  const [compare, setCompare] = useState('');
  const [undo, setUndo] = useState<ExplorerState | null>(null);
  const pending = useRef<{ id: string; state: ExplorerState } | null>(null);
  const acknowledging = useRef<object | null>(null);
  const abort = useRef<AbortController | null>(null);
  const current = useRef(state);
  current.current = state;
  useEffect(
    () => () => {
      abort.current?.abort();
      pending.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!open || !endpoint) return;
    setRevision('');
    const controller = new AbortController();
    fetch(`${endpoint.replace(/\/$/, '')}/v1/atlas/chat/catalog`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        if (!/^[a-f0-9]{64}$/.test(data.revision)) throw new Error();
        if (
          data.artifacts.length !== catalog.artifacts.length ||
          data.artifacts.some(
            (entry: {
              id: string;
              model_version: string;
              data_version: string;
              surface_sha256: string;
              observations_sha256: string;
            }) =>
              !catalog.artifacts.some(
                (ref) =>
                  ref.id === entry.id &&
                  ref.model_version === entry.model_version &&
                  ref.data_version === entry.data_version &&
                  ref.surface_sha256 === entry.surface_sha256 &&
                  ref.observations_sha256 === entry.observations_sha256,
              ),
          )
        )
          throw new Error();
        setRevision(data.revision);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setReceipt(
            'Assistant catalog unavailable or differs from this viewer.',
          );
      });
    return () => controller.abort();
  }, [open, endpoint, catalog]);
  useEffect(() => {
    const action = pending.current;
    if (!action || !ready || !controller) return;
    if (
      sameAppliedView(action.state, state) &&
      displayedId === state.entityId &&
      acknowledging.current !== action
    ) {
      acknowledging.current = action;
      const isCurrent = () =>
        pending.current === action &&
        sameAppliedView(action.state, current.current);
      acknowledgeMapView(controller, action.state, isCurrent)
        .then(() => {
          if (isCurrent()) {
            setReceipt(`Applied map action ${action.id}.`);
            pending.current = null;
          }
        })
        .catch(() => {
          if (pending.current === action) {
            setReceipt('Map action failed; no application confirmed.');
            pending.current = null;
          }
        });
    }
  }, [state, ready, displayedId, controller]);

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!endpoint || !revision || busy || !input.trim()) return;
    const question = input.trim();
    const snapshot = current.current;
    setMessages((items) => [...items, { role: 'user', text: question }]);
    setInput('');
    setBusy(true);
    setCompare('');
    setReceipt('Requesting a published-map operation…');
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(
        `${endpoint.replace(/\/$/, '')}/v1/atlas/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            message: question,
            catalog_revision: revision,
            state_token: serializeExplorerState(snapshot),
            current_id: snapshot.entityId,
            current_version: snapshot.artifactVersion,
            previous_questions: messages
              .filter((item) => item.role === 'user')
              .slice(-4)
              .map((item) => item.text),
          }),
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? 'Assistant budget reached; try again later.'
            : 'Assistant unavailable or request refused; map unchanged.',
        );
      const result = responseSchema.parse(await response.json());
      if (result.catalog_revision !== revision)
        throw new Error('Assistant catalog changed; reopen the panel.');
      setMessages((items) => [
        ...items,
        { role: 'assistant', text: result.answer, sources: result.sources },
      ]);
      if (result.action) {
        const states = proposedStates(
          result.action,
          current.current,
          catalog,
          revision,
        );
        if (result.action.operation === 'compare') {
          setCompare(comparisonLink(states, siteBase));
          setReceipt(
            'Comparison prepared. Open the two independent maps below.',
          );
        } else {
          setUndo(current.current);
          pending.current = {
            id: result.action.id,
            state: states[0],
          };
          setReceipt('Map action proposed; waiting for the viewer.');
          onState(states[0]);
        }
      } else setReceipt('Answered from published records; map unchanged.');
    } catch (error) {
      setReceipt(
        controller.signal.aborted
          ? 'Request cancelled; no new action applied.'
          : error instanceof Error
            ? error.message
            : 'Assistant unavailable.',
      );
    } finally {
      window.clearTimeout(timer);
      abort.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="atlas-chat">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Map assistant
      </button>
      {open && (
        <section
          aria-label="Private map assistant"
          className="atlas-chat-panel"
        >
          <p>
            Explore published genomeOS maps. Conversations stay in this page;
            questions are sent to Google Cloud for processing. No database
            changes.
          </p>
          {!endpoint && (
            <p role="status">Assistant backend is not configured.</p>
          )}
          <p role="status">{receipt}</p>
          <div role="log" aria-label="Conversation" aria-live="polite">
            {messages.map((message, index) => (
              <div key={index}>
                <strong>{message.role === 'user' ? 'You' : 'genomeOS'}</strong>
                <p>{message.text}</p>
                {message.sources?.map((source, i) => (
                  <a key={i} href={source.url} target="_blank" rel="noreferrer">
                    {source.label}{' '}
                  </a>
                ))}
              </div>
            ))}
          </div>
          <form onSubmit={submit}>
            <label>
              Ask about the map
              <textarea
                value={input}
                maxLength={2000}
                onChange={(event) => setInput(event.target.value)}
                disabled={busy || !endpoint}
              />
            </label>
            <button disabled={busy || !revision || !ready || !input.trim()}>
              Send
            </button>
            {busy && (
              <button type="button" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            )}
          </form>
          {compare && <a href={compare}>Open comparison</a>}
          {undo && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                pending.current = {
                  id: 'undo',
                  state: undo,
                };
                onState(undo);
                setUndo(null);
                setReceipt(
                  'Undo requested; the viewer is restoring the previous view.',
                );
              }}
            >
              Undo map change
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              abort.current?.abort();
              pending.current = null;
              setMessages([]);
              setCompare('');
              setReceipt('Conversation cleared.');
            }}
          >
            Clear conversation
          </button>
          <a href={`?${serializeExplorerState(state)}`}>
            Share current versioned view
          </a>
        </section>
      )}
    </div>
  );
}
