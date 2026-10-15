/**
 * Contribute's orbit scene in the browser (round 2 spec §4.3.2, §11.2; characters.md §2, §4–§5;
 * #454). Owned by the Contribute orbit and flow task (round 2 plan T4). Runs on the e2e build,
 * whose motion hooks (`window.__motion`, spec §3.4) put the scene at any moment, paused.
 *
 * - The seek table (0, 1.5, 7.12, 14, 21.4, 23.3, 32 and 40 s): the moons arrive in order, each
 *   group's text types after its moon, the pods land and the crews hop out, every column is lit
 *   at the story's end, and the orbit carries on into the idle loops. A picture of each moment is
 *   attached for the visual review.
 * - The story starts only once 35% of the figure shows; off screen every animation pauses; the
 *   Pause toggle is sticky and Replay starts over.
 * - Above the fold it never paints its last frame and then empties (spec §2.7 rule 5).
 * - Reduced motion: no animation at all, every word in full, the story's last frame; phones add
 *   a close-up of each moon above its text.
 * - Phones: the camera closes in on each landing. Tablets: their own layout.
 * - All the way round the endless idle orbit (review of T4, finding 1), on the drawn art: a moon
 *   label that shows is never covered by the globe, another moon, its crew or props, or another
 *   label; and every crew and prop stays inside the footprint the label model reckons with.
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
/** orbit-layouts.ts T: the story, and one revolution of the idle orbit, ms. */
const T = { story: 32000, orbit: 240000 } as const;
const COLUMNS = ['group-data', 'group-modeling', 'group-ui'] as const;
/** --color-faint, --color-starlight and --color-ion, as painted (snapshot's `rgb`). */
const FAINT = 'rgb(127, 147, 174)';
const STARLIGHT = 'rgb(242, 248, 255)';
const ION = 'rgb(112, 230, 255)';

declare global {
  interface Window {
    __orbitPaints?: { state: string | null; moon: boolean }[];
  }
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
      typed: [...column.querySelectorAll<HTMLElement>('.typed')].map(
        (twin) => ({
          n: Number(getComputedStyle(twin).getPropertyValue('--n')),
          length: twin.children.length,
        }),
      ),
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
    // 0 ms: an empty stage, every column waiting, nothing typed.
    expect(shown(0)).toEqual([]);
    expect(shots[0].globe.opacity).toBe(0);
    for (const column of shots[0].columns) {
      expect(column.title).toBe(FAINT);
      expect(column.typed.map((line) => line.n)).toEqual([0, 0]);
    }
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

  test('starts the story only once 35% of it shows, and pauses it off screen', async ({
    page,
  }) => {
    await openOrbit(page);
    const figure = page.locator(FIGURE);
    // At 1440 × 900 the plate opens above the fold, but less than 35% of it shows.
    await page.waitForTimeout(1200);
    await expect(figure).toHaveAttribute('data-scene-state', 'armed');
    expect(await page.evaluate(() => window.__motion!.time('orbit'))).toBe(0);
    await figure.evaluate((element) =>
      element.scrollIntoView({ block: 'center', behavior: 'instant' }),
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

  test('never paints its last frame above the fold and then empties it', async ({
    page,
  }) => {
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
    // 1.6 s here, so the build ends well after that check.
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
});
