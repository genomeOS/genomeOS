#!/usr/bin/env node
/**
 * Before/after screenshots of the site for review (site redesign spec §9.2 "visual review", #454).
 * Not a test: it never fails on a difference, it only captures.
 *
 *   node scripts/capture-site.mjs --base http://127.0.0.1:4466 --out <dir> [options]
 *
 *   --routes /,/projects/     routes to capture (default: every top-level route and the 404)
 *   --profiles desktop,phone  desktop is 1440×900 at DPR 1; phone is 390×844 at DPR 2, touch
 *   --frames 300,1000,2400    also capture the first viewport frozen at these entrance times
 *                             (the `?t=<ms>` motion hook exists only in astro dev and the e2e
 *                             build, round 2 spec §3.4)
 *   --element <css>           capture only this element (e.g. the header) instead of the page
 *   --prefix after            prepended to every file name
 *
 * Analytics is declined before load (consent stored as denied, Google tag requests aborted), so
 * no prompt shows and no visit is counted. Each page is scrolled through once first, so every
 * figure has played its entrance and rests in the full-page capture.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { chromium, devices } from '@playwright/test';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    out: { type: 'string' },
    routes: {
      type: 'string',
      default: '/,/projects/,/contribute/,/docs/,/privacy/,/404.html',
    },
    profiles: { type: 'string', default: 'desktop,phone' },
    frames: { type: 'string', default: '' },
    element: { type: 'string' },
    prefix: { type: 'string', default: '' },
  },
});
if (!args.base || !args.out) {
  console.error('capture-site: --base <url> and --out <dir> are required');
  process.exit(2);
}

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: {
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  },
};

const out = path.resolve(args.out);
mkdirSync(out, { recursive: true });
const slug = (route) =>
  route === '/'
    ? 'home'
    : route.replace(/^\/|\/$|\.html$/g, '').replace(/\//g, '-');
const frames = args.frames
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map(Number);

const browser = await chromium.launch();
try {
  for (const profile of args.profiles.split(',')) {
    const options = PROFILES[profile];
    if (!options) throw new Error(`unknown profile ${profile}`);
    const context = await browser.newContext({ ...options, timezoneId: 'UTC' });
    await context.addInitScript(() =>
      localStorage.setItem('genomeos-analytics-consent', 'denied'),
    );
    await context.route(
      /googletagmanager\.com|google-analytics\.com/,
      (route) => route.abort(),
    );
    const page = await context.newPage();
    for (const route of args.routes.split(',')) {
      const name = `${args.prefix ? `${args.prefix}-` : ''}${slug(route)}-${profile}`;
      await page.goto(new URL(route, args.base).href, {
        waitUntil: 'networkidle',
      });
      await page.evaluate(() => document.fonts.ready);
      // Play every figure once, then return to the top at rest.
      await page.evaluate(async () => {
        const step = Math.max(200, innerHeight * 0.6);
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo({ top: y, behavior: 'instant' });
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
      await page.waitForTimeout(4500);
      if (args.element) {
        await page
          .locator(args.element)
          .first()
          .screenshot({
            path: path.join(out, `${name}.png`),
            animations: 'disabled',
          });
      } else {
        await page.screenshot({
          path: path.join(out, `${name}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      }
      console.log(`${name}.png`);
      for (const t of frames) {
        const url = new URL(route, args.base);
        url.searchParams.set('t', String(t));
        await page.goto(url.href, { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(out, `${name}-t${t}.png`) });
        console.log(`${name}-t${t}.png`);
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
}
