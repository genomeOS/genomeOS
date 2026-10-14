/**
 * Project page browser checks (site redesign spec §4.2, §9.1; #454). Owned by the Project task.
 *
 * The roadmap's three states in order; the scale ladder's tabs; the HbS threshold slider, its count
 * and its spoken value; the genotype triad's sickled cell; the safeguard tiles playing once and
 * resting; the Pipeline's 6 ↔ 3 toggle; the join-up's field reasons and record replay; and the map's
 * keyboard readout. The cross-page suites (word budget, figures, motion) cover the rest.
 */
import { expect, test, type Page } from '@playwright/test';

import { useSiteFixtures } from './helpers/marketing';

useSiteFixtures();

/** Bring a figure into view and wait for the HbS map's data, when that is the figure. */
async function hbsReady(page: Page) {
  const figure = page.locator('figure[data-graphic="hbs-threshold"]');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-hbs-ready', '');
  return figure;
}

test('project page labels all three capability states, in order', async ({
  page,
}) => {
  await page.goto('/project/');
  const names = [
    'Available now',
    'In active development',
    'Future exploration',
  ];
  const tops: number[] = [];
  const lefts: number[] = [];
  for (const name of names) {
    const heading = page.getByRole('heading', { level: 3, name, exact: true });
    await expect(heading).toBeVisible();
    const box = (await heading.boundingBox())!;
    tops.push(box.y);
    lefts.push(box.x);
  }
  // Left to right on a wide screen, top to bottom on a phone: never out of order.
  for (let index = 1; index < names.length; index += 1)
    expect(
      lefts[index] > lefts[index - 1] || tops[index] > tops[index - 1],
      names[index],
    ).toBe(true);
  // The Atlas item carries its honest status.
  const rail = page.locator('figure[data-graphic="status-rail"]');
  await expect(
    rail.locator('.kit-status-tag[data-status="not-validated"]'),
  ).toBeVisible();
});

test('the scale ladder is a tablist of three levels with one selected', async ({
  page,
}) => {
  await page.goto('/project/');
  const ladder = page.locator('figure[data-graphic="scale-ladder"]');
  const tabs = ladder.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(
    ladder.locator('[role="tab"][aria-selected="true"]'),
  ).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.first()).toContainText('Variation across Earth');
  await expect(tabs.first()).toContainText('In active development');
  const stage = ladder.locator('[data-figure-stage]');
  const earthLabel = await stage.getAttribute('aria-label');
  await expect(
    ladder.getByText(
      'Where variants and conditions are common, rare or unmeasured.',
    ),
  ).toBeVisible();

  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(
    ladder.locator('[role="tab"][aria-selected="true"]'),
  ).toHaveCount(1);
  await expect(ladder).toHaveAttribute('data-level', 'cell');
  expect(await stage.getAttribute('aria-label')).not.toBe(earthLabel);
  await expect(
    ladder.getByText('From chromosome to the folded locus around a gene.'),
  ).toBeVisible();
  await page.keyboard.press('End');
  await expect(ladder).toHaveAttribute('data-level', 'bridge');
});

test('the threshold slider changes the count and its spoken value', async ({
  page,
}) => {
  await page.goto('/project/');
  const figure = await hbsReady(page);
  const slider = figure.getByRole('slider');
  const count = figure.locator('[data-hbs-count]');
  await expect(slider).toHaveValue('10');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /^10 percent: \d+ areas confidently above, \d+ possibly above$/,
  );
  const at10 = await count.textContent();

  await slider.fill('5');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /^5 percent: \d+ areas confidently above, \d+ possibly above$/,
  );
  await expect(count).not.toHaveText(at10!);
  await expect(count).toHaveText(
    /^\d+ confidently above · \d+ possibly above$/,
  );
  await expect(figure.locator('[data-hbs-threshold]')).toHaveText('5%');

  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('6');
  await expect(slider).toHaveAttribute('aria-valuetext', /^6 percent:/);
});

test('selecting SS draws the sickled cell', async ({ page }) => {
  await page.goto('/project/');
  const figure = page.locator('figure[data-graphic="hbs-threshold"]');
  const group = figure.getByRole('group', { name: 'Genotype', exact: true });
  await group.scrollIntoViewIfNeeded();
  await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
  await group.getByRole('button', { name: /^SS/ }).click();
  await expect(group.getByRole('button', { name: /^SS/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(figure.locator('[data-genotype]')).toHaveAttribute(
    'data-genotype',
    'SS',
  );
  // The trait's description is the catalog's own wording.
  await expect(
    group.getByRole('button', { name: /^AS/ }),
  ).toHaveAccessibleDescription(
    'sickle-cell trait, associated with protection from severe malaria',
  );
});

test('the HbS map describes the area under its keyboard reticle', async ({
  page,
}) => {
  await page.goto('/project/');
  const figure = await hbsReady(page);
  const map = figure.locator('[data-hbs-map]');
  const readout = figure.locator('[data-readout]');
  const idle = await readout.textContent();
  await map.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(readout).not.toHaveText(idle!);
  await expect(readout).toHaveText(
    /Modeled estimate about [\d.]+%|No estimate|of [\d,]+ alleles/,
  );
  await page.keyboard.press('Home');
  await expect(readout).not.toHaveText(idle!);
});

test('the HbS map plays its entrance after a jump scroll', async ({ page }) => {
  await page.goto('/project/');
  const figure = page.locator('figure[data-graphic="hbs-threshold"]');
  // Near view but still below the fold: the data loads and the figure arms off screen.
  await figure.evaluate((element) =>
    window.scrollTo({
      top: element.getBoundingClientRect().top + scrollY - innerHeight - 200,
      behavior: 'instant',
    }),
  );
  await expect(figure).toHaveAttribute('data-hbs-ready', '');
  await expect(figure).toHaveAttribute('data-figure-state', 'armed');
  // One jump brings it fully into view: it must play and rest, not hold its first frame.
  await figure.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 4_000,
  });
  const painted = await figure
    .locator('[data-hbs-canvas="surface"]')
    .evaluate((canvas: HTMLCanvasElement) => {
      const { data } = canvas
        .getContext('2d')!
        .getImageData(0, 0, canvas.width, canvas.height);
      let opaque = 0;
      for (let index = 3; index < data.length; index += 4 * 97)
        if (data[index] > 0) opaque += 1;
      return opaque;
    });
  expect(painted).toBeGreaterThan(100);
});

test('the safeguard tiles play once, then rest', async ({ page }) => {
  await page.goto('/project/');
  const figure = page.locator('figure[data-graphic="safeguards"]');
  await figure.scrollIntoViewIfNeeded();
  await expect(figure.locator('li')).toHaveCount(6);
  await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
    timeout: 5_000,
  });
  const running = await figure.evaluate(
    (element) =>
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running').length,
  );
  expect(running).toBe(0);
});

test('the Pipeline switches from 6 parts to 3 stages and back', async ({
  page,
}) => {
  await page.goto('/project/');
  const pipeline = page.locator('figure[data-graphic="pipeline"]');
  await pipeline.scrollIntoViewIfNeeded();
  const toggle = pipeline.getByRole('group', { name: 'Level of detail' });
  await expect(pipeline).toHaveAttribute('data-mode', '6');
  await expect(toggle.locator('[aria-pressed="true"]')).toHaveCount(1);
  await toggle.getByRole('button', { name: '3 stages' }).click();
  await expect(pipeline).toHaveAttribute('data-mode', '3');
  await expect(toggle.locator('[aria-pressed="true"]')).toHaveCount(1);
  await toggle.getByRole('button', { name: '6 parts' }).click();
  await expect(pipeline).toHaveAttribute('data-mode', '6');
  await expect(toggle.locator('[aria-pressed="true"]')).toHaveText('6 parts');
});

test('the join-up gives each contract field its reason, and replays a record', async ({
  page,
}) => {
  await page.goto('/project/');
  const figure = page.locator('figure[data-graphic="join-up"]');
  const caption = figure.locator('[data-joinup-caption]');
  await expect(caption).toHaveText(
    'Every observation needs a place, a radius and a count.',
  );
  await figure.locator('[data-field="an"]').first().focus();
  await expect(caption).toHaveText(
    'AN turns a zero into weak evidence, not absence.',
  );
  await page.keyboard.press('Escape');
  await expect(caption).toHaveText(
    'Every observation needs a place, a radius and a count.',
  );
  const record = figure.getByRole('button', { name: /^Paper table/ });
  await record.click();
  await expect(figure.locator('[data-record="paper"]')).toHaveAttribute(
    'data-replay',
    /\d+/,
  );
});
