/** "How work moves": the work board's steps (site redesign spec §4.3 C3, #454).
 *
 * One example issue moves through the project board, one step at a time. At every step it sits in
 * exactly one place: beside the Discussion #76 bubble as an idea, then in one of the five real
 * board statuses. The highlighted column, the selected tab and the column definition line always
 * name the same place. Blocked only ever holds ghost cards.
 *
 * Shared by WorkBoard.astro (server render) and board.ts (the island). No DOM.
 */

export type BoardPlace =
  'discussion' | 'backlog' | 'ready' | 'in-progress' | 'in-review' | 'blocked';

export interface BoardColumn {
  key: Exclude<BoardPlace, 'discussion'>;
  label: string;
  /** Faint outlined cards that keep the column from looking empty. */
  ghosts: number;
}

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  { key: 'backlog', label: 'Backlog', ghosts: 2 },
  { key: 'ready', label: 'Ready', ghosts: 1 },
  { key: 'in-progress', label: 'In progress', ghosts: 2 },
  { key: 'in-review', label: 'In review', ghosts: 1 },
  { key: 'blocked', label: 'Blocked', ghosts: 1 },
];

export interface BoardStep {
  n: 1 | 2 | 3 | 4 | 5;
  /** The tab's label after its number. */
  tab: string;
  /** Where the example issue sits. */
  at: BoardPlace;
  /** The column definition line, or null where the card is not on the board. */
  definition: string | null;
}

export const BOARD_STEPS: readonly BoardStep[] = [
  { n: 1, tab: 'Say hello', at: 'discussion', definition: null },
  {
    n: 2,
    tab: 'Read the record',
    at: 'backlog',
    definition: 'Backlog: logged, not yet specified.',
  },
  {
    n: 3,
    tab: 'Take Ready work',
    at: 'ready',
    definition: 'Ready: fully specified and unblocked; take it without asking.',
  },
  {
    n: 4,
    tab: 'Build to the contract',
    at: 'in-progress',
    definition: 'In progress: someone is actively moving it.',
  },
  {
    n: 5,
    tab: 'Open a pull request',
    at: 'in-review',
    definition: 'In review: a pull request or expert review is underway.',
  },
];

/** Each step of the tour holds this long; the card's move takes 450 ms of it. */
export const STEP_MS = 1200;
export const CARD_MOVE_MS = 450;
/** The tour plays once, step 1 to 5, then rests (spec §2.7: the one figure allowed 6 s). */
export const TOUR_MS = STEP_MS * BOARD_STEPS.length;
export const TOUR_REST_STEP = 5;
/** Reduced motion: no tour; the first step is selected. */
export const REDUCED_STEP = 1;
/** Without JavaScript the board shows the Ready step beside the five steps as a list. */
export const NO_SCRIPT_STEP = 3;

/** The step the tour shows `t` ms after it starts. */
export function stepAt(t: number): number {
  return Math.min(BOARD_STEPS.length, 1 + Math.floor(Math.max(0, t) / STEP_MS));
}
