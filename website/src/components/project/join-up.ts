/** The join-up plate (site redesign spec §4.2 P1, #454): five source records run through the
 * six-field observation contract, and only what the contract supports reaches the placement field.
 *
 * These are the registry invariants of AGENTS.md drawn as a schematic, with no numbers and no real
 * places: a coordinate needs a stated radius; a label with no coordinate fails the build; counts,
 * not frequencies; a continental ancestry group is context, never a place. Missing fields are
 * hatched in the record, never guessed.
 *
 * The data here feeds the server-rendered plate (JoinUp.astro); the island below adds the
 * entrance (records run through the contract one by one, 450 ms apart, within 3 s), field reasons
 * on hover or focus, row focus, and click-to-replay for one record. All motion is CSS keyframes
 * keyed by `--d` (ms); the island only toggles classes, so nothing runs after rest.
 */

import { FigureController, prefersReducedMotion } from '../../graphics/figure';

export type FieldKey =
  'place' | 'ac' | 'an' | 'orientation' | 'recruitment' | 'reuse';

export interface ContractField {
  key: FieldKey;
  label: string;
  /** Spelled out on hover (the `title` of an abbreviation). */
  title?: string;
  /** Shown in the bottom bar on hover or focus: 12 words or fewer. */
  reason: string;
}

/** Spec §4.2 copy deck: "Place ± radius · AC · AN · Allele orientation · Recruitment · Reuse terms". */
export const CONTRACT: readonly ContractField[] = [
  {
    key: 'place',
    label: 'Place ± radius',
    reason: 'A place needs a stated radius, or it claims precision it lacks.',
  },
  {
    key: 'ac',
    label: 'AC',
    title: 'allele count',
    reason:
      'The alleles that carry the variant, counted, never a rounded percentage.',
  },
  {
    key: 'an',
    label: 'AN',
    title: 'alleles tested',
    reason: 'AN turns a zero into weak evidence, not absence.',
  },
  {
    key: 'orientation',
    label: 'Allele orientation',
    reason: 'Which allele was counted, so two studies measure the same thing.',
  },
  {
    key: 'recruitment',
    label: 'Recruitment',
    reason: 'How people were recruited limits what a count can support.',
  },
  {
    key: 'reuse',
    label: 'Reuse terms',
    reason: 'Whether the source allows reuse, and on what terms.',
  },
];

/**
 * How a record meets one field:
 *   ok        present and valid: an aurora tick
 *   missing   absent: a hatched cell, never filled in
 *   flag      present but not what the field needs (a continent is not a place): a gold flag
 *   refused   absent where the contract cannot go on: hatched, with a gold cross; the record stops
 *   fail      absent where the build itself must fail: hatched, gold; the record stops
 *   skip      never reached, because the record stopped earlier
 */
export type CellState = 'ok' | 'missing' | 'flag' | 'refused' | 'fail' | 'skip';

export type Outcome = 'placed' | 'country' | 'context' | 'refused' | 'fails';

export interface SourceRecord {
  key: string;
  name: string;
  cells: readonly CellState[];
  outcome: Outcome;
  /** The outcome as the plate words it (spec §4.2 copy deck). */
  result: string;
  /** For the hidden table: the field that decided it. */
  why: string;
}

const ok = 'ok' as const;
const skip = 'skip' as const;

export const RECORDS: readonly SourceRecord[] = [
  {
    key: 'city',
    name: 'City sample',
    cells: [ok, ok, ok, ok, ok, ok],
    outcome: 'placed',
    result: 'Placed',
    why: 'Every field present; a small stated radius',
  },
  {
    key: 'national',
    name: 'National survey',
    cells: [ok, ok, ok, ok, ok, ok],
    outcome: 'country',
    result: 'Placed, country-wide',
    why: 'Every field present; a radius as wide as the country',
  },
  {
    key: 'continental',
    name: 'Continental group',
    cells: ['flag', ok, ok, ok, ok, ok],
    outcome: 'context',
    result: 'Context only, not a place',
    why: 'Its location is an ancestry label, not a place',
  },
  {
    key: 'paper',
    name: 'Paper table',
    cells: [ok, 'missing', 'refused', skip, skip, skip],
    outcome: 'refused',
    result: 'Refused: no count',
    why: 'A percentage with no allele count and no alleles tested',
  },
  {
    key: 'unplaced',
    name: 'Unplaced label',
    cells: ['fail', skip, skip, skip, skip, skip],
    outcome: 'fails',
    result: 'Build fails: no place',
    why: 'A population label with no coordinate',
  },
];

/** Entrance timing (ms): the header, then each record 450 ms after the last. */
export const HEADER_STEP = 35;
export const RECORD_START = 250;
export const RECORD_STEP = 450;
export const CELL_STEP = 45;
export const ENTRANCE_MS = 2800;

/** Index of the last field a record reaches (it stops at a refusal or a build failure). */
export const lastReached = (record: SourceRecord) => {
  const stop = record.cells.findIndex(
    (state) => state === 'refused' || state === 'fail',
  );
  return stop === -1 ? record.cells.length - 1 : stop;
};

/** When each part of record `index` appears, relative to the entrance start. */
export function recordTiming(index: number) {
  const start = RECORD_START + index * RECORD_STEP;
  const record = RECORDS[index];
  const reached = lastReached(record);
  return {
    start,
    cell: (field: number) =>
      field <= reached
        ? start + 120 + field * CELL_STEP
        : start + 120 + reached * CELL_STEP + 80,
    outcome: start + 120 + reached * CELL_STEP + 140,
  };
}

const REPLAY_MS = 1100;

export function initJoinUp(figure: HTMLElement): void {
  const grid = figure.querySelector<HTMLElement>('[data-joinup-grid]');
  const caption = figure.querySelector<HTMLElement>('[data-joinup-caption]');
  if (!grid || !caption) return;
  const resting = caption.textContent ?? '';

  new FigureController(figure, {
    duration: ENTRANCE_MS,
    arm: () => figure.classList.add('is-armed'),
    start: () => {
      figure.classList.remove('is-armed');
      figure.classList.add('is-playing');
    },
    rest: () => figure.classList.remove('is-armed', 'is-playing'),
  });

  /* Field reasons in the bottom bar (read from each field's description), its column lit. */
  let fieldFocus: string | null = null;
  const showField = (key: string | null) => {
    fieldFocus = key;
    let reason = '';
    for (const element of grid.querySelectorAll<HTMLElement>(
      '[data-field], [data-cell-field]',
    )) {
      const field = element.dataset.field ?? element.dataset.cellField;
      element.classList.toggle('is-lit', field === key);
      if (field === key && element.dataset.field) {
        const id = element.getAttribute('aria-describedby');
        reason = (id && document.getElementById(id)?.textContent) || '';
      }
    }
    caption.textContent = reason.trim() || resting;
  };
  for (const button of grid.querySelectorAll<HTMLElement>(
    'button[data-field]',
  )) {
    const key = button.dataset.field!;
    button.addEventListener('pointerenter', () => showField(key));
    button.addEventListener('pointerleave', () => {
      if (document.activeElement !== button) showField(null);
    });
    button.addEventListener('focus', () => showField(key));
    button.addEventListener('blur', () => showField(null));
  }

  /* A record's row lit on hover or focus (the others' art dims); a click replays its route. */
  const rows = [...grid.querySelectorAll<HTMLElement>('[data-record]')];
  const showRecord = (key: string | null) => {
    for (const row of rows)
      row.classList.toggle(
        'is-dim',
        key !== null && row.dataset.record !== key,
      );
  };
  for (const button of grid.querySelectorAll<HTMLElement>(
    'button[data-record-button]',
  )) {
    const key = button.dataset.recordButton!;
    const row = grid.querySelector<HTMLElement>(`[data-record="${key}"]`);
    button.addEventListener('pointerenter', () => showRecord(key));
    button.addEventListener('pointerleave', () => {
      if (document.activeElement !== button) showRecord(null);
    });
    button.addEventListener('focus', () => showRecord(key));
    button.addEventListener('blur', () => showRecord(null));
    let timer = 0;
    button.addEventListener('click', () => {
      if (!row) return;
      row.dataset.replay = String(Number(row.dataset.replay ?? 0) + 1);
      if (prefersReducedMotion()) return;
      row.classList.remove('is-replaying');
      void row.getBoundingClientRect();
      // display: contents has no box; reflow through a child so the animation restarts.
      void (row.firstElementChild as HTMLElement | null)?.offsetWidth;
      row.classList.add('is-replaying');
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => row.classList.remove('is-replaying'),
        REPLAY_MS,
      );
    });
  }

  figure.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (fieldFocus) showField(null);
    showRecord(null);
  });
}
