/**
 * Typing on the scene timeline (round 2 spec §3.2 "Typing"; R2-7; #454), ported from the design
 * prototype (`r2/characters/kit/type.js`). The full sentence is real DOM text for assistive tech
 * (visually hidden); an `aria-hidden` twin holds one `<span style="--i:k">` per character. One
 * timeline track animates the registered integer property `--n` on the twin, and CSS (scenes.css)
 * shows a character when `--n > --i`, with an ion caret after the last one. Seekable: no rAF, no
 * timers. `--n` starts at 100000, so without the animation (no JavaScript, reduced motion, no
 * `@property` support) the twin shows in full.
 */
import type { Frame } from './timeline';

/** Characters a second. */
export const TYPE_CPS = 62;
/** The pause after `.`, `;`, `:` (and `!`, `?`) before a space, and after a comma, ms. */
export const SENTENCE_PAUSE_MS = 240;
export const COMMA_PAUSE_MS = 110;

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Server markup for a typed sentence: `sr` is the sentence for assistive tech (visually hidden),
 * `twin` the `aria-hidden` typing layer (class `typed`, one span per character). `lead` sets the
 * first `lead` characters in bold (the "For example:" lead-in).
 */
export function splitTyped(
  text: string,
  opts: { lead?: number } = {},
): { sr: string; twin: string } {
  const lead = opts.lead ?? 0;
  const spans = [...text]
    .map(
      (ch, i) =>
        `<span style="--i:${i}"${i < lead ? ' class="b"' : ''}>${escape(ch)}</span>`,
    )
    .join('');
  return {
    sr: `<span class="visually-hidden">${escape(text)}</span>`,
    twin: `<span class="typed" aria-hidden="true">${spans}</span>`,
  };
}

/**
 * Keyframes for `--n` from `start` ms, at `cps` characters a second, with small human pauses after
 * punctuation; the caret lingers `hold` ms at the end and then goes (n = length + 1). The last
 * frame's time is when the typing ends.
 */
export function typeFrames(
  text: string,
  {
    start,
    cps = TYPE_CPS,
    hold = 500,
  }: { start: number; cps?: number; hold?: number },
): Frame[] {
  const per = 1000 / cps;
  const frames: Frame[] = [[start, { '--n': 0 }]];
  // Code points, as splitTyped spans them.
  const chars = [...text];
  let t = start;
  let n = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    n = i + 1;
    t += per;
    const pause =
      /[.;:!?]/.test(ch) && chars[i + 1] === ' '
        ? SENTENCE_PAUSE_MS
        : ch === ','
          ? COMMA_PAUSE_MS
          : 0;
    if (pause) {
      frames.push([t, { '--n': n }]);
      t += pause;
      frames.push([t, { '--n': n }]);
    }
  }
  frames.push([t, { '--n': n }]);
  frames.push([t + hold, { '--n': n }]);
  frames.push([t + hold + 1, { '--n': n + 1 }]);
  return frames;
}
