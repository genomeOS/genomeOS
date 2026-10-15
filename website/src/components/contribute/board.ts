/**
 * "How work moves": the board's live scene (round 2 spec §4.3.4, §2.3, §3.2; R2-7, R2-8; #454), a
 * lazy chunk that HowWorkMoves.astro imports when the board is a viewport away, never under reduced
 * motion (the server's storyboard stays). Ported from the design prototype (`r2/characters/board.html`,
 * `kit/board-scene.js`).
 *
 * - Measures the columns and draws the live floor in place of the storyboard (board-layout.ts
 *   `renderFloor`), then puts the whole story on one timeline (src/graphics/timeline.ts): 36 s of
 *   story (hello in Discussion, the pick in Backlog, hammer and inspect in In progress, the review
 *   in In review, the wall in Merge), then 8 s idle loops. The story starts at 35% visible, pauses
 *   off screen and in a hidden tab, and obeys Pause and Replay (SceneControls); it registers as
 *   "board" with the motion hooks.
 * - The example card moves between its reserved slots by transforms; counts tick as it arrives and
 *   leaves; its pull request goes Review requested → Approved → Merged.
 * - Phones and tablets (< 64rem): the columns are a 300 px track and a camera pans to the action,
 *   resting on Merge. The column buttons say where the camera is; pressing one pauses the scene and
 *   pans there; Play hands the view back to the camera.
 * - A resize redraws the floor against the new columns and keeps the clock's time.
 */
import { setMeasure } from '../../graphics/astro/props';
import { blinks, poseTracks } from '../../graphics/astro/tracks';
import {
  EASE,
  sceneController,
  type Frame,
  type Phase,
  type Timeline,
} from '../../graphics/timeline';
import {
  CAST_BOARD,
  FIG_SCALE,
  FLOOR_LIFT,
  T,
  cameraColumnAt,
  cameraKeys,
  cameraOffset,
  plan,
  renderFloor,
  type Geo,
  type Plan,
} from './board-layout';

const NARROW = '(max-width: 63.99rem)';

/** Let the browser run between the steps of a build. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const BLINK_LOOP: Record<(typeof CAST_BOARD)[number], number> = {
  A2: 900,
  A5: 3100,
  A3: 5200,
  E1: 2300,
  E2: 6100,
};

export function initBoard(figure: HTMLElement): void {
  const scroller = figure.querySelector<HTMLElement>('.gh-scroll')!;
  const pan = figure.querySelector<HTMLElement>('.gh-pan')!;
  const track = figure.querySelector<HTMLElement>('.gh-track')!;
  const floor = figure.querySelector<HTMLElement>('.gh-floor')!;
  const columns = [...figure.querySelectorAll<HTMLElement>('[data-col]')];
  const home = figure.querySelector<HTMLElement>('[data-example="home"]')!;
  const holders = columns.map((column) =>
    column.querySelector<HTMLElement>('[data-example]'),
  );
  const nav = figure.querySelector<HTMLElement>('.wb-colnav')!;
  const buttons = [...nav.querySelectorAll<HTMLButtonElement>('button')];
  const toggle = figure.querySelector<HTMLButtonElement>('[data-scene-toggle]');
  const replay = figure.querySelector<HTMLButtonElement>('[data-scene-replay]');
  const narrow = matchMedia(NARROW);

  let geo: Geo;
  let P: Plan;

  /** The board as it is laid out now: the floor band spans the track, columns relative to it. */
  const measure = (): Geo => {
    const band = floor.getBoundingClientRect();
    return {
      W: band.width,
      H: band.height,
      F: band.height - FLOOR_LIFT,
      s: FIG_SCALE,
      cols: columns.map((column) => {
        const box = column.getBoundingClientRect();
        return { x0: box.left - band.left, w: box.width };
      }),
    };
  };

  /** Everything on the timeline: the cast, the props, the bubbles, the card, the camera. Solving
   * every pose key is the costly part, so it breathes between astronauts (spec §7: no task over
   * 50 ms at 4× CPU). */
  const addTracks = async (tl: Timeline) => {
    const svg = floor.querySelector('svg')!;
    for (const id of CAST_BOARD) {
      await breathe();
      const astro = svg.querySelector(`.who-${id} .astro`)!;
      poseTracks(tl, 'story', astro, id, P.K[id]);
      poseTracks(tl, 'loop', astro, id, P.loopK[id]);
      blinks(tl, 'loop', astro, [BLINK_LOOP[id]]);
      blinks(
        tl,
        'story',
        astro,
        [3000, 9000, 15000, 21000, 27000, 33000].map(
          (t) => t + id.charCodeAt(1) * 97,
        ),
      );
    }
    await breathe();
    // One track per element and phase: frames pushed for one selector merge in time order.
    const merged = new Map<string, Frame[]>();
    for (const [phase, selector, frames] of P.props) {
      const key = `${phase}|${selector}`;
      merged.set(key, [...(merged.get(key) ?? []), ...frames]);
    }
    const pick = (scope: Element, selector: string) => [
      ...(scope.matches(selector) ? [scope] : []),
      ...scope.querySelectorAll(selector),
    ];
    for (const [key, frames] of merged) {
      const [phase, selector] = key.split('|') as [Phase, string];
      frames.sort((a, b) => a[0] - b[0]);
      const scope = /^\.(ex|st)-/.test(selector)
        ? home
        : selector.startsWith('[data-hover')
          ? figure
          : svg;
      for (const element of pick(scope, selector))
        tl.track(phase, element, frames);
    }
    for (const said of P.says) {
      const bubble = svg.querySelector(`.say-${said.k}`);
      tl.story(bubble, [
        [0, { opacity: 0 }],
        [said.t0, { opacity: 0 }],
        [said.t0 + 1, { opacity: 1 }],
        [said.t1 - 200, { opacity: 1 }, EASE.out],
        [said.t1, { opacity: 0 }],
      ]);
      tl.story(bubble?.querySelector('.bubble-pop') ?? null, [
        [0, 'scale(0)'],
        [said.t0, 'scale(0)', EASE.back],
        [said.t0 + 280, 'scale(1)'],
      ]);
    }
    // The example card slides between its reserved slots (measured untransformed: no track yet).
    const base = home.getBoundingClientRect();
    const toSlot = (col: number) => {
      const box = holders[col]!.getBoundingClientRect();
      return `translate(${Math.round((box.left - base.left) * 100) / 100}px, ${Math.round((box.top - base.top) * 100) / 100}px)`;
    };
    const moves: Frame[] = [];
    P.cardMoves.forEach(([t, col], index) => {
      if (index > 0) moves.push([t, moves[moves.length - 1][1], EASE.inOut]);
      moves.push([index === 0 ? t : t + 520, toSlot(col)]);
    });
    tl.story(home, moves);
    // Counts tick halfway through each move.
    columns.forEach((column, col) => {
      const [out, into] = column.querySelectorAll('.gh-count > span');
      const here = P.cardMoves.map(
        ([t, at], index) => [index === 0 ? 0 : t + 260, at === col] as const,
      );
      tl.story(
        into,
        here.map(([t, on]) => [t, { opacity: on ? 1 : 0 }, EASE.step]),
      );
      tl.story(
        out,
        here.map(([t, on]) => [t, { opacity: on ? 0 : 1 }, EASE.step]),
      );
    });
    // Phones and tablets: the camera follows the action along the track.
    if (narrow.matches)
      tl.story(track, cameraKeys(geo, P, scroller.clientWidth));
  };

  /** Measure, plan and draw the live floor, a step per task. */
  const draw = async () => {
    scroller.scrollLeft = 0;
    geo = measure();
    P = plan(geo);
    await breathe();
    const markup = renderFloor(geo, P);
    await breathe();
    floor.innerHTML = markup;
    await breathe();
  };

  const controller = sceneController(
    figure,
    async (tl) => {
      // Bubbles fit their words in the board's own face.
      await document.fonts.ready;
      const context = document.createElement('canvas').getContext('2d');
      if (context)
        setMeasure((text, size) => {
          context.font = `600 ${size}px "Figtree Variable"`;
          return context.measureText(text).width;
        });
      figure.classList.add('is-live');
      // The other counts and statuses join in (the timeline sets which one shows).
      for (const element of figure.querySelectorAll<HTMLElement>(
        '.gh-count > [hidden], [data-example="home"] .st[hidden]',
      )) {
        element.hidden = false;
        element.removeAttribute('aria-hidden');
        element.style.opacity = '0';
      }
      await draw();
      await addTracks(tl);
    },
    {
      name: 'board',
      timeline: { story: T.story, loop: T.loop },
      controls: { toggle, replay },
    },
  );

  /* -------------------------------------------------- the column buttons and the camera's column */

  let chosen: number | null = null;
  const press = (index: number) =>
    buttons.forEach((button, at) =>
      button.setAttribute('aria-pressed', String(at === index)),
    );
  const follow = () => {
    const tl = controller.timeline;
    if (chosen === null && tl && P) press(cameraColumnAt(P, tl.time));
  };
  const release = () => {
    chosen = null;
    pan.style.transform = '';
  };
  nav.hidden = false;
  nav.addEventListener('click', (event) => {
    const button = (event.target as Element).closest('button');
    if (!button || !geo) return;
    const index = buttons.indexOf(button as HTMLButtonElement);
    controller.pause();
    chosen = index;
    // The camera holds its offset; the pan wrapper adds the difference to the chosen column.
    const camera = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
    pan.style.transform = `translateX(${-cameraOffset(geo, index, scroller.clientWidth) - camera}px)`;
    press(index);
  });
  // Play (after the scene's own handler has run) and Replay hand the view back to the camera.
  toggle?.addEventListener('click', () => {
    if (toggle.getAttribute('aria-pressed') === 'false') {
      release();
      follow();
    }
  });
  replay?.addEventListener('click', release);

  // The pressed button follows the camera: on every change of state, and at each pan while playing.
  let next = 0;
  const schedule = () => {
    window.clearTimeout(next);
    const tl = controller.timeline;
    if (!tl || !P) return;
    follow();
    if (!tl.playing) return;
    const now = tl.time;
    const upcoming = P.camera.find(([t]) => t > now);
    if (upcoming && now < T.story)
      next = window.setTimeout(schedule, upcoming[0] - now + 20);
  };
  new MutationObserver(schedule).observe(figure, {
    attributes: true,
    attributeFilter: ['data-scene-state'],
  });

  /* ------------------------------------------------------------- resize: refit, keep the time */

  let width = scroller.clientWidth;
  let refit = 0;
  const rebuild = async () => {
    const tl = controller.timeline;
    if (!tl) return;
    const t = tl.time;
    const playing = tl.playing;
    tl.cancel();
    release();
    await draw();
    await addTracks(tl);
    await tl.commit();
    tl.seek(t);
    if (playing) tl.play();
    follow();
  };
  new ResizeObserver(() => {
    if (scroller.clientWidth === width) return;
    width = scroller.clientWidth;
    window.clearTimeout(refit);
    refit = window.setTimeout(() => void rebuild(), 150);
  }).observe(scroller);
}
