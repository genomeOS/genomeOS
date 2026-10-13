/** Real browser cookie isolation against the loopback-only fixture API; Atlas design §16. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const site = 'http://127.0.0.1:4335';
const endpoint = 'http://127.0.0.1:8017';
const browser = await chromium.launch({ headless: true });
try {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  async function pageFor(context) {
    const page = await context.newPage();
    page.on('pageerror', (error) =>
      console.log('Fixture module error:', error.message),
    );
    page.on('requestfailed', (request) =>
      console.log(
        'Fixture request failed:',
        request.url(),
        request.failure()?.errorText,
      ),
    );
    await page.route('http://127.0.0.1:8011/**', async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace(':8011', ':8017'),
      });
      await route.fulfill({ response });
    });
    const fixture = fileURLToPath(
      new URL('../tests/fixtures/chat-session.html', import.meta.url),
    );
    await page.goto(`${site}/@fs${fixture}`);
    await page.waitForFunction(() => window.fixtureReady === true);
    return page;
  }
  const a = await pageFor(alice);
  const b = await pageFor(bob);
  const idA = await a.evaluate(() => window.bootstrap());
  const idB = await b.evaluate(() => window.bootstrap());
  assert.notEqual(idA.session_id, idB.session_id);
  assert.deepEqual(await a.evaluate(() => window.bootstrap()), idA);
  const cookiesA = await alice.cookies(endpoint);
  const cookiesB = await bob.cookies(endpoint);
  assert.notEqual(cookiesA[0].value, cookiesB[0].value);
  assert.equal(cookiesA[0].httpOnly, true);
  assert.equal(cookiesA[0].sameSite, 'Lax');
  assert.equal(await a.evaluate(() => document.cookie), '');
  const metadata = await (
    await alice.request.get(`${endpoint}/v1/atlas/chat/catalog`)
  ).json();
  const body = {
    message: 'fixture question',
    catalog_revision: metadata.revision,
    state_token: 'own-map',
    current_id: 'hbs-rs334',
    current_version: 'v3/map-2026-08',
    previous_questions: [],
  };
  const [replyA, replyB] = await Promise.all([
    a.evaluate(async ({ session, body }) => window.send(session, body), {
      session: idA,
      body: {
        ...body,
        state_token: 'Alice-map',
        previous_questions: ['Alice-only'],
      },
    }),
    b.evaluate(async ({ session, body }) => window.send(session, body), {
      session: idB,
      body: {
        ...body,
        state_token: 'Bob-map',
        previous_questions: ['Bob-only'],
      },
    }),
  ]);
  assert.equal(replyA.status, 200);
  assert.equal(replyB.status, 200);
  assert.equal(replyA.body.action.state_token, 'Alice-map');
  assert.equal(replyB.body.action.state_token, 'Bob-map');
  const wrongProof = await a.evaluate(
    async ({ session, body }) => window.send(session, body),
    { session: idB, body },
  );
  assert.equal(wrongProof.status, 403);
  await Promise.all([
    a.evaluate(() => window.mountChat()),
    b.evaluate(() => window.mountChat()),
  ]);
  const requestsA = [];
  const requestsB = [];
  for (const [page, requests] of [
    [a, requestsA],
    [b, requestsB],
  ]) {
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith('/v1/atlas/chat')
      )
        requests.push(request.postDataJSON());
    });
    await page
      .getByRole('button', { name: 'Map assistant', exact: true })
      .click();
  }
  async function ask(page, question) {
    await page
      .getByRole('textbox', { name: 'Ask about the map' })
      .fill(question);
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await send.click();
    await page
      .getByRole('status')
      .filter({ hasText: 'Applied map action' })
      .waitFor();
  }
  await Promise.all([ask(a, 'Alice UI one'), ask(b, 'Bob UI one')]);
  await Promise.all([ask(a, 'Alice UI two'), ask(b, 'Bob UI two')]);
  assert.deepEqual(requestsA[1].previous_questions, ['Alice UI one']);
  assert.deepEqual(requestsB[1].previous_questions, ['Bob UI one']);
  assert.ok(!(await a.getByRole('log').textContent()).includes('Bob UI'));
  assert.ok(!(await b.getByRole('log').textContent()).includes('Alice UI'));
  const aTab = await pageFor(alice);
  assert.deepEqual(await aTab.evaluate(() => window.bootstrap()), idA);
  await alice.clearCookies();
  const newA = await a.evaluate(() => window.bootstrap());
  assert.notEqual(newA.session_id, idA.session_id);
  assert.deepEqual(await b.evaluate(() => window.bootstrap()), idB);
  await a
    .getByRole('textbox', { name: 'Ask about the map' })
    .fill('Old session attempt');
  await a.getByRole('button', { name: 'Send', exact: true }).click();
  await a
    .getByRole('status')
    .filter({ hasText: 'session expired or changed' })
    .waitFor();
  assert.equal(await a.getByRole('log').textContent(), '');
  assert.ok((await b.getByRole('log').textContent()).includes('Bob UI two'));
  await a.getByRole('button', { name: 'Map assistant', exact: true }).click();
  await a.getByRole('button', { name: 'Map assistant', exact: true }).click();
  await ask(a, 'Alice new session');
  assert.deepEqual(requestsA.at(-1).previous_questions, []);
  console.log(
    'Two browser profiles: distinct stable HttpOnly cookies, isolated chat logs/request histories/map replies, foreign-proof refusal, same-profile tab reuse and independent cookie reset with stale-chat clearing passed.',
  );
} finally {
  await browser.close();
}
