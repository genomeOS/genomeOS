/**
 * The Contact letter types itself out (Contact page spec §4, "The letter"; the owner's request of
 * 2026-10-15: "in the preview email template, letters should be written out with a typing
 * animation"; round 2 spec §3.2 "Typing" and §2.3's motion rules; #454). The island (contact.ts)
 * runs it where the pre-paint script set the letter waiting.
 *
 * - The first time the letter is in view (the scene controller's thresholds: 35% of it, or 35% of
 *   the screen), it writes itself out top to bottom: To, Subject, the greeting, the opening, About
 *   me, each section, the sign-off, in at most about 3 s, one caret after the last character typed.
 *   Until then it waits with its words hidden (`data-typing="pending"`, set before the first paint
 *   by contact-paint.ts), so it never shows whole and then empties.
 * - A change retypes only what it changed, from where the old and the new words part: a new
 *   subject or opening after the words they share, a new section from nothing, in about 1.2 s. A
 *   section that goes leaves at once and closes (contact.css). A change mid-typing carries on from
 *   what is on screen: nothing is typed twice, and the letter never starts again from the top.
 * - Display only, and only while a line types: its words are then one visually hidden span at its
 *   start, for assistive tech, and each of its text nodes an `aria-hidden` twin, one span per
 *   character (`--i`), shown once the line's `--n` passes it. At rest the letter is its plain
 *   markup again: its structure, a copy of it and the drafts (contact-draft.ts) never see the
 *   typing. Untyped characters keep their space, so nothing moves.
 * - The kit's typing (round 2 spec §3.2; src/graphics/typing.ts): the registered `--n` (scenes.css),
 *   the twin, one Web Animation per line, seekable through the motion hooks. Its modules are not
 *   imported: they ship in the shared scene and figure kit chunks (astro.config.mjs), which would
 *   load whole on Contact's first view, where the letter already is on a desktop, for a few lines
 *   of keyframes (11.2 KB of JavaScript against the page's 6). The caret is a box-shadow, not the
 *   kit's positioned `::after`, which moves the breaks of a wrapped, balanced line.
 * - A field's dotted leader draws out once its line is typed; an offer's icon shows with its
 *   heading's first character (contact.css).
 * - Reduced motion, forced colours and print show the letter whole (contact.css), and a switch to
 *   any of them mid-typing ends the typing at once. The e2e build's motion hooks scrub it as
 *   `contact-letter` (motion-hooks.ts); a seek to or past its end puts it at rest.
 */
import { registerScene } from '../../graphics/motion-hooks';

/** Characters a second: faster than the kit's sentences (62), for a letter of 200 to 600. */
export const LETTER_CPS = 90;
/** The caret's rest at the end of a line, at the end of a block (the head, a paragraph), and last. */
export const LINE_MS = 50;
export const BLOCK_MS = 110;
export const END_MS = 300;
/** The longest a whole letter types, and a change, before the caret's last rest. */
export const LETTER_MS = 2500;
export const CHANGE_MS = 850;
/** A field's leader draws out in this long once its line is typed, on the figures' ease. */
const LEADER_MS = 200;
const EASE_OUT = 'cubic-bezier(0.2, 0.72, 0.2, 1)';
/** The scene controller's (src/graphics/timeline.ts): in view at 35% of the letter or the screen. */
const THRESHOLD = 0.35;

const LINES = '.letter__row dd, [data-letter-line]';
const STILL = '(prefers-reduced-motion: reduce), (forced-colors: active)';

export interface PlannedLine {
  /** How many characters the line types. */
  ticks: number;
  /** Whether it starts a block of the letter (the caret rests longer before it). */
  block: boolean;
}

export interface Plan {
  /** Each line's `--n` at moments of the typing: [ms, n]. */
  frames: [number, number][][];
  /** When each line's last character shows. */
  ends: number[];
  /** ms a character. */
  per: number;
  total: number;
}

/**
 * The lines one after another at the letter's pace, quickened (the rests with it) if they would
 * take longer than `cap`. A line's caret rests after its last character, then goes (n = ticks + 1)
 * just as the next line's first character shows (its `--n` rounds to 1 half a character in), so
 * one caret moves through the letter; the last rests longest.
 */
export function planLetter(lines: readonly PlannedLine[], cap: number): Plan {
  const plan = (pace: number): Plan => {
    const per = 1000 / (LETTER_CPS * pace);
    const frames: [number, number][][] = [];
    const ends: number[] = [];
    let start = 0;
    lines.forEach(({ ticks }, index) => {
      const next = lines[index + 1];
      const end = start + ticks * per;
      const gone =
        end + (next ? (next.block ? BLOCK_MS : LINE_MS) / pace : END_MS);
      frames.push([
        [start, 0],
        [end, ticks],
        [gone, ticks],
        [gone + 1, ticks + 1],
      ]);
      ends.push(end);
      start = gone + 1 - per / 2;
    });
    return { frames, ends, per, total: start + per / 2 };
  };
  const steady = plan(1);
  const typed = steady.ends[steady.ends.length - 1] ?? 0;
  return typed > cap ? plan(typed / cap) : steady;
}

/** What a line of the letter says, and how much of it shows, before a change. */
export interface Seen {
  text: string;
  typed: number;
}

export interface LetterTyping {
  /** Each line's words and how many of them show, keyed by its place in the letter. */
  snapshot(): Map<Element, Seen>;
  /** After a change (the draft redrawn): type what it changed. */
  retype(before: Map<Element, Seen>): void;
}

export function letterTyping(
  letter: HTMLElement,
  figure: HTMLElement,
): LetterTyping {
  const still = matchMedia(STILL);
  /** The lines being typed: their words, and each character's `--i` (-2: on screen already). */
  let lines = new Map<HTMLElement, { text: string; marks: number[] }>();
  let undo: (() => void)[] = [];
  let anims: Animation[] = [];
  let total = 0;
  let pass = 0;

  const state = (value?: string) => {
    if (value) letter.dataset.typing = value;
    return letter.dataset.typing;
  };
  const time = () => Number(anims[0]?.currentTime ?? 0);
  /** The lines on screen: not another purpose's, not in a section that is closed or closing. */
  const shown = () =>
    [...letter.querySelectorAll<HTMLElement>(LINES)].filter((line) => {
      const section = line.closest('.letter__section');
      return (
        line.getClientRects().length > 0 &&
        (!section || getComputedStyle(section).opacity !== '0')
      );
    });
  /** A line's text nodes on screen (not another purpose's subject, nor the To line's stand-in). */
  const texts = (line: HTMLElement) => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (node.nodeValue && node.parentElement!.getClientRects().length)
        nodes.push(node as Text);
    return nodes;
  };
  const words = (line: HTMLElement) =>
    lines.get(line)?.text ??
    texts(line)
      .map((node) => node.nodeValue)
      .join('');
  /** A purpose's opening is one place of the letter, whichever purpose's shows. */
  const place = (line: HTMLElement) =>
    line.hasAttribute('data-for-topic') ? line.parentElement! : line;

  /** Every line plain text again, and no animation. */
  const stop = () => {
    for (const step of undo.reverse()) step();
    for (const animation of anims) animation.cancel();
    undo = [];
    anims = [];
    lines = new Map();
    pass += 1;
  };
  const rest = () => {
    stop();
    state('rest');
  };

  /** Type each line from its `keep`th character, within `cap` ms. */
  const type = (todo: { line: HTMLElement; keep: number }[], cap: number) => {
    stop();
    if (!todo.length) return void state('rest');
    const planned: PlannedLine[] = [];
    let block: Element | null = null;
    for (const { line, keep } of todo) {
      const nodes = texts(line);
      const text = nodes.map((node) => node.nodeValue).join('');
      const marks: number[] = [];
      let ticks = 0;
      for (const node of nodes) {
        const parent = node.parentElement!;
        // A space that opens a block's text (a field's label) is not laid out, nor typed.
        const lead =
          node === parent.firstChild &&
          getComputedStyle(parent).display !== 'inline';
        const twin = document.createElement('span');
        twin.className = 'letter__typed';
        twin.setAttribute('aria-hidden', 'true');
        for (const char of node.nodeValue!) {
          const mark =
            marks.length < keep ||
            (lead && twin.firstChild === null && char === ' ')
              ? -2
              : ticks++;
          marks.push(mark);
          const span = document.createElement('span');
          span.textContent = char;
          span.style.setProperty('--i', String(mark));
          twin.append(span);
        }
        node.replaceWith(twin);
        // A redraw may have replaced the twin's parent's words since; then it is gone already.
        undo.push(() => twin.replaceWith(node));
      }
      const sr = document.createElement('span');
      sr.className = 'visually-hidden';
      sr.textContent = text;
      line.prepend(sr);
      line.setAttribute('data-typing-line', '');
      undo.push(() => {
        sr.remove();
        line.removeAttribute('data-typing-line');
      });
      lines.set(line, { text, marks });
      const own = line.closest('[data-letter-block], dl');
      planned.push({ ticks, block: block !== null && own !== block });
      block = own;
    }
    const plan = planLetter(planned, cap);
    total = plan.total;
    const at = (ms: number) => Math.min(1, ms / total);
    const timing: KeyframeAnimationOptions = { duration: total, fill: 'both' };
    todo.forEach(({ line }, index) => {
      const frames = plan.frames[index];
      anims.push(
        line.animate(
          [
            { offset: 0, '--n': 0 },
            ...frames.map(([ms, n]) => ({ offset: at(ms), '--n': n })),
            { offset: 1, '--n': frames[3][1] },
          ],
          timing,
        ),
      );
      const leader = line.querySelector('.letter__leader');
      const end = plan.ends[index];
      if (leader)
        anims.push(
          leader.animate(
            [
              { offset: 0, transform: 'scaleX(0)' },
              { offset: at(end), transform: 'scaleX(0)', easing: EASE_OUT },
              { offset: at(end + LEADER_MS), transform: 'scaleX(1)' },
              { offset: 1, transform: 'scaleX(1)' },
            ],
            timing,
          ),
        );
    });
    state('typing');
    const current = pass;
    Promise.all(anims.map((animation) => animation.finished)).then(
      () => pass === current && rest(),
      () => {},
    );
  };

  const start = () => {
    if (state() !== 'pending') return;
    seen.disconnect();
    if (still.matches) return rest();
    type(
      shown().map((line) => ({ line, keep: 0 })),
      LETTER_MS,
    );
  };
  const seen = new IntersectionObserver(
    ([entry]) => {
      if (
        entry.isIntersecting &&
        (entry.intersectionRatio >= THRESHOLD ||
          entry.intersectionRect.height >= THRESHOLD * innerHeight)
      )
        start();
    },
    { threshold: [0, 0.1, 0.2, THRESHOLD, 0.5] },
  );
  seen.observe(figure);
  // Reduced motion or forced colours, turned on mid-typing, and printing: the letter whole now.
  still.addEventListener('change', () => {
    if (still.matches && state() !== 'rest') rest();
  });
  addEventListener('beforeprint', () => {
    if (state() === 'typing') rest();
  });

  // The motion hooks (motion-hooks.ts), in dev and the e2e build only: the deployed build drops
  // this whole branch, and the import goes unused. A static import, not import(): a dynamic one
  // of a module the figure kit also imports statically makes the bundler build a namespace object
  // for it, and its helper landed in the React chunk, which every figure page then loaded.
  if (import.meta.env.DEV || import.meta.env.PUBLIC_MOTION_HOOKS === '1')
    registerScene({
      name: 'contact-letter',
      get story() {
        return total;
      },
      seek(ms) {
        start();
        if (ms >= total) return rest();
        for (const animation of anims) {
          animation.pause();
          animation.currentTime = ms;
        }
      },
      pause: () => anims.forEach((animation) => animation.pause()),
      play: () => anims.forEach((animation) => animation.play()),
      get time() {
        return time();
      },
    });

  return {
    snapshot() {
      const before = new Map<Element, Seen>();
      for (const line of shown()) {
        const text = words(line);
        const marks = lines.get(line)?.marks;
        let typed = text.length;
        if (marks) {
          const n = Number.parseInt(
            getComputedStyle(line).getPropertyValue('--n'),
            10,
          );
          const next = marks.findIndex((mark) => mark >= n);
          if (next >= 0) typed = next;
        }
        before.set(place(line), { text, typed });
      }
      return before;
    },
    retype(before) {
      // Not begun: it types whatever stands once it is in view.
      if (state() === 'pending') return;
      if (still.matches) return rest();
      const left = state() === 'typing' ? total - time() - END_MS : 0;
      stop();
      const todo: { line: HTMLElement; keep: number }[] = [];
      for (const line of shown()) {
        const text = words(line);
        const was = before.get(place(line));
        let keep = 0;
        while (
          was &&
          keep < was.typed &&
          keep < text.length &&
          was.text[keep] === text[keep]
        )
          keep += 1;
        if (keep < text.length) todo.push({ line, keep });
      }
      type(todo, Math.max(CHANGE_MS, left));
    },
  };
}
