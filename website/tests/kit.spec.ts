/**
 * The scene timeline and the astronaut rig in the browser (round 2 spec §3.2, §3.4, §11.2), on the
 * /kit/ gallery's test scene (e2e build only): A3 hops 160 units across in a 2 s story, then hops
 * in place in every 2 s loop. Scrubbed through window.__motion, never on wall-clock sleeps, except
 * where the point is real time (an offscreen pause).
 */
import { expect, test, type Page } from '@playwright/test';

import { POSES, type PoseSpec } from '../src/graphics/astro/poses';
import { solve } from '../src/graphics/astro/rig';
import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

const SCENE = '[data-graphic="kit-scene"]';

/** A joint's rotation (deg) and translation (px) as the browser computes them. */
const joint = (page: Page, selector: string) =>
  page
    .locator(`${SCENE} #kit-hopper ${selector}`)
    .first()
    .evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return {
        deg: (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI,
        x: matrix.e,
        y: matrix.f,
        sx: matrix.a,
        sy: matrix.d,
      };
    });

async function open(page: Page) {
  await page.goto('/kit/');
  await page.locator(SCENE).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.__motion!.ready('kit-scene'));
}
const seek = (page: Page, ms: number) =>
  page.evaluate((t) => window.__motion!.seek('kit-scene', t), ms);
const expected = (spec: PoseSpec) => solve('A3', spec);

test('seeking puts the astronaut’s joints at the angles its poses commit to', async ({
  page,
}) => {
  await open(page);
  // The apex of the hop across: pose "hop" at 30 units up, halfway (x 80).
  await seek(page, 670);
  const apex = expected({ ...POSES.hop, y: -30, sq: 0.02 });
  for (const name of ['sN', 'eN', 'sF', 'eF', 'hN', 'kN', 'head'] as const)
    expect((await joint(page, `.j-${name}`)).deg, name).toBeCloseTo(
      Math.round(apex[name] * 100) / 100,
      1,
    );
  const hop = await joint(page, '.j-hop');
  expect(hop.y).toBeCloseTo(-30, 1);
  expect(hop.sx).toBeCloseTo(0.98, 2);
  expect(hop.sy).toBeCloseTo(1.02, 2);
  expect((await joint(page, '.j-move')).x).toBeCloseTo(80, 1);

  // The story's end: standing at x 160.
  await seek(page, 2000);
  const stand = expected(POSES.stand);
  expect((await joint(page, '.j-sN')).deg).toBeCloseTo(stand.sN, 1);
  expect((await joint(page, '.j-hop')).y).toBeCloseTo(0, 1);
  expect((await joint(page, '.j-move')).x).toBeCloseTo(160, 1);
  await expect(page.locator(SCENE)).toHaveAttribute(
    'data-scene-state',
    'paused',
  );
});

test('the loop takes over exactly at the story’s end, and repeats', async ({
  page,
}) => {
  await open(page);
  for (const t of [2000 + 870, 4000 + 870]) {
    await seek(page, t);
    // The loop's hop in place peaks 18 units up, where the story left the astronaut (x 160).
    expect((await joint(page, '.j-hop')).y, `${t}`).toBeCloseTo(-18, 1);
    expect((await joint(page, '.j-move')).x, `${t}`).toBeCloseTo(160, 1);
  }
  await seek(page, 2000 + 100);
  expect((await joint(page, '.j-hop')).y).toBeCloseTo(0, 1);
});

test('a scene paused off screen resumes where it was, never replaying its story', async ({
  page,
}) => {
  await open(page);
  // Real time: let the story play into the loops.
  await expect
    .poll(() => page.evaluate(() => window.__motion!.time('kit-scene')), {
      timeout: 8_000,
    })
    .toBeGreaterThan(2300);
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(page.locator(SCENE)).toHaveAttribute(
    'data-scene-state',
    'paused',
  );
  const paused = await page.evaluate(() => window.__motion!.time('kit-scene'));
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__motion!.time('kit-scene'))).toBe(
    paused,
  );
  await page.locator(SCENE).scrollIntoViewIfNeeded();
  await expect(page.locator(SCENE)).toHaveAttribute(
    'data-scene-state',
    'playing',
  );
  const resumed = await page.evaluate(() => window.__motion!.time('kit-scene'));
  expect(resumed).toBeGreaterThanOrEqual(paused);
  // Still standing where the story left it: the story was not played again.
  expect((await joint(page, '.j-move')).x).toBeCloseTo(160, 0);
});

test('the controls pause, play and replay, and say what they act on', async ({
  page,
}) => {
  await open(page);
  const toggle = page.getByRole('button', { name: 'Pause the test animation' });
  const replay = page.getByRole('button', {
    name: 'Replay the test animation',
  });
  await expect(toggle).toBeVisible();
  await expect(replay).toBeVisible();
  // White glyphs, no visible label: the name is for assistive tech.
  await expect(toggle).toHaveText('Pause the test animation');
  expect(
    await toggle.evaluate((button) => {
      const style = getComputedStyle(button);
      return [style.backgroundColor, style.borderStyle];
    }),
  ).toEqual(['rgba(0, 0, 0, 0)', 'none']);
  const box = (await toggle.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);

  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('data-state', 'paused');
  await expect(page.locator(SCENE)).toHaveAttribute(
    'data-scene-state',
    'paused',
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('data-state', 'playing');

  await seek(page, 3000);
  await replay.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(
    await page.evaluate(() => window.__motion!.time('kit-scene')),
  ).toBeLessThan(1500);
});

test.describe('under reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the scene builds nothing, shows its end state and hides its controls', async ({
    page,
  }) => {
    await page.goto('/kit/');
    const figure = page.locator(SCENE);
    await figure.scrollIntoViewIfNeeded();
    await expect(figure).toHaveAttribute('data-scene-state', 'rest');
    await page.waitForTimeout(300);
    expect(
      await figure.evaluate(
        (element) => element.getAnimations({ subtree: true }).length,
      ),
    ).toBe(0);
    await expect(figure.locator('[data-scene-toggle]')).toBeHidden();
    await expect(figure.locator('[data-scene-replay]')).toBeHidden();
  });
});
