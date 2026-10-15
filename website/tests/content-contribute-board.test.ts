/**
 * Contribute's "How work moves" content (site redesign spec §4.3 C2; round 2 spec §4.3.4; #454),
 * read from the built page. Owned by the board task (round 2 plan T5); split verbatim out of
 * content-contribute.test.ts (plan T0 step 3).
 */
import { describe, expect, it } from 'vitest';

import { builtHtml } from './helpers/dist';

const contribute = builtHtml('contribute');
const main = contribute.slice(
  contribute.indexOf('<main'),
  contribute.indexOf('</main>'),
);
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();

describe('contribute page content', () => {
  it('teaches the repository contribution workflow', () => {
    expect(contribute).toContain('Discussion #76');
    expect(contribute).toContain('mention the original issue author');
    expect(contribute).toContain('Ready');
    expect(contribute).toContain('needs-human-decision');
    expect(contribute).toContain('wants-expert-review');
    expect(contribute).toContain('https://github.com/orgs/genomeOS/projects/1');
  });

  it('without JavaScript, lists the five steps in order and parks the board on Ready', () => {
    const panels = main.match(/<ol class="wb-panels"[\s\S]*?<\/ol>/)?.[0];
    expect(panels).toBeDefined();
    expect(panels!.match(/<li\b/g)).toHaveLength(5);
    expect(panels).not.toMatch(/\shidden(?:=|\s|>)/);
    expect(textOf(panels!)).toMatch(
      /Discussion #76[\s\S]*mention the original issue author[\s\S]*Filter Ready work[\s\S]*wants-expert-review[\s\S]*needs-human-decision[\s\S]*pull request/,
    );
    expect(main).toMatch(/class="wb"[^>]*data-step="3"/);
    expect(main).toMatch(/<div[^>]*role="tablist"[^>]*hidden/);
  });

  // Design review, round 3: step 3's panel said the board's Ready definition a second time. The
  // definition line under the board says it once; the panel adds only the filters, with "Ready"
  // (a pinned term) as its link to the board.
  it('says what Ready means once, and links Ready to the board from step 3', () => {
    const panel = main.match(
      /<div class="wb-panel" id="wb-panel-3"[\s\S]*?<\/div>/,
    )?.[0];
    expect(panel).toBeDefined();
    expect(textOf(panel!)).toBe(
      'Filter Ready work by skill, type and priority labels.',
    );
    expect(panel).toMatch(
      /<a href="https:\/\/github\.com\/orgs\/genomeOS\/projects\/1"[^>]*>Ready<\/a>/,
    );
    expect(textOf(main).match(/fully specified and unblocked/g)).toHaveLength(
      1,
    );
  });
});
