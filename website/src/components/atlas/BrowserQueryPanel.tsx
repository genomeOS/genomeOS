/**
 * "Query in your browser" (Atlas data platform design 2026-10-18 §3.1, §7, step 1.13): §3.1's
 * lookups of the selected map, run by the pinned DuckDB-WASM against the newest release's catalog.
 *
 * Nothing of DuckDB loads before the panel first opens. Then it checks for WebAssembly and Web
 * Workers, imports the engine and attaches the catalog read-only, and offers the examples whose
 * objects the catalog has. An example's result shows under Measured or Inferred, never both (Atlas
 * v1 §4); a query typed by hand shows under neither. "Copy for DuckDB" gives the same statement,
 * after the ATTACH, for the DuckDB CLI, Python or R. A failure says what the reader can do: wait out
 * a paused store (and use gnomAD meanwhile), reload for a withdrawn file, or fix their SQL.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { BrowserSql, QueryResult } from '../../atlas/browser-sql/engine';
import {
  explainQueryError,
  gnomadBrowserUrl,
  NO_WASM_TEXT,
  QUERY_ERROR_DOCS,
  withStoreStatus,
  type QueryError,
} from '../../atlas/browser-sql/errors';
import {
  attachStatement,
  browserSqlExamples,
  type BrowserSqlArtifact,
  type BrowserSqlExample,
} from '../../atlas/browser-sql/examples';
import type { DataStoreCatalogRef } from '../../lib/data-store-release';

export interface BrowserQueryArtifact extends BrowserSqlArtifact {
  /** The map's gnomAD dataset when it has a gnomAD lookup: a paused store links there instead. */
  gnomadDataset: string | null;
}

interface BrowserQueryPanelProps {
  catalog: DataStoreCatalogRef;
  artifact: BrowserQueryArtifact;
}

type EngineState =
  | { state: 'closed' }
  | { state: 'unsupported' }
  | { state: 'starting' }
  | { state: 'ready'; objects: string[] }
  | { state: 'failed'; error: QueryError };

const HEADINGS = {
  measured: {
    title: 'Measured',
    note: 'Source-recorded observations, not model estimates.',
  },
  inferred: {
    title: 'Inferred',
    note: 'Model output, not measurements.',
  },
} as const;

interface ShownResult {
  kind: BrowserSqlExample['kind'] | null;
  result: QueryResult;
}

function canRunDuckDb(): boolean {
  return typeof WebAssembly === 'object' && typeof Worker === 'function';
}

/** The status the store answers for `url` now, past any cached copy. */
async function storeStatus(url: string): Promise<number> {
  return (await fetch(url, { method: 'HEAD', cache: 'no-store' })).status;
}

async function explain(caught: unknown): Promise<QueryError> {
  const message = caught instanceof Error ? caught.message : String(caught);
  return explainQueryError(await withStoreStatus(message, storeStatus));
}

function ErrorNote({
  artifact,
  error,
}: {
  artifact: BrowserQueryArtifact;
  error: QueryError;
}) {
  const doc = QUERY_ERROR_DOCS[error.kind];
  const gnomad =
    error.kind === 'paused' && artifact.gnomadDataset
      ? gnomadBrowserUrl(artifact.variantId, artifact.gnomadDataset)
      : null;
  return (
    <div className="atlas-browser-sql__error" role="alert">
      {error.kind === 'sql' ? <pre>{error.text}</pre> : <p>{error.text}</p>}
      <p className="atlas-browser-sql__links">
        <a href={doc.href} target="_blank" rel="noopener noreferrer">
          {doc.label}
        </a>
        {gnomad && (
          <a href={gnomad} target="_blank" rel="noopener noreferrer">
            {artifact.variantId} in gnomAD’s browser
          </a>
        )}
      </p>
    </div>
  );
}

function ResultTable({ shown }: { shown: ShownResult }) {
  const { columns, rows, truncated } = shown.result;
  const heading = shown.kind ? HEADINGS[shown.kind] : null;
  return (
    <section className="atlas-browser-sql__result">
      <h3>{heading?.title ?? 'Your query'}</h3>
      {heading && <p className="atlas-browser-sql__note">{heading.note}</p>}
      <div className="atlas-browser-sql__table" tabIndex={0}>
        <table>
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th scope="col" key={index}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td key={index}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="atlas-browser-sql__note">
        {truncated
          ? `The first ${rows.length.toLocaleString('en-US')} rows; the rest were not read. Narrow the query, or copy it for DuckDB.`
          : `${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'row' : 'rows'}`}
      </p>
    </section>
  );
}

export function BrowserQueryPanel({
  catalog,
  artifact,
}: BrowserQueryPanelProps) {
  const engine = useRef<BrowserSql | null>(null);
  const mounted = useRef(true);
  const [status, setStatus] = useState<EngineState>({ state: 'closed' });
  const [sql, setSql] = useState('');
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState<ShownResult | null>(null);
  const [error, setError] = useState<QueryError | null>(null);
  const [copied, setCopied] = useState('');
  const { variantId, modelVersion, dataVersion } = artifact;
  const objects = status.state === 'ready' ? status.objects : null;
  const examples = useMemo(
    () =>
      objects
        ? browserSqlExamples(objects, { variantId, modelVersion, dataVersion })
        : [],
    [objects, variantId, modelVersion, dataVersion],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void engine.current?.close().catch(() => undefined);
      engine.current = null;
    };
  }, []);

  // A result belongs to the map it was asked for.
  useEffect(() => {
    setShown(null);
    setError(null);
  }, [variantId, modelVersion, dataVersion]);

  async function start() {
    if (!canRunDuckDb()) {
      setStatus({ state: 'unsupported' });
      return;
    }
    setStatus({ state: 'starting' });
    try {
      const { openBrowserSql } = await import('../../atlas/browser-sql/engine');
      const opened = await openBrowserSql();
      if (!mounted.current) {
        await opened.close();
        return;
      }
      engine.current = opened;
      await opened.attachCatalog(catalog.url);
      const listed = await opened.catalogObjects();
      if (mounted.current) setStatus({ state: 'ready', objects: listed });
    } catch (caught) {
      // Nothing can run without the catalog: stop DuckDB's worker, and say why.
      await engine.current?.close().catch(() => undefined);
      engine.current = null;
      const explained = await explain(caught);
      if (mounted.current) setStatus({ state: 'failed', error: explained });
    }
  }

  async function run(query: string) {
    const opened = engine.current;
    if (!opened || running) return;
    const example = examples.find(
      (candidate) => candidate.sql === query.trim(),
    );
    setRunning(true);
    setShown(null);
    setError(null);
    try {
      const result = await opened.run(query);
      if (mounted.current) setShown({ kind: example?.kind ?? null, result });
    } catch (caught) {
      const explained = await explain(caught);
      if (mounted.current) setError(explained);
    } finally {
      if (mounted.current) setRunning(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `${attachStatement(catalog.url)}\n${sql}`,
      );
      setCopied('Copied: the ATTACH statement, then the query.');
    } catch {
      setCopied('Copying failed: select the query and copy it yourself.');
    }
  }

  return (
    <details
      className="atlas-control-sheet atlas-browser-sql"
      onToggle={(event) => {
        if (event.currentTarget.open && status.state === 'closed') void start();
      }}
    >
      <summary>Query in your browser</summary>
      <div className="atlas-browser-sql__body">
        <p className="atlas-browser-sql__note">
          Release {catalog.release}’s catalog, attached read-only from the
          public data store. Free, with no account.
        </p>
        {status.state === 'unsupported' && <p role="status">{NO_WASM_TEXT}</p>}
        {status.state === 'starting' && (
          <p role="status">Starting DuckDB and attaching the catalog…</p>
        )}
        {status.state === 'failed' && (
          <ErrorNote artifact={artifact} error={status.error} />
        )}
        {examples.length > 0 && (
          <div
            className="atlas-browser-sql__examples"
            role="group"
            aria-label="Example queries"
          >
            {examples.map((example) => (
              <button
                type="button"
                key={example.id}
                disabled={running}
                onClick={() => {
                  setSql(example.sql);
                  void run(example.sql);
                }}
              >
                <span>{example.label}</span>
                <small>{HEADINGS[example.kind].title}</small>
              </button>
            ))}
          </div>
        )}
        <label className="atlas-browser-sql__query">
          <span>SQL, one statement</span>
          <textarea
            rows={5}
            spellCheck={false}
            placeholder="SELECT * FROM atlas.meta.release"
            value={sql}
            onChange={(event) => setSql(event.target.value)}
          />
        </label>
        <div className="atlas-browser-sql__actions">
          <button
            type="button"
            disabled={status.state !== 'ready' || running || !sql.trim()}
            onClick={() => void run(sql)}
          >
            {running ? 'Running…' : 'Run'}
          </button>
          <button type="button" onClick={() => void copy()}>
            Copy for DuckDB
          </button>
        </div>
        <p className="atlas-browser-sql__copied" role="status">
          {copied}
        </p>
        {error && <ErrorNote artifact={artifact} error={error} />}
        {shown && <ResultTable shown={shown} />}
      </div>
    </details>
  );
}
