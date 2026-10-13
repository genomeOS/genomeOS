/** Real-map browser acceptance with explicitly mocked assistant responses; design §16. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [baseUrl, output] = process.argv.slice(2);
if (!baseUrl || !output)
  throw new Error('Supply local viewer URL and PNG output path.');
const catalog = JSON.parse(
  readFileSync(
    new URL('../public/data/atlas/catalog.json', import.meta.url),
    'utf8',
  ),
);
const revision = 'a'.repeat(64);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://127.0.0.1:8011/**', async (route) => {
    const request = route.request();
    const headers = {
      'access-control-allow-origin': new URL(baseUrl).origin,
      'access-control-allow-credentials': 'true',
    };
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          ...headers,
          'access-control-allow-methods': 'GET,POST',
          'access-control-allow-headers': 'content-type,x-csrf-token',
        },
      });
    if (request.url().endsWith('/session'))
      return route.fulfill({
        headers,
        json: {
          session_id: 'a'.repeat(64),
          csrf_token: 'b'.repeat(64),
          expires_at: 2000000000,
        },
      });
    if (request.url().endsWith('/catalog'))
      return route.fulfill({
        headers,
        json: { revision, artifacts: catalog.artifacts },
      });
    const body = request.postDataJSON();
    const action = {
      id: 'd5f88918-fd97-44ad-ab34-042a14e76936',
      catalog_revision: revision,
      state_token: body.state_token,
      operation: 'view',
      selections: [{ id: 'hbs-rs334', version: 'v3/map-2026-08' }],
      metric: 'post_sd',
      layers: ['surface', 'observations', 'support', 'context', 'countries'],
      region: 'current',
    };
    if (body.message.includes('stale')) action.state_token = 'stale';
    if (body.message.includes('compare')) {
      action.operation = 'compare';
      action.selections.push({
        id: 'g6pd-deficiency',
        version: 'v3/map-2026-08',
      });
    }
    const refused = body.message.includes('unrelated');
    return route.fulfill({
      headers,
      json: {
        catalog_revision: revision,
        answer: refused
          ? 'This acceptance fixture refuses unrelated requests.'
          : 'Acceptance fixture: display posterior standard deviation. Observations are measured; the surface is inferred. Unknown and prior-dominated cells provide no supported estimate.',
        sources: [
          {
            label: 'Published catalog',
            url: 'https://genome-os.org/data/atlas/catalog.json',
          },
        ],
        action: refused ? null : action,
      },
    });
  });
  await page.goto(
    `${baseUrl}/app/?entity=hbs-rs334&version=v3%2Fmap-2026-08&geometry=triangles&edges=false`,
  );
  await page.locator('[data-atlas-ready="true"]').waitFor({ timeout: 120000 });
  console.log('Real HbS artifact rendered.');
  await page
    .getByRole('button', { name: 'Map assistant', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Private map assistant' });
  const input = page.getByRole('textbox', { name: 'Ask about the map' });
  async function ask(text) {
    await input.fill(text);
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
  }
  await ask('Show uncertainty');
  try {
    await panel
      .getByRole('status')
      .filter({ hasText: 'Applied map action' })
      .waitFor({ timeout: 90000 });
  } catch (error) {
    console.log(
      'Failed receipt:',
      await panel.textContent(),
      'URL:',
      page.url(),
      'Errors:',
      errors,
    );
    await page.screenshot({
      path: '/tmp/genomeos-chat-receipt-failure.png',
      fullPage: true,
    });
    throw error;
  }
  assert.equal(new URL(page.url()).searchParams.get('metric'), 'post_sd');
  assert.ok(new URL(page.url()).searchParams.get('layers').includes('support'));
  await page.screenshot({
    path: output,
    fullPage: true,
    animations: 'disabled',
  });
  console.log('Uncertainty action acknowledged after rendering.');
  await panel.getByRole('button', { name: 'Undo map change' }).click();
  await panel
    .getByRole('status')
    .filter({ hasText: 'Applied map action undo' })
    .waitFor({ timeout: 90000 });
  assert.equal(new URL(page.url()).searchParams.get('metric'), 'post_mean');
  const before = new URL(page.url()).searchParams.get('metric');
  await ask('stale action');
  await panel.getByRole('status').filter({ hasText: 'map changed' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('metric'), before);
  await ask('unrelated task');
  await panel
    .getByRole('status')
    .filter({ hasText: 'map unchanged' })
    .waitFor();
  await ask('compare HbS and G6PD');
  const link = panel.getByRole('link', { name: 'Open comparison' });
  await link.waitFor();
  const comparison = new URL(await link.getAttribute('href'), page.url());
  assert.equal(
    new URLSearchParams(comparison.searchParams.get('left')).get('entity'),
    'hbs-rs334',
  );
  assert.equal(
    new URLSearchParams(comparison.searchParams.get('right')).get('entity'),
    'g6pd-deficiency',
  );
  const share = new URL(
    await panel
      .getByRole('link', { name: 'Share current versioned view' })
      .getAttribute('href'),
    page.url(),
  );
  assert.equal(share.searchParams.get('version'), 'v3/map-2026-08');
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await panel.boundingBox();
  assert.ok(
    box.x >= 0 && box.x + box.width <= 391,
    'Mobile panel must fit the viewport',
  );
  await panel.getByRole('button', { name: 'Clear conversation' }).click();
  assert.equal(await panel.getByRole('log').textContent(), '');
  assert.deepEqual(errors, []);
  console.log(
    'Undo, stale refusal, scope refusal, comparison URL, share URL, mobile sizing and conversation clearing passed.',
  );
} finally {
  await browser.close();
}
