/**
 * What a failed browser query means for the reader (Atlas data platform design 2026-10-18 §3.1,
 * §2.9, step 1.13): the store paused by the spending brake (a 403: "it says so and links to
 * gnomAD's browser"), a file the catalog names withdrawn (a 404), or the reader's own SQL.
 *
 * DuckDB-WASM's messages name the file it could not open but not the HTTP status, and a 403 and a
 * 404 read alike ("No files found that match the pattern …"). So the panel asks the store about that
 * file itself (`withStoreStatus`), and `explainQueryError` reads the status it adds. Only a store
 * object the catalog reads counts, `atlas.duckdb` or a Parquet file: attaching always asks for
 * `atlas.duckdb.wal`, which is never there, and that 404 is no withdrawal.
 */
import { GITHUB_REPOSITORY } from '../../data/nav';

export type QueryErrorKind = 'paused' | 'withdrawn' | 'sql';

export interface QueryError {
  kind: QueryErrorKind;
  text: string;
}

export const PAUSED_TEXT =
  'The public data store is paused: a spending brake made it private, so its files cannot be read now. Lookups resume when the maintainer restores access.';
export const WITHDRAWN_TEXT =
  "A file this release's catalog names is gone, most likely withdrawn. Reload the page for the newest catalog.";
export const NO_WASM_TEXT =
  'This browser cannot run DuckDB here (it needs WebAssembly and Web Workers). Copy the query and run it in the DuckDB CLI, Python or R.';

const DATA_ACCESS_DOC = `${GITHUB_REPOSITORY}/blob/main/docs/data-access.md`;

/** The section of docs/data-access.md (step 1.15) each kind of error links. */
export const QUERY_ERROR_DOCS: Record<
  QueryErrorKind,
  { label: string; href: string }
> = {
  paused: {
    label: 'When access stops',
    href: `${DATA_ACCESS_DOC}#when-access-stops-the-brake-and-the-kill-switch`,
  },
  withdrawn: { label: 'Takedowns', href: `${DATA_ACCESS_DOC}#takedowns` },
  sql: {
    label: 'Querying in your browser',
    href: `${DATA_ACCESS_DOC}#query-in-your-browser`,
  },
};

const URL_IN_TEXT = /https?:\/\/[^\s"'`<>]+/g;
/** A status the store answered, as DuckDB-WASM (`status: 403`) or `withStoreStatus` writes it. */
const STATUS = /\b(?:HTTP|status:?)\s+(\d{3})\b/i;
/** The store objects a catalog reads: the catalog database and Parquet files. */
const STORE_OBJECT = /\.(?:duckdb|parquet)$/;

/** The first store object (`.duckdb` or `.parquet`, never `.wal`) a DuckDB message names. */
export function storeObjectUrl(message: string): string | null {
  for (const [candidate] of message.matchAll(URL_IN_TEXT)) {
    const url = candidate.replace(/[).,;:]+$/, '');
    try {
      if (STORE_OBJECT.test(new URL(url).pathname)) return url;
    } catch {
      // Not a URL after all; look further.
    }
  }
  return null;
}

/**
 * `message`, with the status the store now answers for the object it names when that is a
 * refusal (`… (HTTP 403 for <url>)`). `head` returns the HTTP status of a HEAD request; when it
 * throws, or the object reads, or no object is named, the message is returned as it was.
 */
export async function withStoreStatus(
  message: string,
  head: (url: string) => Promise<number>,
): Promise<string> {
  const url = storeObjectUrl(message);
  if (url === null) return message;
  try {
    const status = await head(url);
    return status >= 400 ? `${message} (HTTP ${status} for ${url})` : message;
  } catch {
    return message;
  }
}

/** What a failed query's message means: a paused store, a withdrawn file, or SQL to fix. */
export function explainQueryError(message: string): QueryError {
  const status = STATUS.exec(message.replace(URL_IN_TEXT, ' '))?.[1];
  if (storeObjectUrl(message) !== null) {
    if (status === '403') return { kind: 'paused', text: PAUSED_TEXT };
    if (status === '404') return { kind: 'withdrawn', text: WITHDRAWN_TEXT };
  }
  return { kind: 'sql', text: message };
}

/** gnomAD's browser page for `variantId` (`chr-pos-ref-alt`, GRCh38) in `dataset`. */
export function gnomadBrowserUrl(variantId: string, dataset: string): string {
  return `https://gnomad.broadinstitute.org/variant/${encodeURIComponent(variantId)}?dataset=${encodeURIComponent(dataset)}`;
}
