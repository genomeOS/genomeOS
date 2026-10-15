/**
 * The Contact letter's typing pace (Contact page spec §4, "The letter"; the owner's request of
 * 2026-10-15): `planLetter` sets each line's `--n` over time, one line after another, at the
 * letter's own pace, and quickens it so a whole letter types in within about 3 s and a change
 * within about 1.2 s. The browser behaviour (in view, a change, reduced motion, assistive tech,
 * layout) is tests/marketing-contact.spec.ts's.
 */
import { describe, expect, it } from 'vitest';

import {
  BLOCK_MS,
  CHANGE_MS,
  END_MS,
  LETTER_CPS,
  LETTER_MS,
  LINE_MS,
  planLetter,
  type PlannedLine,
} from '../src/components/contact/letter-typing';
import { TYPE_CPS } from '../src/graphics/typing';
import {
  buildDraft,
  OFFERS,
  SECTIONS,
  type DraftState,
} from '../src/lib/contact-draft';

/**
 * The letter's lines as typed: To (the address is 18 characters), Subject, then each line of the
 * body; a blank line in the draft starts a new block.
 */
function letterLines(state: DraftState): PlannedLine[] {
  const draft = buildDraft(state);
  const lines: PlannedLine[] = [
    { ticks: 18, block: false },
    { ticks: draft.subject.length, block: false },
  ];
  for (const block of draft.body.split('\n\n'))
    for (const [line, text] of block.split('\n').entries())
      lines.push({ ticks: text.length, block: line === 0 });
  return lines;
}

/** A section's lines, its heading starting a block. */
const section = (id: keyof typeof SECTIONS): PlannedLine[] => [
  { ticks: SECTIONS[id].heading.length, block: true },
  ...SECTIONS[id].fields.map((field) => ({
    ticks: `- ${field}`.length,
    block: false,
  })),
];

describe('the letter’s typing pace', () => {
  it('types faster than the kit’s sentences, a character every 1000 / LETTER_CPS ms', () => {
    expect(LETTER_CPS).toBeGreaterThan(TYPE_CPS);
    const plan = planLetter(
      [
        { ticks: 13, block: true },
        { ticks: 11, block: false },
      ],
      LETTER_MS,
    );
    expect(plan.per).toBeCloseTo(1000 / LETTER_CPS, 9);
    const [first, second] = plan.frames;
    expect(first[0]).toEqual([0, 0]);
    expect(first[1]).toEqual([13 * plan.per, 13]);
    expect(plan.ends[0]).toBe(13 * plan.per);
    // The caret rests a line break after the last character, then goes.
    expect(first[2]).toEqual([plan.ends[0] + LINE_MS, 13]);
    expect(first[3]).toEqual([plan.ends[0] + LINE_MS + 1, 14]);
    // The last line's caret rests longest, then goes, and the typing ends.
    expect(second[2][0] - plan.ends[1]).toBeCloseTo(END_MS, 9);
    expect(second[3][1]).toBe(12);
    expect(plan.total).toBe(second[3][0]);
  });

  it('hands one caret from line to line: the next line’s first character shows as the last caret goes', () => {
    const plan = planLetter(
      letterLines({ topic: 'question', offers: [] }),
      LETTER_MS,
    );
    for (let index = 1; index < plan.frames.length; index += 1) {
      const gone = plan.frames[index - 1][3];
      // --n rounds to 1 half a character into the line.
      expect(plan.frames[index][0][0] + plan.per / 2).toBeCloseTo(gone[0], 9);
      // Never two lines typing at once.
      expect(plan.frames[index][0][0]).toBeGreaterThan(plan.ends[index - 1]);
    }
  });

  it('rests longer between blocks than between the lines of one', () => {
    const plan = planLetter(
      [
        { ticks: 8, block: true },
        { ticks: 7, block: false },
        { ticks: 13, block: true },
      ],
      LETTER_MS,
    );
    const rest = (index: number) => plan.frames[index][2][0] - plan.ends[index];
    expect(BLOCK_MS).toBeGreaterThan(LINE_MS);
    expect(rest(0)).toBeCloseTo(LINE_MS, 9);
    expect(rest(1)).toBeCloseTo(BLOCK_MS, 9);
  });

  it.each([
    ['the default letter', { topic: 'contribute', offers: [] }],
    ['every offer', { topic: 'contribute', offers: [...OFFERS] }],
    ['a question', { topic: 'question', offers: [] }],
  ] as [string, DraftState][])(
    'types %s in within about 3 s, the caret’s last rest included, every character of it',
    (_label, state) => {
      const lines = letterLines(state);
      const plan = planLetter(lines, LETTER_MS);
      // Quickened to the cap: each line's extra millisecond (its caret going) is all it adds.
      expect(plan.ends.at(-1)!).toBeLessThanOrEqual(LETTER_MS + lines.length);
      expect(plan.total).toBeLessThanOrEqual(3000);
      lines.forEach(({ ticks }, index) =>
        expect(plan.frames[index][2][1]).toBe(ticks),
      );
    },
  );

  it('retypes the largest changes within about 1.2 s', () => {
    // Contribute to Partner: the subject from nothing, the opening after "I'd like to ", and
    // Proposal's section.
    const partner = buildDraft({ topic: 'partner', offers: [] });
    const opening = partner.body.split('\n\n')[1];
    const purpose = planLetter(
      [
        { ticks: partner.subject.length, block: false },
        { ticks: opening.length - "I'd like to ".length, block: true },
        ...section('partner'),
      ],
      CHANGE_MS,
    );
    expect(purpose.total).toBeLessThanOrEqual(1200);
    // Data's section is the longest an offer adds, with ", data" and "data." besides.
    const data = planLetter(
      [
        { ticks: ', data'.length, block: false },
        { ticks: 'data.'.length, block: true },
        ...section('data'),
      ],
      CHANGE_MS,
    );
    expect(data.total).toBeLessThanOrEqual(1200);
  });

  it('keeps a short change at the letter’s own pace, not stretched to its cap', () => {
    const plan = planLetter([{ ticks: 5, block: false }], CHANGE_MS);
    expect(plan.ends[0]).toBeCloseTo((5 * 1000) / LETTER_CPS, 9);
    expect(plan.total).toBeCloseTo(plan.ends[0] + END_MS + 1, 9);
  });
});
