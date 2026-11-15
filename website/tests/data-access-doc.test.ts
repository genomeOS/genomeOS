/**
 * docs/data-access.md (Atlas data platform design 2026-10-18 §3.1, step 1.15) leads with the SQL the
 * "Query in your browser" panel runs (step 1.13): the ATTACH of the catalog the website attaches,
 * then each example, statement for statement. The panel's error links land on the page's headings.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { QUERY_ERROR_DOCS } from '../src/atlas/browser-sql/errors';
import {
  attachStatement,
  browserSqlExamples,
} from '../src/atlas/browser-sql/examples';
import {
  DATA_STORE_BASE_URL,
  latestDataStoreCatalog,
} from '../src/lib/data-store-release';
import { ALL, HBS } from './fixtures/browser-sql';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

interface Section {
  heading: string;
  lines: string[];
}

/** The page's H2 sections in order, each with its lines; a `## ` inside fenced code is no heading. */
function sections(markdown: string): Section[] {
  const found: Section[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (!fenced && line.startsWith('## '))
      found.push({ heading: line.slice(3), lines: [] });
    else found.at(-1)?.lines.push(line);
  }
  return found;
}

/** The contents of each ```sql block in `lines`, without surrounding blank lines. */
function sqlBlocks(lines: string[]): string[] {
  const blocks = [...lines.join('\n').matchAll(/^```sql\n([\s\S]*?)^```$/gm)];
  return blocks.map((block) => block[1]!.trim());
}

/** GitHub's anchor for a Markdown heading: lower case, punctuation dropped, spaces as hyphens. */
function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

const page = () =>
  sections(
    readFileSync(path.join(repositoryRoot, 'docs/data-access.md'), 'utf8'),
  );

describe('docs/data-access.md', () => {
  it("the documented SQL is the panel's", () => {
    const catalog = latestDataStoreCatalog(
      path.join(repositoryRoot, 'data/releases'),
      DATA_STORE_BASE_URL,
    );
    expect(catalog).not.toBeNull();
    const [lookUp, browser] = page();
    expect([lookUp?.heading, browser?.heading]).toEqual([
      'Look up one variant',
      'Query in your browser',
    ]);
    const documented = [
      ...sqlBlocks(lookUp!.lines),
      ...sqlBlocks(browser!.lines),
    ];
    expect(documented).toEqual([
      attachStatement(catalog!.url),
      ...browserSqlExamples(ALL, HBS).map((example) => example.sql),
    ]);
  });

  it("is where the panel's error links lead", () => {
    const anchors = page().map((section) => anchor(section.heading));
    for (const { href } of Object.values(QUERY_ERROR_DOCS)) {
      const [document, fragment] = href.split('#');
      expect(document).toMatch(/\/blob\/main\/docs\/data-access\.md$/);
      expect(anchors).toContain(fragment);
    }
  });
});
