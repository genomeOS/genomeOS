/**
 * Contribute's orbit scene in the browser (round 2 spec §4.3.2, §11.2; characters.md §2, §4–§5;
 * #454). Owned by the Contribute orbit and flow task (round 2 plan T4). Runs on the e2e build,
 * whose motion hooks (`window.__motion`, spec §3.4) put the scene at any moment, paused.
 *
 * - The seek table (0, 1.5, 7.12, 14, 21.4, 23.3, 32 and 40 s): the moons arrive in order, each
 *   group's text types after its moon, the pods land and the crews hop out, every column is lit
 *   at the story's end, and the orbit carries on into the idle loops. A picture of each moment is
 *   attached for the visual review.
 * - On a laptop the armed first paint draws the globe and its orbit, never an empty box, and the
 *   story waits until the whole stage and the top of its text columns show together, so each moon's
 *   arrival and its text typing are watched at once (design critique of the integrated build, round
 *   2); on a narrow plate it starts once 150 px of the stage show. Off screen every animation
 *   pauses; the Pause toggle is sticky and Replay starts over.
 * - A visitor who reads on down into the columns mid-story, the stage nearly gone, finds every
 *   column typed: the story goes to its end (paused still, if they had paused it).
 * - Above the fold it never paints its last frame and then empties (spec §2.7 rule 5), and a page
 *   that arrives too late to arm keeps that last frame through the build, frame by frame.
 * - On a narrow plate the text under the stage is one panel, the group being introduced, in step
 *   with the phone's close-ups, and all three columns stack once the story ends.
 * - A layout switch paints only the moment on screen: never an empty stage, never the last frame.
 * - Reduced motion: no animation at all, every word in full, the story's last frame; phones add
 *   a close-up of each moon above its text.
 * - Phones: the camera closes in on each landing. Tablets: their own layout.
 * - All the way round the endless idle orbit (review of T4, finding 1), on the drawn art: a moon
 *   label that shows is never covered by the globe, another moon, its crew or props, or another
 *   label; and every crew and prop stays inside the footprint the label model reckons with.
 * - The plate on one screen (owner, 2026-10-15): under the compact header, the bar, the stage and
 *   the columns down to their links at 1440 × 900 and up; the bar, the stage and every typed line
 *   at 1366 × 768 and 1280 × 800; the moon labels at 13 px or more at each.
 */
import { expect, test, type Page } from '@playwright/test';

import {
  FOOTPRINT,
  type Box,
} from '../src/components/contribute/orbit-footprint';
import { typeFrames } from '../src/graphics/typing';
import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const FIGURE = '[data-graphic="orbit"]';
const KINDS = ['data', 'model', 'ui'] as const;
/** orbit-layouts.ts T: the story, one revolution of the idle orbit and Data's moon pop, ms. */
const T = { story: 32000, orbit: 240000, dataMoon: 800 } as const;
const COLUMNS = ['group-data', 'group-modeling', 'group-ui'] as const;
/** --color-faint, --color-starlight and --color-ion, as painted (snapshot's `rgb`). */
const FAINT = 'rgb(127, 147, 174)';
const STARLIGHT = 'rgb(242, 248, 255)';
const ION = 'rgb(112, 230, 255)';

/** One painted frame of the drawn layout (recordFrames). */
interface OrbitFrame {
  layout: string | null;
  /** The head script armed the stage (its first moment painted). */
  armed: boolean;
  state: string | null;
  /** The globe's opacity. */
  globe: number;
  /** Which moons show. */
  moons: Record<(typeof KINDS)[number], boolean>;
  /** Data's moon centre, in the drawn layout's viewBox units. */
  data: { x: number; y: number };
  /** The UI column: its dimming (1 waiting, 0 lit) and the characters typed of its first line. */
  ui: { wait: number; typed: number };
}

declare global {
  interface Window {
    __orbitPaints?: { state: string | null; moon: boolean }[];
    __orbitFrames?: OrbitFrame[];
  }
}

/**
 * Record every frame of the drawn layout for `ms` ms (into `window.__orbitFrames`): an init
 * script, or evaluated in a running page. Self-contained, as both need. Each frame is read just
 * after it is painted, not in its animation-frame callback: those run before the frame's resize
 * observers, where the scene rebuilds on a layout switch, so they would read a state never painted.
 * A message posted from the callback arrives once the frame is rendered; if the viewport changed in
 * between, reading would lay out a frame not yet painted, so that one is skipped.
 */
function recordFrames(ms: number) {
  const frames: OrbitFrame[] = [];
  window.__orbitFrames = frames;
  const until = performance.now() + ms;
  const painted = new MessageChannel();
  const next = () =>
    requestAnimationFrame(() =>
      painted.port2.postMessage(`${innerWidth}x${innerHeight}`),
    );
  painted.port1.onmessage = ({ data }) => {
    if (data === `${innerWidth}x${innerHeight}`) sample();
    if (performance.now() < until) next();
  };
  const sample = () => {
    const figure = document.querySelector('[data-graphic="orbit"]');
    const svg = [
      ...(figure?.querySelectorAll<SVGSVGElement>('.orbit-svg') ?? []),
    ].find((item) => item.getClientRects().length > 0);
    const globe = svg?.querySelector('.globe');
    const disc = (kind: string) =>
      svg
        ?.querySelector(
          `.orbiter--moon[data-moon="${kind}"] .moon > circle:nth-of-type(2)`,
        )
        ?.getBoundingClientRect();
    const shown = (kind: string) => (disc(kind)?.width ?? 0) > 2;
    const column = figure?.querySelector('#group-ui');
    const twin = column?.querySelector('.typed');
    if (figure && svg && globe && column && twin) {
      const box = svg.getBoundingClientRect();
      const data = disc('data')!;
      const k = svg.viewBox.baseVal.width / box.width;
      const value = (element: Element, name: string) =>
        Number(getComputedStyle(element).getPropertyValue(name));
      frames.push({
        layout: svg.dataset.layout ?? null,
        armed: document.documentElement.hasAttribute('data-arm-orbit'),
        state: figure.getAttribute('data-scene-state'),
        globe: Math.round(Number(getComputedStyle(globe).opacity) * 100) / 100,
        moons: { data: shown('data'), model: shown('model'), ui: shown('ui') },
        data: {
          x: Math.round((data.x + data.width / 2 - box.x) * k * 10) / 10,
          y: Math.round((data.y + data.height / 2 - box.y) * k * 10) / 10,
        },
        ui: { wait: value(column, '--orbit-wait'), typed: value(twin, '--n') },
      });
    }
  };
  next();
}

async function seek(page: Page, ms: number) {
  await page.evaluate((t) => window.__motion!.seek('orbit', t), ms);
}

/** What the visitor sees in the drawn layout at this moment. */
function snapshot() {
  const figure = document.querySelector<HTMLElement>('[data-graphic="orbit"]')!;
  const svg = [...figure.querySelectorAll<SVGSVGElement>('.orbit-svg')].find(
    (item) => item.getClientRects().length > 0,
  )!;
  const opacity = (element: Element | null) => {
    let value = 1;
    for (let node = element; node && node !== svg; node = node.parentElement)
      value *= Number(getComputedStyle(node).opacity);
    return Math.round(value * 100) / 100;
  };
  const rect = (element: Element | null) => {
    const box = element!.getBoundingClientRect();
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      width: box.width,
    };
  };
  const moon = (kind: string) =>
    svg.querySelector(`.orbiter--moon[data-moon="${kind}"]`)!;
  // Columns dim through color-mix(), which computes as color(srgb …): paint each colour and read
  // it back as rgb().
  const paint = document.createElement('canvas').getContext('2d', {
    willReadFrequently: true,
  })!;
  const rgb = (color: string) => {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = color;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };
  const globe = svg.querySelector('.globe-in image')!;
  const columns = [...figure.querySelectorAll<HTMLElement>('.orbit-col')].map(
    (column) => ({
      id: column.id,
      title: rgb(getComputedStyle(column.querySelector('h3')!).color),
      link: rgb(getComputedStyle(column.querySelector('a')!).color),
      typed: [...column.querySelectorAll<HTMLElement>('.typed')].map((twin) => {
        const characters = [
          ...twin.querySelectorAll<HTMLElement>('span[style*="--i"]'),
        ];
        return {
          n: Number(getComputedStyle(twin).getPropertyValue('--n')),
          length: characters.length,
          // The characters a visitor sees: visible and fully opaque.
          shown: characters.filter((character) => {
            const style = getComputedStyle(character);
            return (
              style.visibility === 'visible' && Number(style.opacity) === 1
            );
          }).length,
        };
      }),
    }),
  );
  return {
    layout: svg.dataset.layout!,
    viewBox: svg.viewBox.baseVal.width,
    svg: rect(svg),
    globe: { ...rect(globe), opacity: opacity(globe) },
    moons: Object.fromEntries(
      ['data', 'model', 'ui'].map((kind) => {
        const disc = moon(kind).querySelector('.moon > circle:nth-of-type(2)')!;
        const ship = moon(kind).querySelector('.ship-g')!;
        return [
          kind,
          {
            ...rect(disc),
            shown: rect(disc).width > 2,
            ship: { ...rect(ship), opacity: opacity(ship) },
          },
        ];
      }),
    ),
    crews: Object.fromEntries(
      ['A1', 'A6', 'A5', 'A4', 'A2', 'A3'].map((id) => {
        const astro = svg.querySelector(`.crew-${id} .astro`)!;
        return [id, { ...rect(astro), opacity: opacity(astro) }];
      }),
    ),
    camera: getComputedStyle(svg.querySelector('.cam')!).transform,
    labels: opacity(svg.querySelector('.orb-labels')),
    columns,
  };
}

/**
 * Seek through the scene and say what is wrong at each moment, in the drawn layout: a showing label
 * covered by anything, or (once the story is over) a figure or prop outside its moon's footprint
 * (orbit-layouts.ts FOOTPRINT). One evaluate for the whole sweep, so it stays quick.
 */
async function sweep({
  footprint,
  story,
  until,
  step,
}: {
  footprint: Record<string, Record<string, Box[]>>;
  story: number;
  until: number;
  step: number;
}) {
  const found: string[] = [];
  for (let t = 0; t <= until; t += step) {
    await window.__motion!.seek('orbit', t);
    found.push(
      ...collisions(t >= story).map((failure) => `${t} ms: ${failure}`),
    );
  }
  return found;

  function collisions(checkFootprint: boolean) {
    const figure = document.querySelector<HTMLElement>(
      '[data-graphic="orbit"]',
    )!;
    const svg = [...figure.querySelectorAll<SVGSVGElement>('.orbit-svg')].find(
      (item) => item.getClientRects().length > 0,
    )!;
    const opacity = (element: Element) => {
      let value = 1;
      for (
        let node: Element | null = element;
        node && node !== svg;
        node = node.parentElement
      )
        value *= Number(getComputedStyle(node).opacity);
      return value;
    };
    const seen = (element: Element) =>
      opacity(element) > 0.05 && element.getBoundingClientRect().width > 0.5;
    type Rect = { left: number; top: number; right: number; bottom: number };
    const overlap = (a: Rect, b: Rect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    const disc = (element: Element, share = 1) => {
      const box = element.getBoundingClientRect();
      return {
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        r: (box.width / 2) * share,
      };
    };
    const onDisc = (
      box: Rect,
      { x, y, r }: { x: number; y: number; r: number },
    ) =>
      Math.hypot(
        Math.max(box.left, Math.min(x, box.right)) - x,
        Math.max(box.top, Math.min(y, box.bottom)) - y,
      ) <
      r - 0.5;
    const kinds = ['data', 'model', 'ui'];
    const moon = (kind: string) =>
      svg.querySelector(`.orbiter--moon[data-moon="${kind}"]`)!;
    /** A moon's figures and props, in FOOTPRINT's order. */
    const parts = (kind: string) => [
      ...[...moon(kind).querySelectorAll('.crew')].map((crew) =>
        crew.querySelector('.astro')!,
      ),
      ...moon(kind).querySelectorAll('.setup, .say, .fly-block'),
    ];
    const label = (kind: string) =>
      svg.querySelector(`.orbiter--label[data-moon="${kind}"] .moon-label`)!;
    const failures: string[] = [];
    const globe = disc(svg.querySelector('.globe-in image')!, 0.91);
    const shown = kinds.filter((kind) => seen(label(kind)));
    for (const kind of shown) {
      const box = label(kind).getBoundingClientRect();
      if (onDisc(box, globe)) failures.push(`${kind} label under the globe`);
      for (const other of kinds) {
        if (other === kind) continue;
        const body = moon(other).querySelector(
          '.moon > circle:nth-of-type(2)',
        )!;
        if (body.getBoundingClientRect().width > 2 && onDisc(box, disc(body)))
          failures.push(`${kind} label under the ${other} moon`);
        for (const part of parts(other))
          if (seen(part) && overlap(box, part.getBoundingClientRect()))
            failures.push(`${kind} label under the ${other} crew`);
        if (
          shown.includes(other) &&
          overlap(box, label(other).getBoundingClientRect())
        )
          failures.push(`${kind} label over the ${other} label`);
      }
    }
    if (checkFootprint)
      for (const kind of kinds) {
        const inverse = moon(kind)
          .querySelector<SVGGElement>('.moon-pop')!
          .getScreenCTM()!
          .inverse();
        parts(kind).forEach((part, index) => {
          if (!seen(part)) return;
          const box = part.getBoundingClientRect();
          const corners = [
            [box.left, box.top],
            [box.right, box.bottom],
          ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(inverse));
          const [x0, y0, x1, y1] = footprint[svg.dataset.layout!][kind][index];
          if (
            corners[0].x < x0 - 1.5 ||
            corners[0].y < y0 - 1.5 ||
            corners[1].x > x1 + 1.5 ||
            corners[1].y > y1 + 1.5
          )
            failures.push(`${kind} part ${index} outside its footprint`);
        });
      }
    return failures;
  }
}

type Shot = ReturnType<typeof snapshot>;

/** A screen point in the drawn layout's viewBox units. */
const viewBoxUnits = (shot: Shot, point: { x: number; y: number }) => {
  const k = shot.viewBox / (shot.svg.right - shot.svg.left);
  return { x: (point.x - shot.svg.left) * k, y: (point.y - shot.svg.top) * k };
};

async function openOrbit(page: Page) {
  await page.goto('/contribute/');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.__motion!.ready('orbit'));
}

/**
 * A slow connection (review of T4 round 2, finding 1): the HTML reaches the head script after
 * 1,200 ms, so it never arms, and the server's last frame is on screen while the scene builds. No
 * frame of the build may empty it.
 */
async function lateArrival(page: Page) {
  await page.route('**/contribute/', async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  });
  await page.addInitScript(recordFrames, 5000);
  await page.goto('/contribute/');
  const figure = page.locator(FIGURE);
  await expect(figure).toHaveAttribute('data-scene-state', 'playing', {
    timeout: 6000,
  });
  await page.waitForTimeout(800);
  const frames = await page.evaluate(() => window.__orbitFrames ?? []);
  expect(frames.length).toBeGreaterThan(5);
  expect(frames.filter((frame) => frame.armed)).toEqual([]);
  // The build really happened while it was on screen …
  expect(frames.some((frame) => frame.state === null)).toBe(true);
  // … and every frame, before, during and after it, is the last frame: the globe and all
  // three moons.
  const all = { data: true, model: true, ui: true };
  expect(
    frames.filter(
      (frame) =>
        frame.globe !== 1 ||
        JSON.stringify(frame.moons) !== JSON.stringify(all),
    ),
  ).toEqual([]);
  // It carries on from there, into the idle loops.
  expect(
    await page.evaluate(() => window.__motion!.time('orbit')),
  ).toBeGreaterThanOrEqual(T.story);
}

test.describe('the orbit scene @desktop-chromium', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('plays the story in order: moons, typed text, pods, crews, then the loops', async ({
    page,
  }, info) => {
    await openOrbit(page);
    const texts = await page
      .locator(`${FIGURE} .orbit-col`)
      .evaluateAll((columns) =>
        columns.map((column) =>
          [...column.querySelectorAll('.typed')].map(
            (twin) => twin.textContent ?? '',
          ),
        ),
      );
    // When each column's lines finish (orbit.ts types `what` 650 ms after its moon pops, then
    // `who` 120 ms after `what` ends), from the same cadence the page uses.
    const pops = [800, 7200, 14000];
    const ends = texts.map(([what, who], index) => {
      const a = typeFrames(what, { start: pops[index] + 650 });
      const b = typeFrames(who, { start: a[a.length - 1][0] + 120 });
      return { what: a[a.length - 1][0], who: b[b.length - 1][0] };
    });

    const shots: Record<number, Shot> = {};
    for (const t of [0, 1500, 7120, 14000, 21400, 23300, 32000, 40000]) {
      await seek(page, t);
      shots[t] = await page.evaluate(snapshot);
      await info.attach(`orbit-1440-t${t}`, {
        body: await page.locator(FIGURE).screenshot(),
        contentType: 'image/png',
      });
    }
    const shown = (t: number) =>
      KINDS.filter((kind) => shots[t].moons[kind].shown);
    const typed = (t: number, column: number, line: number) =>
      shots[t].columns[column].typed[line];

    expect(shots[0].layout).toBe('desktop');
    // 0 ms: the globe and its orbit, no moon yet, every column waiting, nothing typed.
    expect(shown(0)).toEqual([]);
    expect(shots[0].globe.opacity).toBe(1);
    for (const column of shots[0].columns) {
      expect(column.title).toBe(FAINT);
      expect(column.typed.map((line) => line.n)).toEqual([0, 0]);
    }
    // What shows is what is typed, at every moment (the chunked reveal, contribute.css).
    for (const t of Object.keys(shots).map(Number))
      for (const column of shots[t].columns)
        for (const line of column.typed)
          expect(line.shown, `${column.id} at ${t} ms`).toBe(
            Math.min(line.n, line.length),
          );
    // 1.5 s: the Data moon is in; its column is lit and typing.
    expect(shown(1500)).toEqual(['data']);
    expect(shots[1500].globe.opacity).toBe(1);
    expect(shots[1500].columns[0].title).toBe(STARLIGHT);
    expect(typed(1500, 0, 0).n).toBeGreaterThan(0);
    expect(typed(1500, 0, 0).n).toBeLessThan(10);
    expect(shots[1500].columns[1].title).toBe(FAINT);
    expect(typed(1500, 1, 0).n).toBe(0);
    // 7.12 s: column 1 is typed; the Modeling moon is about to come.
    expect(ends[0].who).toBeLessThanOrEqual(7130);
    expect(typed(7120, 0, 0).n).toBe(typed(7120, 0, 0).length + 1);
    expect(typed(7120, 0, 1).n).toBeGreaterThanOrEqual(
      typed(7120, 0, 1).length,
    );
    expect(shown(7120)).toEqual(['data']);
    expect(typed(7120, 1, 0).n).toBe(0);
    // 14 s: Modeling is in and typed; the UI moon starts its pop.
    expect(shown(14000)).toEqual(['data', 'model']);
    expect(typed(14000, 1, 1).n).toBeGreaterThanOrEqual(
      typed(14000, 1, 1).length,
    );
    expect(typed(14000, 2, 0).n).toBe(0);
    expect(shots[14000].columns[2].title).toBe(FAINT);
    // 21.4 s: every text typed; the Data pod touches down on its moon, its crew still inside.
    expect(shown(21400)).toEqual(['data', 'model', 'ui']);
    expect(ends[2].who).toBeLessThan(21400);
    for (let column = 0; column < 3; column += 1)
      expect(typed(21400, column, 1).n).toBe(
        typed(21400, column, 1).length + 1,
      );
    const pod = shots[21400].moons.data.ship;
    expect(pod.opacity).toBe(1);
    expect(Math.abs(pod.bottom - shots[21400].moons.data.top)).toBeLessThan(12);
    expect(Math.abs(pod.x - shots[21400].moons.data.x)).toBeLessThan(12);
    expect(shots[21400].crews.A1.opacity).toBe(0);
    expect(shots[21400].crews.A6.opacity).toBe(0);
    // 23.3 s: A1 and A6 are out, standing on top of the Data moon; the Modeling pod comes in.
    for (const id of ['A1', 'A6'] as const) {
      const crew = shots[23300].crews[id];
      const moon = shots[23300].moons.data;
      expect(crew.opacity, id).toBe(1);
      expect(crew.bottom, id).toBeLessThan(moon.y);
      expect(crew.x, id).toBeGreaterThan(moon.left);
      expect(crew.x, id).toBeLessThan(moon.right);
    }
    expect(shots[23300].moons.model.ship.opacity).toBe(1);
    expect(shots[23300].crews.A5.opacity).toBe(0);
    // 32 s: the story's end: six astronauts at work, the pods gone, every column lit.
    for (const [id, crew] of Object.entries(shots[32000].crews))
      expect(crew.opacity, id).toBe(1);
    for (const kind of KINDS)
      expect(shots[32000].moons[kind].ship.opacity, kind).toBe(0);
    for (const column of shots[32000].columns) {
      expect(column.title, column.id).toBe(STARLIGHT);
      expect(column.link, column.id).toBe(ION);
    }
    // 40 s: one idle loop on, the orbit has carried every moon 12° on (240 s a revolution),
    // counterclockwise on screen; the crews are still at work.
    const angle = (t: number, kind: (typeof KINDS)[number]) => {
      const shot = shots[t];
      const moon = viewBoxUnits(shot, shot.moons[kind]);
      const globe = viewBoxUnits(shot, shot.globe);
      // The orbit is an ellipse (Rx 460, Ry 172): undo the squash before taking the angle.
      return (
        (Math.atan2((moon.y - globe.y) / 172, (moon.x - globe.x) / 460) * 180) /
        Math.PI
      );
    };
    for (const kind of KINDS) {
      let turned = angle(40000, kind) - angle(32000, kind);
      if (turned > 180) turned -= 360;
      if (turned < -180) turned += 360;
      expect(turned, kind).toBeCloseTo(-12, 0);
    }
    for (const [id, crew] of Object.entries(shots[40000].crews))
      expect(crew.opacity, id).toBe(1);
  });

  test('starts the story once its stage and the top of its columns show, and pauses it off screen', async ({
    page,
  }) => {
    // A short window: at the top only the stage's top shows, and none of the columns.
    await page.setViewportSize({ width: 1440, height: 520 });
    await openOrbit(page);
    const figure = page.locator(FIGURE);
    /** The bottom of the columns' status line ("Group forming"), from the viewport's top. */
    const headBottom = () =>
      figure
        .locator('.orbit-col__status')
        .first()
        .evaluate((status) => status.getBoundingClientRect().bottom);
    expect(await headBottom()).toBeGreaterThan(520);
    await page.waitForTimeout(1200);
    await expect(figure).toHaveAttribute('data-scene-state', 'armed');
    expect(await page.evaluate(() => window.__motion!.time('orbit'))).toBe(0);
    // The columns' heads 10 px below the screen's edge: still waiting, though most of the stage
    // shows.
    await page.evaluate(
      (by) => window.scrollBy({ top: by, behavior: 'instant' }),
      (await headBottom()) - 530,
    );
    await page.waitForTimeout(600);
    await expect(figure).toHaveAttribute('data-scene-state', 'armed');
    // 10 px above it: the story starts.
    await page.evaluate(() =>
      window.scrollBy({ top: 20, behavior: 'instant' }),
    );
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
    await page.waitForTimeout(600);
    expect(
      await page.evaluate(() => window.__motion!.time('orbit')),
    ).toBeGreaterThan(300);
    const states = () =>
      figure.evaluate((element) => [
        ...new Set(
          document
            .getAnimations()
            .filter((animation) => {
              const target = (animation.effect as KeyframeEffect | null)
                ?.target;
              return target instanceof Element && element.contains(target);
            })
            .map((animation) => animation.playState),
        ),
      ]);
    expect(await states()).toContain('running');
    // Scrolled away, every animation in the scene pauses; back in view, it carries on.
    await page.evaluate(() =>
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'instant',
      }),
    );
    await expect(figure).toHaveAttribute('data-scene-state', 'paused');
    expect(await states()).toEqual(['paused']);
    // A Web Animation's pause takes hold on the next frame: read the clock once it has.
    await page.waitForTimeout(100);
    const pausedAt = await page.evaluate(() => window.__motion!.time('orbit'));
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__motion!.time('orbit'))).toBe(
      pausedAt,
    );
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
    expect(await states()).toContain('running');
  });

  test('pauses on its white Pause icon until Play, and Replay starts over', async ({
    page,
  }) => {
    await openOrbit(page);
    const figure = page.locator(FIGURE);
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    const toggle = page.getByRole('button', {
      name: 'Pause the orbit animation',
    });
    const replay = page.getByRole('button', {
      name: 'Replay the orbit animation',
    });
    await expect(toggle).toBeVisible();
    await expect(replay).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // A glyph, no background and no visible label (ruling 22).
    const look = await toggle.evaluate((button) => ({
      background: getComputedStyle(button).backgroundColor,
      // Visible text: everything but the visually hidden name.
      text: [...button.querySelectorAll('*'), button]
        .flatMap((element) => [...element.childNodes])
        .filter(
          (node) =>
            node.nodeType === Node.TEXT_NODE &&
            node.nodeValue?.trim() &&
            !node.parentElement?.closest('.visually-hidden'),
        )
        .map((node) => node.nodeValue!.trim())
        .join(''),
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
    }));
    expect(look.background).toBe('rgba(0, 0, 0, 0)');
    expect(look.text).toBe('');
    expect(look.width).toBeGreaterThanOrEqual(44);
    expect(look.height).toBeGreaterThanOrEqual(44);

    await page.waitForTimeout(2500);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(figure).toHaveAttribute('data-scene-state', 'paused');
    // A Web Animation's pause takes hold on the next frame: read the clock once it has.
    await page.waitForTimeout(100);
    const at = await page.evaluate(() => window.__motion!.time('orbit'));
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.__motion!.time('orbit'))).toBe(at);
    // Still paused after leaving and coming back: the visitor's Pause is sticky.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await page.waitForTimeout(300);
    await expect(figure).toHaveAttribute('data-scene-state', 'paused');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
    await page.waitForTimeout(400);
    expect(
      await page.evaluate(() => window.__motion!.time('orbit')),
    ).toBeGreaterThan(at);

    await replay.click();
    await page.waitForTimeout(100);
    expect(
      await page.evaluate(() => window.__motion!.time('orbit')),
    ).toBeLessThan(700);
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
  });

  // Design critique of the integrated build: the first screen showed an empty starry box, so the
  // armed first paint draws the globe and its orbit. Round 2: the story then played from the load,
  // and column 1 typed below the fold while the visitor looked at the stage; it now waits until the
  // whole stage and the top of its text columns show together, with the plate's Pause above them,
  // so the visitor sees each moon arrive and its text type below it.
  for (const [width, height] of [
    [1440, 900],
    [1366, 768],
    [1280, 800],
  ] as const)
    test(`waits on its globe and orbit until the stage and the top of its columns show, at ${width}×${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(() => {
        const paints: { state: string | null; globe: number; moons: number }[] =
          [];
        (window as unknown as { __armedPaints: typeof paints }).__armedPaints =
          paints;
        const sample = () => {
          const figure = document.querySelector('[data-graphic="orbit"]');
          const svg = [
            ...(figure?.querySelectorAll<SVGSVGElement>('.orbit-svg') ?? []),
          ].find((item) => item.getClientRects().length > 0);
          const globe = svg?.querySelector('.globe');
          if (
            figure &&
            svg &&
            globe &&
            figure.getAttribute('data-scene-state') !== 'playing'
          )
            paints.push({
              state: figure.getAttribute('data-scene-state'),
              globe: Number(getComputedStyle(globe).opacity),
              moons: [
                ...svg.querySelectorAll(
                  '.orbiter--moon .moon > circle:nth-of-type(2)',
                ),
              ].filter((disc) => disc.getBoundingClientRect().width > 2).length,
            });
          if (performance.now() < 3000) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.goto('/contribute/');
      await page.evaluate(() => document.fonts.ready);
      const figure = page.locator(FIGURE);
      await expect(figure).toHaveAttribute('data-scene-state', 'armed');
      await page.waitForTimeout(1500);
      // Until then: the globe and its orbit, no moon, the clock at 0.
      await expect(figure).toHaveAttribute('data-scene-state', 'armed');
      expect(await page.evaluate(() => window.__motion!.time('orbit'))).toBe(0);
      const armed = await page.evaluate(
        () =>
          (
            window as unknown as {
              __armedPaints: { globe: number; moons: number }[];
            }
          ).__armedPaints,
      );
      expect(armed.length).toBeGreaterThan(0);
      expect(
        armed.filter((paint) => paint.globe !== 1 || paint.moons > 0),
      ).toEqual([]);
      /** Where the plate stands on screen, below the site's header. */
      const where = () =>
        page.evaluate(() => {
          const element = document.querySelector('[data-graphic="orbit"]')!;
          const box = (selector: string) =>
            element.querySelector(selector)!.getBoundingClientRect();
          const toggle = box('[data-scene-toggle]');
          return {
            state: element.getAttribute('data-scene-state'),
            header: document
              .querySelector('[data-site-header]')!
              .getBoundingClientRect().bottom,
            stage: box('[data-figure-stage]').toJSON(),
            head: box('.orbit-col__status').bottom,
            toggle: toggle.top + toggle.height / 2,
          };
        });
      // Scrolled down a wheel notch at a time, the story starts once the columns' heads show, and
      // then the whole stage shows above them, with the plate's Pause.
      await page.mouse.move(width / 2, height / 2);
      let at = await where();
      for (let step = 0; at.state === 'armed' && step < 40; step++) {
        await page.mouse.wheel(0, 40);
        await page.waitForTimeout(150);
        at = await where();
      }
      expect(at.state).toBe('playing');
      expect(at.head).toBeLessThanOrEqual(height);
      expect(at.stage.top).toBeGreaterThanOrEqual(at.header - 1);
      expect(at.stage.bottom).toBeLessThanOrEqual(height);
      expect(at.toggle).toBeGreaterThan(at.header);
      // The first moon arrives on screen while its column types under it.
      await expect
        .poll(() => page.evaluate(() => window.__motion!.time('orbit')))
        .toBeGreaterThan(2600);
      const shot = await page.evaluate(snapshot);
      expect(shot.moons.data.shown).toBe(true);
      expect(shot.moons.data.top).toBeGreaterThanOrEqual(at.header);
      expect(shot.moons.data.bottom).toBeLessThanOrEqual(height);
      expect(shot.columns[0].typed[0].shown).toBeGreaterThan(0);
    });

  test('never paints its last frame above the fold and then empties it', async ({
    page,
  }) => {
    // Only the stage's top on the first screen, so the scene waits there, armed.
    await page.setViewportSize({ width: 1440, height: 520 });
    await page.addInitScript(() => {
      const paints: NonNullable<Window['__orbitPaints']> = [];
      window.__orbitPaints = paints;
      const sample = () => {
        const figure = document.querySelector('[data-graphic="orbit"]');
        const svg = [
          ...(figure?.querySelectorAll<SVGSVGElement>('.orbit-svg') ?? []),
        ].find((item) => item.getClientRects().length > 0);
        const disc = svg?.querySelector(
          '.orbiter--moon[data-moon="data"] .moon > circle:nth-of-type(2)',
        );
        if (figure && disc)
          paints.push({
            state: figure.getAttribute('data-scene-state'),
            moon: disc.getBoundingClientRect().width > 2,
          });
        if (performance.now() < 4000) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto('/contribute/');
    await expect(page.locator(FIGURE)).toHaveAttribute(
      'data-scene-state',
      'armed',
    );
    await page.waitForTimeout(800);
    const paints = await page.evaluate(() => window.__orbitPaints ?? []);
    expect(paints.length).toBeGreaterThan(5);
    // Armed before its first paint and still waiting for the visitor: no moon has shown.
    expect(paints.filter((paint) => paint.moon)).toEqual([]);
  });

  test('stays armed on a slow device whose scene builds after the 1.2 s check', async ({
    page,
  }) => {
    // A slow phone (review of T4, finding 2): the module has loaded, but the scene's tracks are
    // still being created when the head script looks at 1,200 ms. Idle callbacks wait until
    // 1.6 s here, so the build ends well after that check. Only the stage's top shows, so the
    // scene then waits, armed.
    await page.setViewportSize({ width: 1440, height: 520 });
    await page.addInitScript(() => {
      const idle = window.requestIdleCallback.bind(window);
      window.requestIdleCallback = (callback, options) =>
        performance.now() < 1600
          ? window.setTimeout(
              () => callback({ didTimeout: true, timeRemaining: () => 0 }),
              1600 - performance.now(),
            )
          : idle(callback, options);
      const paints: NonNullable<Window['__orbitPaints']> = [];
      window.__orbitPaints = paints;
      const sample = () => {
        const figure = document.querySelector('[data-graphic="orbit"]');
        const svg = [
          ...(figure?.querySelectorAll<SVGSVGElement>('.orbit-svg') ?? []),
        ].find((item) => item.getClientRects().length > 0);
        const disc = svg?.querySelector(
          '.orbiter--moon[data-moon="data"] .moon > circle:nth-of-type(2)',
        );
        if (figure && disc)
          paints.push({
            state: figure.getAttribute('data-scene-state'),
            moon: disc.getBoundingClientRect().width > 2,
          });
        if (performance.now() < 3500) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto('/contribute/');
    await expect(page.locator(FIGURE)).toHaveAttribute(
      'data-scene-state',
      'armed',
      { timeout: 6000 },
    );
    await page.waitForTimeout(800);
    const paints = await page.evaluate(() => window.__orbitPaints ?? []);
    // The build really did outlast the head script's check …
    expect(paints.some((paint) => paint.state === null)).toBe(true);
    expect(
      await page.evaluate(() =>
        document.documentElement.hasAttribute('data-arm-orbit'),
      ),
    ).toBe(true);
    // … and the stage stayed empty all along: no last frame painted, then emptied.
    expect(paints.filter((paint) => paint.moon)).toEqual([]);
  });

  test('rests on the last frame it painted when the page arrives after the 1.2 s check', ({
    page,
  }) => lateArrival(page));

  test('carries on across a layout switch, its state and clock intact', async ({
    page,
  }) => {
    await openOrbit(page);
    const figure = page.locator(FIGURE);
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
    const look = () =>
      page.evaluate(() => {
        const element = document.querySelector('[data-graphic="orbit"]')!;
        const svg = [
          ...element.querySelectorAll<SVGSVGElement>('.orbit-svg'),
        ].find((item) => item.getClientRects().length > 0)!;
        const animations = document.getAnimations().filter((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          return target instanceof Element && svg.contains(target);
        });
        return {
          layout: svg.dataset.layout,
          state: element.getAttribute('data-scene-state'),
          built: animations.length,
          running: animations.filter(
            (animation) => animation.playState === 'running',
          ).length,
          time: window.__motion!.time('orbit'),
        };
      });
    // A rotated tablet, then a phone (review of T4, finding 6): the scene rebuilds on the layout
    // now drawn, at the same moment, and its state says what it is doing.
    let before = await look();
    for (const [width, height, layout] of [
      [900, 1000, 'tablet'],
      [390, 844, 'phone'],
    ] as const) {
      await page.waitForTimeout(1500);
      await page.setViewportSize({ width, height });
      await expect.poll(async () => (await look()).layout).toBe(layout);
      await expect
        .poll(async () => (await look()).built, { timeout: 5000 })
        .toBeGreaterThan(20);
      await page.waitForTimeout(500);
      const after = await look();
      expect(after.running, layout).toBeGreaterThan(20);
      expect(after.state, layout).toBe('playing');
      expect(after.time, layout).toBeGreaterThan(before.time);
      before = after;
    }
    // Paused by the visitor, a switch keeps it paused.
    await page
      .getByRole('button', { name: 'Pause the orbit animation' })
      .click();
    await expect(figure).toHaveAttribute('data-scene-state', 'paused');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await look()).layout).toBe('desktop');
    await expect
      .poll(async () => (await look()).built, { timeout: 5000 })
      .toBeGreaterThan(20);
    await page.waitForTimeout(500);
    expect(await look()).toMatchObject({ state: 'paused', running: 0 });
  });

  test('paints only the moment on screen while it switches layout', async ({
    page,
  }) => {
    // Review of T4 round 2, finding 2: a switch rebuilds the tracks on the newly drawn layout,
    // and until they exist it paints whatever it holds. It must hold the moment on screen, never
    // the story's start (an empty stage) or the server's last frame (every moon, every column
    // typed).
    await openOrbit(page);
    const figure = page.locator(FIGURE);
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
    const tablet = async () =>
      (await page.evaluate(() => window.__orbitFrames ?? [])).filter(
        (frame) => frame.layout === 'tablet',
      );

    // In the story, played (not sought): a few seconds in, the globe is up and only Data's moon
    // has arrived; the UI column still waits, nothing typed.
    await expect
      .poll(() => page.evaluate(() => window.__motion!.time('orbit')))
      .toBeGreaterThan(T.dataMoon + 1500);
    await page.evaluate(recordFrames, 2500);
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.waitForTimeout(2600);
    let frames = await tablet();
    expect(frames.length).toBeGreaterThan(5);
    expect(
      frames.filter(
        (frame) =>
          frame.globe !== 1 ||
          JSON.stringify(frame.moons) !==
            JSON.stringify({ data: true, model: false, ui: false }) ||
          frame.ui.wait !== 1 ||
          frame.ui.typed !== 0,
      ),
    ).toEqual([]);
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');

    // In the idle loops, the moons keep to their orbits: Data's moon never jumps to its resting
    // place and back (the orbit moves it about 0.1 viewBox units a frame).
    await page.setViewportSize({ width: 1440, height: 900 });
    await seek(page, 60000);
    // Sought, the scene is paused (its toggle pressed): press again to play.
    const toggle = page.getByRole('button', {
      name: 'Pause the orbit animation',
    });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
    await page.waitForTimeout(1000);
    await page.evaluate(recordFrames, 2000);
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.waitForTimeout(2100);
    frames = await tablet();
    expect(frames.length).toBeGreaterThan(5);
    const jumps = frames
      .slice(1)
      .map((frame, i) => ({
        from: frames[i].data,
        to: frame.data,
        by: Math.hypot(
          frame.data.x - frames[i].data.x,
          frame.data.y - frames[i].data.y,
        ),
      }))
      .filter((step) => step.by > 3);
    expect(jumps).toEqual([]);
  });

  /** Every column's typed lines in full. */
  const allTyped = (page: Page) =>
    page
      .evaluate(snapshot)
      .then(({ columns }) =>
        columns.every(({ typed }) =>
          typed.every((line) => line.shown === line.length),
        ),
      );

  /** Wheel down from the top of the page to the Data column (header clear), in under 2 s. */
  async function readOn(page: Page) {
    const target = await page
      .locator('#group-data')
      .evaluate((column) => column.getBoundingClientRect().top + scrollY - 90);
    const started = Date.now();
    await page.mouse.move(720, 450);
    for (let y = 0; y < target; y += 300) {
      await page.mouse.wheel(0, Math.min(300, target - y));
      await page.waitForTimeout(60);
    }
    await expect
      .poll(() => page.evaluate(() => scrollY))
      .toBeGreaterThan(target - 40);
    expect(Date.now() - started).toBeLessThan(2000);
  }

  // Design critique of the integrated build, round 2: wheeling from the top down to the columns at
  // 1.5 s, the stage scrolled away under the header and the story ran on out of sight, Modeling's
  // column blank until about 8 s and UI's until about 15 s, each with only "Group forming" and a
  // caret. Reading on into the columns now takes the story to its end: every column typed.
  test('reading on into the columns mid-story finds every column typed within a second', async ({
    page,
  }) => {
    await openOrbit(page);
    const figure = page.locator(FIGURE);
    await page.waitForTimeout(1500);
    await readOn(page);
    await expect.poll(() => allTyped(page), { timeout: 1000 }).toBe(true);
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
    expect(
      await page.evaluate(() => window.__motion!.time('orbit')),
    ).toBeGreaterThanOrEqual(T.story);
    // Back up at the stage the crews work in the idle loops, and Replay plays the story again.
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' }),
    );
    await page
      .getByRole('button', { name: 'Replay the orbit animation' })
      .click();
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() => window.__motion!.time('orbit')),
    ).toBeLessThan(T.story);
  });

  test('paused mid-story, reading on into the columns shows them typed and stays paused', async ({
    page,
  }) => {
    await openOrbit(page);
    const figure = page.locator(FIGURE);
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' }),
    );
    await expect(figure).toHaveAttribute('data-scene-state', 'playing');
    await expect
      .poll(() => page.evaluate(() => window.__motion!.time('orbit')))
      .toBeGreaterThan(T.dataMoon + 1000);
    const toggle = page.getByRole('button', {
      name: 'Pause the orbit animation',
    });
    await toggle.click();
    await expect(figure).toHaveAttribute('data-scene-state', 'paused');
    expect(await allTyped(page)).toBe(false);
    await page
      .locator('#group-modeling')
      .evaluate((column) =>
        column.scrollIntoView({ block: 'start', behavior: 'instant' }),
      );
    await expect.poll(() => allTyped(page), { timeout: 1000 }).toBe(true);
    await expect(figure).toHaveAttribute('data-scene-state', 'paused');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(100);
    const at = await page.evaluate(() => window.__motion!.time('orbit'));
    expect(at).toBeGreaterThanOrEqual(T.story);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__motion!.time('orbit'))).toBe(at);
  });

  test('takes its own layout on a tablet, labels at 13 px or more', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/contribute/');
    await page.evaluate(() => document.fonts.ready);
    const drawn = await page
      .locator(`${FIGURE} .orbit-svg`)
      .evaluateAll((svgs) =>
        svgs
          .filter((svg) => svg.getClientRects().length > 0)
          .map((svg) => (svg as SVGSVGElement).dataset.layout),
      );
    expect(drawn).toEqual(['tablet']);
    const sizes = await page
      .locator(`${FIGURE} .orbit-svg--tablet .moon-label`)
      .evaluateAll((labels) =>
        labels.map((label) => {
          const matrix = (label as SVGTextElement).getScreenCTM()!;
          return (
            Number.parseFloat(getComputedStyle(label).fontSize) *
            Math.hypot(matrix.a, matrix.b)
          );
        }),
      );
    expect(sizes).toHaveLength(3);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(13);
  });
});

for (const { width, height, layout } of [
  { width: 1440, height: 900, layout: 'desktop' },
  { width: 900, height: 1000, layout: 'tablet' },
])
  test.describe(`the orbit all the way round at ${width} px @desktop-chromium`, () => {
    test.use({ viewport: { width, height } });

    test('keeps every label that shows clear, and every crew inside its footprint', async ({
      page,
    }) => {
      await openOrbit(page);
      expect(await page.evaluate(snapshot)).toMatchObject({ layout });
      // From the story's start to the end of a full revolution of the idle loops, every second.
      expect(
        await page.evaluate(sweep, {
          footprint: FOOTPRINT,
          story: T.story,
          until: T.story + T.orbit,
          step: 1000,
        }),
      ).toEqual([]);
    });
  });

/**
 * The plate on one screen (owner, 2026-10-15: "maybe 20% less tall so we can fit both the graphics
 * and text panels on the screen at once"): scrolled to the plate, under the site's compact header,
 * its bar, its whole stage and its three columns down to their links show on a laptop screen; on a
 * short one (1366 × 768, 1280 × 800) the bar, the stage and every line the columns type. The moon
 * labels stay 13 px or more at every size.
 */
test.describe('the orbit plate on one screen @desktop-chromium', () => {
  for (const [width, height, last] of [
    [1440, 900, 'link'],
    [1920, 1080, 'link'],
    [1512, 982, 'link'],
    [1728, 1117, 'link'],
    [1366, 768, 'typed line'],
    [1280, 800, 'typed line'],
  ] as const)
    test(`shows the bar to the last ${last} under the compact header at ${width}×${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/contribute/');
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() =>
        window.scrollTo({ top: 200, behavior: 'instant' }),
      );
      await expect(page.locator('[data-site-header]')).toHaveClass(
        /site-header--compact/,
      );
      // The header's resize settles.
      await page.waitForTimeout(500);
      const fit = await page.locator(FIGURE).evaluate(
        (figure, selector) => {
          const header = document
            .querySelector('[data-site-header]')!
            .getBoundingClientRect().bottom;
          window.scrollTo({
            top: figure.getBoundingClientRect().top + scrollY - header,
            behavior: 'instant',
          });
          const bar = figure
            .querySelector('.orbit__bar')!
            .getBoundingClientRect();
          const bottom = Math.max(
            ...[...figure.querySelectorAll(selector)].map(
              (element) => element.getBoundingClientRect().bottom,
            ),
          );
          const svg = [
            ...figure.querySelectorAll<SVGSVGElement>('.orbit-svg'),
          ].find((item) => item.getClientRects().length > 0)!;
          return {
            layout: svg.dataset.layout,
            top: bar.top - header,
            height: bottom - bar.top,
            room: innerHeight - header,
            labels: [
              ...svg.querySelectorAll<SVGTextElement>('.moon-label'),
            ].map((label) => {
              const matrix = label.getScreenCTM()!;
              return (
                Number.parseFloat(getComputedStyle(label).fontSize) *
                Math.hypot(matrix.a, matrix.b)
              );
            }),
          };
        },
        last === 'link' ? '.orbit-col__link' : '.orbit-col__who',
      );
      expect(fit.layout).toBe('desktop');
      // The plate's top meets the header (the bar starts under its 1 px frame; scrolling rounds).
      expect(Math.abs(fit.top)).toBeLessThan(2);
      expect(fit.height).toBeLessThanOrEqual(fit.room);
      expect(fit.labels).toHaveLength(3);
      for (const size of fit.labels) expect(size).toBeGreaterThanOrEqual(13);
    });
});

test.describe('the orbit scene under reduced motion', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('builds nothing and shows the story’s last frame with every word', async ({
    page,
    isMobile,
  }, info) => {
    await page.goto('/contribute/');
    await page.evaluate(() => document.fonts.ready);
    const figure = page.locator(FIGURE);
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await page.waitForTimeout(1200);
    expect(
      await figure.evaluate(
        (element) =>
          document.getAnimations().filter((animation) => {
            const target = (animation.effect as KeyframeEffect | null)?.target;
            return target instanceof Element && element.contains(target);
          }).length,
      ),
    ).toBe(0);
    await expect(figure.locator('[data-scene-toggle]')).toBeHidden();
    await expect(figure.locator('[data-scene-replay]')).toBeHidden();
    const shot = await page.evaluate(snapshot);
    expect(KINDS.filter((kind) => shot.moons[kind].shown)).toEqual([
      'data',
      'model',
      'ui',
    ]);
    for (const [id, crew] of Object.entries(shot.crews))
      expect(crew.opacity, id).toBe(1);
    for (const column of shot.columns) {
      expect(column.title, column.id).toBe(STARLIGHT);
      expect(column.link, column.id).toBe(ION);
      // Every character of every typed line shows.
      for (const line of column.typed)
        expect(line.n, column.id).toBeGreaterThan(line.length);
    }
    for (const id of COLUMNS)
      await expect(
        page.locator(`#${id}`).getByRole('link', {
          name: 'Browse matching issues',
        }),
      ).toBeVisible();
    // Phones add a close-up of each moon above its text; wider layouts do not need one.
    const closeUps = page.locator(`${FIGURE} .orbit-col__shot`);
    if (isMobile) {
      expect(shot.layout).toBe('phone');
      for (let index = 0; index < 3; index += 1)
        await expect(closeUps.nth(index)).toBeVisible();
    } else {
      expect(shot.layout).toBe('desktop');
      await expect(closeUps.first()).toBeHidden();
    }
    await info.attach(`orbit-reduced-${isMobile ? 'phone' : 'desktop'}`, {
      body: await figure.screenshot(),
      contentType: 'image/png',
    });
  });
});

test.describe('the orbit scene in forced colours', () => {
  test('stops at the story’s last frame and builds nothing', async ({
    page,
  }) => {
    // Spec §8.9: in forced colours, scenes show their end state (review of T4, finding 7).
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/contribute/');
    await page.evaluate(() => document.fonts.ready);
    const figure = page.locator(FIGURE);
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await page.waitForTimeout(1500);
    expect(
      await page.evaluate(() =>
        document.documentElement.hasAttribute('data-arm-orbit'),
      ),
    ).toBe(false);
    expect(
      await figure.evaluate(
        (element) =>
          document.getAnimations().filter((animation) => {
            const target = (animation.effect as KeyframeEffect | null)?.target;
            return target instanceof Element && element.contains(target);
          }).length,
      ),
    ).toBe(0);
    await expect(figure.locator('[data-scene-toggle]')).toBeHidden();
    await expect(figure.locator('[data-scene-replay]')).toBeHidden();
    const shot = await page.evaluate(snapshot);
    expect(KINDS.filter((kind) => shot.moons[kind].shown)).toEqual([
      'data',
      'model',
      'ui',
    ]);
    for (const [id, crew] of Object.entries(shot.crews))
      expect(crew.opacity, id).toBe(1);
    for (const column of shot.columns)
      for (const line of column.typed)
        expect(line.n, column.id).toBeGreaterThan(line.length);
  });
});

test.describe('the orbit scene on a phone @mobile-chromium', () => {
  test('rests on the last frame it painted when the page arrives after the 1.2 s check', ({
    page,
  }) => lateArrival(page));

  test('closes in on each landing, labels hidden, then pulls back', async ({
    page,
  }, info) => {
    await openOrbit(page);
    const scale = (transform: string) => {
      const match = transform.match(/^matrix\(([-\d.e]+),/);
      return match ? Number(match[1]) : 1;
    };
    for (const t of [14000, 21400, 24600, 28000, 32000]) {
      await seek(page, t);
      const shot = await page.evaluate(snapshot);
      expect(shot.layout).toBe('phone');
      await info.attach(`orbit-phone-t${t}`, {
        body: await page.locator(FIGURE).screenshot(),
        contentType: 'image/png',
      });
      if (t === 14000 || t === 32000) {
        expect(scale(shot.camera), `${t}`).toBeCloseTo(1, 1);
        expect(shot.labels, `${t}`).toBe(1);
      } else {
        expect(scale(shot.camera), `${t}`).toBeCloseTo(2.05, 1);
        expect(shot.labels, `${t}`).toBe(0);
      }
    }
    // At the Data landing the close-up frames the pod on its moon.
    await seek(page, 21400);
    const shot = await page.evaluate(snapshot);
    const pod = shot.moons.data.ship;
    expect(pod.x).toBeGreaterThan(shot.svg.left);
    expect(pod.x).toBeLessThan(shot.svg.right);
    expect(pod.top).toBeGreaterThan(shot.svg.top);
  });

  // Design critique of the integrated build: on a phone the camera showed the Modeling and the UI
  // moon arriving while the text under the stage was still Data's, groups 2 and 3 typing 400–900 px
  // further down. Under the stage is one panel, the group being introduced: each moon's arrival,
  // then each landing as the camera closes in; every column stays in the DOM, and at the story's
  // end all three stack.
  test('types each group in one panel under the stage, in step with the camera', async ({
    page,
  }) => {
    await openOrbit(page);
    const look = () =>
      page.evaluate(() => {
        const figure = document.querySelector('[data-graphic="orbit"]')!;
        const stage = figure
          .querySelector('[data-figure-stage]')!
          .getBoundingClientRect();
        return {
          stageBottom: stage.bottom,
          panel: figure.querySelector('.orbit__cols')!.getBoundingClientRect()
            .height,
          columns: [...figure.querySelectorAll<HTMLElement>('.orbit-col')].map(
            (column) => ({
              id: column.id,
              shown: getComputedStyle(column).opacity === '1',
              top: column.getBoundingClientRect().top,
              text: (column.textContent ?? '').length,
            }),
          ),
        };
      });
    const panels: [number, string][] = [
      [3000, 'group-data'],
      [9000, 'group-modeling'],
      [16000, 'group-ui'],
      [21000, 'group-data'],
      [24500, 'group-modeling'],
      [28000, 'group-ui'],
    ];
    let height = 0;
    for (const [t, id] of panels) {
      await seek(page, t);
      const now = await look();
      const shown = now.columns.filter((column) => column.shown);
      expect(
        shown.map((column) => column.id),
        `${t} ms`,
      ).toEqual([id]);
      // Right under the stage, one cell for all three, its height the same at every switch.
      expect(shown[0].top, `${t} ms`).toBeCloseTo(now.stageBottom, 0);
      for (const column of now.columns) {
        expect(column.top, `${t} ms`).toBeCloseTo(shown[0].top, 0);
        expect(column.text, `${column.id} in the DOM`).toBeGreaterThan(100);
      }
      if (height) expect(now.panel, `${t} ms`).toBeCloseTo(height, 0);
      height = now.panel;
    }
    // A keyboard reaching another group's link shows that group instead.
    await seek(page, 9000);
    await page.locator('#group-ui .orbit-col__link').focus();
    expect(
      (await look()).columns
        .filter((column) => column.shown)
        .map((column) => column.id),
    ).toEqual(['group-ui']);
    await page.locator('#group-ui .orbit-col__link').blur();
    // The story's end: all three, stacked.
    await seek(page, T.story);
    const end = await look();
    expect(end.columns.every((column) => column.shown)).toBe(true);
    expect(end.columns[1].top).toBeGreaterThan(end.columns[0].top + 100);
    expect(end.columns[2].top).toBeGreaterThan(end.columns[1].top + 100);
  });
});

/**
 * Reached by its columns (review of T4 round 3, finding 1): a link to a group's column, a reload
 * that restores the scroll to the columns, or a jump straight to them, with the stage off screen.
 * The visitor sees the text they came for at once, every word typed, and the scene rests in its
 * idle loops (Replay plays the story); it never blanks the columns to type them again out of sight.
 */
test.describe('the orbit scene reached by its columns', () => {
  /** Every column lit, every typed sentence in full, the clock past the story, the loops on. */
  async function resting(page: Page) {
    const figure = page.locator(FIGURE);
    await expect(figure).toHaveAttribute('data-scene-state', 'playing', {
      timeout: 6000,
    });
    expect(
      await page.evaluate(() => window.__motion!.time('orbit')),
    ).toBeGreaterThanOrEqual(T.story);
    const shot = await page.evaluate(snapshot);
    expect(shot.columns.map(({ id }) => id)).toEqual([...COLUMNS]);
    for (const column of shot.columns) {
      expect(column.title, column.id).toBe(STARLIGHT);
      expect(column.typed.length, column.id).toBe(2);
      for (const line of column.typed)
        expect(line.shown, column.id).toBe(line.length);
    }
    return shot;
  }

  /**
   * The browser's own scroll to the fragment or the restored position has landed: the site sets
   * scroll-behavior: smooth, so it glides there after the load event, past the stage.
   */
  async function landed(page: Page) {
    let last = -1;
    await expect
      .poll(
        async () => {
          const y = await page.evaluate(() => scrollY);
          const still = y === last;
          last = y;
          return still && y > 0;
        },
        { intervals: [250], timeout: 6000 },
      )
      .toBe(true);
  }

  /** The columns show and the stage hardly does (under 120 px below the header). */
  async function stageOffScreen(page: Page) {
    const shown = await page.evaluate(() => {
      const header = document
        .querySelector('[data-site-header]')!
        .getBoundingClientRect().bottom;
      const seen = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return Math.max(
          0,
          Math.min(box.bottom, innerHeight) - Math.max(box.top, header, 0),
        );
      };
      return {
        stage: seen('[data-graphic="orbit"] [data-figure-stage]'),
        columns: seen('[data-graphic="orbit"] .orbit__cols'),
      };
    });
    expect(shown.stage).toBeLessThan(120);
    expect(shown.columns).toBeGreaterThan(0);
  }

  for (const [link, id] of [
    ['/working-groups/#ui', 'group-ui'],
    ['/working-groups/#modeling', 'group-modeling'],
    ['/contribute/#group-data', 'group-data'],
  ] as const)
    test(`${link} shows its column’s text typed out from the first frame`, async ({
      page,
    }) => {
      await page.addInitScript(recordFrames, 4000);
      await page.goto(link);
      await expect(page).toHaveURL(new RegExp(`/contribute/#${id}$`));
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.__motion!.ready('orbit'));
      await landed(page);
      await stageOffScreen(page);
      // The head script never armed: the server's last frame, every word, painted first.
      expect(
        await page.evaluate(() =>
          document.documentElement.hasAttribute('data-arm-orbit'),
        ),
      ).toBe(false);
      const shot = await resting(page);
      // The column asked for carries the ion rule a column shows while it types (design critique
      // of the integrated build: nothing marked it).
      expect(
        await page
          .locator(`#${id}`)
          .evaluate((column) => getComputedStyle(column).boxShadow),
      ).toContain('rgb(112, 230, 255)');
      expect(
        await page
          .locator(`#${COLUMNS.find((other) => other !== id)}`)
          .evaluate((column) => getComputedStyle(column).boxShadow),
      ).toBe('none');
      // Frame by frame since the first paint, the UI column was never dimmed or untyped.
      await page.waitForTimeout(500);
      const frames = await page.evaluate(() => window.__orbitFrames ?? []);
      expect(frames.length).toBeGreaterThan(5);
      const length = shot.columns[2].typed[0].length;
      expect(
        frames.filter(
          (frame) => frame.ui.wait !== 0 || frame.ui.typed < length,
        ),
      ).toEqual([]);
    });

  test('a reload that restores the scroll to the columns keeps their text', async ({
    page,
  }) => {
    await openOrbit(page);
    const y = await page
      .locator(`${FIGURE} .orbit__cols`)
      .evaluate((columns) => {
        columns.scrollIntoView({ block: 'start', behavior: 'instant' });
        return scrollY;
      });
    expect(y).toBeGreaterThan(0);
    await page.reload();
    await page.evaluate(() => window.__motion!.ready('orbit'));
    await landed(page);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(y - 4);
    await stageOffScreen(page);
    await resting(page);
  });

  test('jumping from the top straight to the columns shows their text in full', async ({
    page,
  }) => {
    // A window short enough that at the top under 150 px of the stage shows.
    await page.setViewportSize({
      width: page.viewportSize()!.width,
      height: 520,
    });
    await openOrbit(page);
    const figure = page.locator(FIGURE);
    // At the top the scene is armed: its story has not begun.
    await expect(figure).toHaveAttribute('data-scene-state', 'armed');
    await figure
      .locator('.orbit__cols')
      .evaluate((columns) =>
        columns.scrollIntoView({ block: 'start', behavior: 'instant' }),
      );
    await stageOffScreen(page);
    await resting(page);
    // Back at the stage, Replay still plays the story from its start.
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' }),
    );
    await page
      .getByRole('button', { name: 'Replay the orbit animation' })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__motion!.time('orbit')))
      .toBeLessThan(T.story);
  });
});
