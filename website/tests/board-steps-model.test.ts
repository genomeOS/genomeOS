/**
 * The work board's steps, as a model (site redesign spec §4.3 C3, #454): one example issue in
 * exactly one place per step, the five real statuses, and a tour that fits in 6 s. Owned by the
 * board task (round 2 plan T5), which retires it with board-steps.ts; split verbatim out of
 * contribute-model.test.ts (plan T0 step 3).
 */
import { describe, expect, it } from 'vitest';

import {
  BOARD_COLUMNS,
  BOARD_STEPS,
  NO_SCRIPT_STEP,
  REDUCED_STEP,
  STEP_MS,
  TOUR_MS,
  TOUR_REST_STEP,
  stepAt,
} from '../src/components/contribute/board-steps';

describe('work board', () => {
  it('has the five real board statuses as columns', () => {
    expect(BOARD_COLUMNS.map((column) => column.label)).toEqual([
      'Backlog',
      'Ready',
      'In progress',
      'In review',
      'Blocked',
    ]);
  });

  it('puts the example issue in exactly one place per step, moving forward', () => {
    expect(BOARD_STEPS.map((step) => step.at)).toEqual([
      'discussion',
      'backlog',
      'ready',
      'in-progress',
      'in-review',
    ]);
    // Blocked holds ghost cards only.
    expect(BOARD_STEPS.some((step) => step.at === 'blocked')).toBe(false);
    // The column definition line names the column the card is in (none at the Discussion).
    for (const step of BOARD_STEPS) {
      const column = BOARD_COLUMNS.find((item) => item.key === step.at);
      if (!column) expect(step.definition).toBeNull();
      else expect(step.definition).toMatch(new RegExp(`^${column.label}: `));
    }
  });

  it('tours once in at most 6 s and rests on the last step', () => {
    expect(TOUR_MS).toBeLessThanOrEqual(6000);
    expect(STEP_MS * BOARD_STEPS.length).toBe(TOUR_MS);
    expect(TOUR_REST_STEP).toBe(5);
    expect(REDUCED_STEP).toBe(1);
    expect(NO_SCRIPT_STEP).toBe(3);
    let previous = 1;
    for (let t = 0; t < TOUR_MS; t += 50) {
      const step = stepAt(t);
      expect(step).toBeGreaterThanOrEqual(previous);
      expect(step).toBeLessThanOrEqual(5);
      previous = step;
    }
    expect(stepAt(0)).toBe(1);
    expect(stepAt(TOUR_MS - 1)).toBe(5);
    expect(stepAt(TOUR_MS + 500)).toBe(5);
  });
});
