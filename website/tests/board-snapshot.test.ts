/**
 * The pinned board cards (round 2 spec §4.3.4, §10, §11.1; plan T5; #454): Contribute's "How work
 * moves" shows real cards from the project board, pinned by scripts/pin-board.mjs into
 * src/data/board-snapshot.json, never typed by hand. A refresh must keep every card in one of the
 * page's five columns, put the fetch date in the plate's caption, and keep Contribute within its
 * word budget however the titles change.
 */
import { describe, expect, it } from 'vitest';

import snapshot from '../src/data/board-snapshot.json';
import {
  COLUMNS,
  WORD,
  cardWords,
  columnOf,
  formatFetched,
  shownLabels,
  type Snapshot,
} from '../src/components/contribute/board-layout';
import { builtHtml } from './helpers/dist';

const board = snapshot as Snapshot;

/** The copy deck's words for the pinned cards (round 2 spec §4.3.4 `fig-cards`). */
const DECK_CARDS =
  'Discussion #76 · Introductions · genomeOS #63 · URL-encodable view state · type:ui · skill:frontend · genomeOS #45 · GOLDEN TEST 1 — HbS parity · type:science · skill:spatial-stats · genomeOS #32 · Define and freeze the curated variant set · type:data · wants-expert-review · genomeOS #18 · AFND adapter (1,324 populations) · type:data · skill:popgen';
/** Contribute's deck total and budget (round 2 spec §10). */
const DECK_TOTAL = 363;
const BUDGET = 380;

describe('board snapshot', () => {
  it('pins the board’s title, a fetch date and five cards with their labels and status', () => {
    expect(board.project.title).toBe('Genome OS Atlas');
    expect(board.fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(board.items).toHaveLength(5);
    for (const item of board.items) {
      expect(Number.isInteger(item.number), `#${item.number}`).toBe(true);
      expect(item.title.trim().length, `#${item.number}`).toBeGreaterThan(0);
      expect(['discussion', 'issue']).toContain(item.kind);
      expect(['open', 'closed']).toContain(item.state);
      expect(typeof item.status).toBe('string');
      for (const label of item.labels) {
        expect(label.name.length).toBeGreaterThan(0);
        expect(label.color, label.name).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  it('maps every pinned card to its column, one per column, Merge showing Done', () => {
    expect(board.items.map((item) => columnOf(item.status))).toEqual(
      COLUMNS.map((column) => column.key),
    );
    expect(board.items[0]).toMatchObject({
      kind: 'discussion',
      number: 76,
      status: 'Discussion',
    });
    const merged = board.items.find(
      (item) => columnOf(item.status) === 'merge',
    );
    expect(merged?.status).toBe('Done');
    expect(merged?.state).toBe('closed');
  });

  it('folds Ready into Backlog and shows neither Blocked nor Not planned', () => {
    expect(columnOf('Backlog')).toBe('backlog');
    expect(columnOf('Ready')).toBe('backlog');
    expect(columnOf('In progress')).toBe('progress');
    expect(columnOf('In review')).toBe('review');
    expect(columnOf('Done')).toBe('merge');
    expect(columnOf('Blocked')).toBeNull();
    expect(columnOf('Not planned')).toBeNull();
  });

  it('shows at most two labels per card: the type, then expert review or a skill', () => {
    const shown = board.items.map((item) =>
      shownLabels(item).map((label) => label.name),
    );
    for (const names of shown) expect(names.length).toBeLessThanOrEqual(2);
    expect(shown.slice(1)).toEqual([
      ['type:ui', 'skill:frontend'],
      ['type:science', 'skill:spatial-stats'],
      ['type:data', 'wants-expert-review'],
      ['type:data', 'skill:popgen'],
    ]);
  });

  it('renders the fetch date in the plate’s caption', () => {
    expect(formatFetched('2026-10-14')).toBe('14 Oct 2026');
    expect(formatFetched('2027-03-02')).toBe('2 Mar 2027');
    const html = builtHtml('contribute');
    expect(html).toContain(
      `Real cards, ${formatFetched(board.fetched)}. The moving card is an example.`,
    );
  });

  it('keeps Contribute within its word budget, whatever the refreshed titles say', () => {
    const deck = DECK_CARDS.match(WORD)!.length;
    const pinned = board.items.flatMap((item) => cardWords(item)).length;
    expect(DECK_TOTAL - deck + pinned).toBeLessThanOrEqual(BUDGET);
  });

  it('holds no token, credential or host', () => {
    const text = JSON.stringify(snapshot);
    expect(text).not.toMatch(/token|ghp_|github_pat_|https?:\/\//i);
  });
});
