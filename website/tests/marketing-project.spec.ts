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
  // The default is 5%, where some areas are confidently above, so both outlines show at rest.
  await expect(slider).toHaveValue('5');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /^5 percent: [1-9]\d* areas confidently above, \d+ possibly above$/,
  );
  const atDefault = await count.textContent();

  await slider.fill('10');
  await expect(slider).toHaveAttribute(
    'aria-valuetext',
    /^10 percent: \d+ areas confidently above, \d+ possibly above$/,
  );
  await expect(count).not.toHaveText(atDefault!);
  await expect(count).toHaveText(
    /^\d+ confidently above · \d+ possibly above$/,
  );
  await expect(figure.locator('[data-hbs-threshold]')).toHaveText('10%');

  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('11');
  await expect(slider).toHaveAttribute('aria-valuetext', /^11 percent:/);
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

// AA and AS draw the same disc (a carrier's red cells look like anyone else's), so the frame
// says which pair it shows: pressing AS after AA visibly changes the frame (design review,
// round 1). The slider is the site's one range style: a hairline track and a square thumb.
test('the cell frame names the pressed allele pair, so AS after AA changes it', async ({
  page,
}) => {
  await page.goto('/project/');
  const figure = page.locator('figure[data-graphic="hbs-threshold"]');
  const group = figure.getByRole('group', { name: 'Genotype', exact: true });
  await group.scrollIntoViewIfNeeded();
  for (const genotype of ['AA', 'AS', 'SS']) {
    await group
      .getByRole('button', { name: new RegExp(`^${genotype}`) })
      .click();
    for (const other of ['AA', 'AS', 'SS'])
      if (other === genotype)
        await expect(figure.locator(`[data-pair="${other}"]`)).toBeVisible();
      else await expect(figure.locator(`[data-pair="${other}"]`)).toBeHidden();
  }
  await expect(figure.getByRole('slider')).toHaveCSS('appearance', 'none');
});

// Five links in equal cards, three over two (link rows set in 2–4 columns, spec §2.4), never a
// wide card plus odd ones (design review, round 1).
test('the follow-the-work links are equal cards in whole rows @desktop-chromium', async ({
  page,
}) => {
  for (const width of [1100, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/project/');
    const boxes = await page
      .locator('.proj-links > li')
      .evaluateAll((items) =>
        items.map((item) => item.getBoundingClientRect().toJSON()),
      );
    expect(boxes, `${width}`).toHaveLength(5);
    for (const box of boxes)
      expect(Math.abs(box.width - boxes[0].width), `${width}`).toBeLessThan(1);
    const rows = [...new Set(boxes.map((box) => Math.round(box.top)))];
    const perRow = rows.map(
      (top) => boxes.filter((box) => Math.round(box.top) === top).length,
    );
    expect(perRow, `${width}`).toEqual([3, 2]);
  }
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

test('the HbS heading takes the full width on narrow screens', async ({
  page,
}) => {
  await page.goto('/project/');
  const hbs = page.locator('#hbs-title');
  const vision = page.locator('#vision-title');
  // Below the split layout's breakpoint every H2 sets in the same measure (spec §2.4).
  for (const width of [390, 640]) {
    await page.setViewportSize({ width, height: 844 });
    const [a, b] = await Promise.all([hbs.boundingBox(), vision.boundingBox()]);
    expect(Math.round(a!.width), `${width} px`).toBe(Math.round(b!.width));
  }
});

test(
  'the HbS readouts and legend hold still while the threshold moves',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/project/');
    const figure = await hbsReady(page);
    const slider = figure.getByRole('slider');
    const legend = figure.locator('.hbs__legend');
    const tops = new Set<number>();
    // Every stop's count, one line or two, sits in the same reserved box (spec §2.4).
    for (const stop of ['10', '5', '1', '15']) {
      await slider.fill(stop);
      await expect(figure.locator('[data-hbs-threshold]')).toHaveText(
        `${stop}%`,
      );
      tops.add(Math.round((await legend.boundingBox())!.y));
    }
    expect([...tops]).toHaveLength(1);
    // The three genotypes set on one line each, so the triad reads as one column of equals.
    const heights = await figure
      .locator('.triad__choice')
      .evaluateAll((buttons) =>
        buttons.flatMap((button) => [
          Math.round(button.getBoundingClientRect().height),
          Math.round(button.lastElementChild!.getBoundingClientRect().height),
        ]),
      );
    expect(
      new Set(heights.filter((_, i) => i % 2 === 0)).size,
      `${heights}`,
    ).toBe(1);
    expect(
      new Set(heights.filter((_, i) => i % 2 === 1)).size,
      `${heights}`,
    ).toBe(1);
  },
);

// Design review, round 2: the map sat in a hard black well with empty corners, its bottom about
// 140 px below the genotype column. It sits open on the band, like the hero globe, and the
// genotypes, the map and the side panel share one top and one bottom.
test(
  'the HbS map sits open on its band, level with the genotypes and the side panel',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    for (const width of [1440, 1100, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/project/');
      const figure = await hbsReady(page);
      const map = figure.locator('.hbs__map');
      await expect(map).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(map).toHaveCSS('background-image', 'none');
      const box = (selector: string) =>
        figure
          .locator(selector)
          .first()
          .evaluate((element) => element.getBoundingClientRect().toJSON());
      const [stage, triad, choices] = await Promise.all(
        ['.hbs__map', '.triad', '.triad__choices'].map(box),
      );
      expect(Math.abs(triad.top - stage.top), `${width} top`).toBeLessThan(1.5);
      expect(
        Math.abs(choices.bottom - stage.bottom),
        `${width} bottom`,
      ).toBeLessThan(1.5);
      if (width > 1200) {
        const [tool, legend] = await Promise.all(
          [':scope > .kit-figure__toolbar', '.hbs__legend'].map(box),
        );
        expect(
          Math.abs(tool.top - stage.top),
          `${width} panel top`,
        ).toBeLessThan(1.5);
        expect(
          Math.abs(legend.bottom - stage.bottom),
          `${width} panel bottom`,
        ).toBeLessThan(1.5);
      }
    }
  },
);

test(
  'the link row sets in two to four columns',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    await page.goto('/project/');
    const links = page.locator('.proj-links > li');
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const lefts = await links.evaluateAll((items) =>
        items.map((item) => Math.round(item.getBoundingClientRect().left)),
      );
      const columns = new Set(lefts).size;
      expect(columns, `${width} px`).toBeGreaterThanOrEqual(2);
      expect(columns, `${width} px`).toBeLessThanOrEqual(4);
    }
  },
);

test(
  'a tap replays a safeguard tile and lights a roadmap item’s node',
  { tag: '@mobile-chromium' },
  async ({ page }) => {
    await page.goto('/project/');
    const safeguards = page.locator('figure[data-graphic="safeguards"]');
    await safeguards.scrollIntoViewIfNeeded();
    await expect(safeguards).toHaveAttribute('data-figure-state', 'rest', {
      timeout: 5_000,
    });
    const tile = safeguards.locator('.sg-tile').nth(1);
    await tile.tap();
    await expect(tile).toHaveClass(/\bis-replaying\b/);

    const rail = page.locator('figure[data-graphic="status-rail"]');
    await rail.scrollIntoViewIfNeeded();
    const item = rail.locator('[data-item="active-1"]');
    await item.tap();
    // A tap has no hover to end it: the item and its node stay lit until another is tapped.
    await expect(item).toHaveClass(/\bis-lit\b/);
    await expect(rail.locator('[data-node="active-1"]')).toHaveClass(
      /\bis-lit\b/,
    );
    await rail.locator('[data-item="future-0"]').tap();
    await expect(item).not.toHaveClass(/\bis-lit\b/);
    await expect(rail.locator('[data-node="future-0"]')).toHaveClass(
      /\bis-lit\b/,
    );
  },
);

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

test(
  'on a phone, a contract field’s reason shows beside the field names',
  {
    tag: '@mobile-chromium',
  },
  async ({ page }) => {
    await page.goto('/project/');
    const figure = page.locator('figure[data-graphic="join-up"]');
    const head = figure.locator('button[data-field="an"]');
    await head.scrollIntoViewIfNeeded();
    await head.tap();
    await expect(head).toHaveClass(/\bis-lit\b/);
    // The plate is long on a phone: the reason belongs next to the name that was tapped, not in the
    // caption under the last record.
    const gap = await figure.evaluate((element) => {
      const reason = 'AN turns a zero into weak evidence, not absence.';
      const name = element
        .querySelector('button[data-field="an"]')!
        .getBoundingClientRect();
      const shown = [...element.querySelectorAll<HTMLElement>('*')]
        .filter(
          (node) =>
            node.childElementCount === 0 &&
            node.textContent?.trim() === reason &&
            node.checkVisibility({ opacityProperty: true }),
        )
        .map((node) => node.getBoundingClientRect())
        .filter((box) => box.top >= 0 && box.bottom <= innerHeight);
      return Math.min(
        ...shown.map((box) =>
          Math.max(0, box.top - name.bottom, name.top - box.bottom),
        ),
      );
    });
    expect(gap).toBeLessThanOrEqual(48);
  },
);

test('the HbS map lets go of its readout when focus leaves it', async ({
  page,
}) => {
  await page.goto('/project/');
  const figure = await hbsReady(page);
  const map = figure.locator('[data-hbs-map]');
  const reticle = figure.locator('[data-hbs-reticle]');
  const readout = figure.locator('[data-readout]');
  const idle = await readout.textContent();
  await map.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(reticle).toBeVisible();
  await expect(readout).not.toHaveText(idle!);
  await page.keyboard.press('Tab');
  await expect(map).not.toBeFocused();
  await expect(reticle).toBeHidden();
  await expect(readout).toHaveText(idle!);
});

test(
  'the HbS map redraws only when the pointer reaches something new',
  { tag: '@desktop-chromium' },
  async ({ page }) => {
    await page.addInitScript(() => {
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      const counter = window as unknown as { __clears: number };
      counter.__clears = 0;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        counter.__clears += 1;
        return clear.apply(this, args);
      };
    });
    await page.goto('/project/');
    const figure = await hbsReady(page);
    await expect(figure).toHaveAttribute('data-figure-state', 'rest', {
      timeout: 4_000,
    });
    // Fifteen spots over sea, areas and studs. Arriving at a spot may redraw; further pointer moves
    // that land on the same spot (a slow hand, a high-rate mouse) must not. Before the fix every
    // move redrew both canvases.
    const { arrivals, repeats } = await figure
      .locator('[data-hbs-map]')
      .evaluate((map) => {
        const counter = window as unknown as { __clears: number };
        const box = map.getBoundingClientRect();
        let arrivals = 0;
        const repeats: number[] = [];
        for (const fy of [0.35, 0.5, 0.65])
          for (const fx of [0.3, 0.4, 0.5, 0.6, 0.7]) {
            const move = () =>
              map.dispatchEvent(
                new PointerEvent('pointermove', {
                  bubbles: true,
                  pointerType: 'mouse',
                  clientX: box.left + box.width * fx,
                  clientY: box.top + box.height * fy,
                }),
              );
            const before = counter.__clears;
            move();
            const arrived = counter.__clears;
            arrivals += arrived - before;
            for (let again = 0; again < 4; again += 1) move();
            repeats.push(counter.__clears - arrived);
          }
        return { arrivals, repeats };
      });
    // The counter sees redraws (moving between spots changes what is under the pointer)…
    expect(arrivals).toBeGreaterThan(0);
    // …and staying put draws nothing.
    expect(repeats).toEqual(Array.from({ length: 15 }, () => 0));
  },
);

test('“haemoglobin S” never breaks across two lines', async ({ page }) => {
  await page.goto('/project/');
  const title = page.locator('#hbs-title');
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const lines = await title.evaluate((heading) => {
      const node = heading.firstChild as Text;
      const at = node.data.indexOf('haemoglobin');
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 'haemoglobin S'.length);
      return new Set(
        [...range.getClientRects()].map((rect) => Math.round(rect.top)),
      ).size;
    });
    expect(lines, `${width} px`).toBe(1);
  }
});

test('the HbS count breaks only between its two clauses', async ({ page }) => {
  await page.goto('/project/');
  const figure = await hbsReady(page);
  const slider = figure.getByRole('slider');
  const clauses = figure.locator('[data-hbs-count] > span');
  for (const stop of ['5', '1', '10', '15']) {
    await slider.fill(stop);
    await expect(figure.locator('[data-hbs-threshold]')).toHaveText(`${stop}%`);
    await expect(clauses).toHaveCount(2);
    const lines = await clauses.evaluateAll((spans) =>
      spans.map((span) => span.getClientRects().length),
    );
    expect(lines, `${stop}%`).toEqual([1, 1]);
  }
});
