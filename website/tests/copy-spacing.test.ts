/**
 * No run-together words (site redesign spec §9.2, #454): an inline element closing straight into a
 * letter renders as one word ("genomeOSasks", "issuesbefore", "opt-in.This"). Checked in <main> of
 * every built page whose manifest enforces its copy.
 */
import { describe, expect, it } from 'vitest';

import { builtHtml } from './helpers/dist';
import { wordEnforced } from './helpers/pages';

const ADJACENT = /<\/(?:a|b|em|span|strong)>\p{L}/gu;

function main(html: string): string {
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>');
  return start === -1 || end === -1 ? '' : html.slice(start, end);
}

describe('copy spacing', () => {
  it.each(wordEnforced.map((page) => [page.route, page] as const))(
    'separates every inline element from the next word on %s',
    (route) => {
      const html = main(builtHtml(route.replace(/^\//, '').replace(/\/$/, '')));
      expect(html, `${route} was not built`).not.toBe('');
      const joined = [...html.matchAll(ADJACENT)].map((match) =>
        html.slice(Math.max(0, match.index - 40), match.index + 12),
      );
      expect(joined).toEqual([]);
    },
  );
});
