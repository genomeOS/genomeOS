/**
 * The Contact page's draft builder (Contact page spec §3, §7): a pure module with no DOM, so the
 * letter's grammar, its section order, the subject, the `mailto:` encoding and the length cap are
 * checked here directly. The page and its browser test render from the same module.
 */
import { describe, expect, it } from 'vitest';

import { contactAddress } from '../src/lib/contact-address';
import {
  buildDraft,
  draftSections,
  draftText,
  isOffer,
  isTopic,
  mailtoUrl,
  MAILTO_MAX_LENGTH,
  normalizeOffers,
  OFFERS,
  offerList,
  opening,
  parseQuery,
  subject,
  toQuery,
  TOPICS,
  type Offer,
} from '../src/lib/contact-draft';

/** Every subset of the four offers, in their canonical order. */
const subsets: Offer[][] = Array.from({ length: 16 }, (_, mask) =>
  OFFERS.filter((_, index) => mask & (1 << index)),
);

const SECTION_LINES = {
  code: [
    'Code',
    "- What I'd like to work on (Atlas, pipeline, docs, other):",
    '- GitHub username:',
    '- Relevant experience:',
  ],
  data: [
    'Data',
    '- Dataset (name or publication):',
    '- Populations and sample size:',
    '- Data type (genotypes, allele counts, phenotypes):',
    '- Consent and access terms:',
  ],
  expertise: [
    'Expertise',
    '- Field:',
    "- How I'd like to help:",
    '- Time I can offer:',
  ],
  funding: [
    'Funding',
    '- Organization:',
    '- Kind of support (grant, donation, in-kind):',
    '- Timeline:',
  ],
  question: ['My question', '- Question:', '- Related page or link:'],
  partner: [
    'Proposal',
    '- Organization:',
    "- What we'd like to do together:",
    '- Timeline:',
  ],
  press: ['Press inquiry', '- Outlet:', '- Topic:', '- Deadline:'],
} as const;

/** The body the spec prints, block by block (spec §3.2). */
function expectedBody(
  openingLine: string,
  sections: (keyof typeof SECTION_LINES)[],
): string {
  return [
    'Dear genomeOS Foundation team,',
    openingLine,
    ['About me', '- Name:', '- Affiliation:', '- Role:'].join('\n'),
    ...sections.map((key) => SECTION_LINES[key].join('\n')),
    ['Best regards,', '[Your name]'].join('\n'),
  ].join('\n\n');
}

describe('the purposes and offers', () => {
  it('lists the four purposes and the four offers in the spec’s order', () => {
    expect(TOPICS).toEqual(['contribute', 'question', 'partner', 'press']);
    expect(OFFERS).toEqual(['code', 'data', 'expertise', 'funding']);
  });

  it('tells a known purpose or offer from anything else', () => {
    expect(TOPICS.every(isTopic)).toBe(true);
    expect(OFFERS.every(isOffer)).toBe(true);
    for (const value of ['report', 'Press', '', 'toString'])
      expect(isTopic(value), value).toBe(false);
    for (const value of ['money', 'Code', '', undefined])
      expect(isOffer(value), String(value)).toBe(false);
  });

  it('puts offers in their canonical order, once each, and drops unknown ones', () => {
    expect(normalizeOffers(['funding', 'code', 'data', 'code'])).toEqual([
      'code',
      'data',
      'funding',
    ]);
    expect(normalizeOffers(['money', 'Data', ' expertise '])).toEqual([
      'data',
      'expertise',
    ]);
    expect(normalizeOffers([])).toEqual([]);
  });
});

describe('the opening line', () => {
  it('names a placeholder for every offer while none is chosen', () => {
    expect(opening({ topic: 'contribute', offers: [] })).toBe(
      "I'd like to contribute to genomeOS by providing [code / data / expertise / funding].",
    );
  });

  it('lists one to four offers in lower case, with "and" before the last and no serial comma', () => {
    const line = (offers: Offer[]) => opening({ topic: 'contribute', offers });
    expect(line(['code'])).toBe(
      "I'd like to contribute to genomeOS by providing code.",
    );
    expect(line(['code', 'data'])).toBe(
      "I'd like to contribute to genomeOS by providing code and data.",
    );
    expect(line(['code', 'data', 'funding'])).toBe(
      "I'd like to contribute to genomeOS by providing code, data and funding.",
    );
    expect(line([...OFFERS])).toBe(
      "I'd like to contribute to genomeOS by providing code, data, expertise and funding.",
    );
    // Pressed in any order, they read in the canonical one.
    expect(line(['funding', 'data'])).toBe(
      "I'd like to contribute to genomeOS by providing data and funding.",
    );
    expect(offerList(['expertise'])).toBe('expertise');
  });

  it('opens each other purpose with its own sentence, whatever offers were pressed', () => {
    expect(opening({ topic: 'question', offers: ['code'] })).toBe(
      'I have a question about genomeOS.',
    );
    expect(opening({ topic: 'partner', offers: [] })).toBe(
      "I'd like to discuss a partnership or collaboration with genomeOS.",
    );
    expect(opening({ topic: 'press', offers: ['data'] })).toBe(
      "I'm writing with a press inquiry about genomeOS.",
    );
  });
});

describe('the subject', () => {
  it('adds the chosen offers to a contribution as a lower-case comma list', () => {
    expect(subject({ topic: 'contribute', offers: [] })).toBe(
      'Contributing to genomeOS',
    );
    expect(subject({ topic: 'contribute', offers: ['data', 'code'] })).toBe(
      'Contributing to genomeOS: code, data',
    );
    expect(subject({ topic: 'contribute', offers: [...OFFERS] })).toBe(
      'Contributing to genomeOS: code, data, expertise, funding',
    );
  });

  it('names each other purpose', () => {
    expect(subject({ topic: 'question', offers: ['code'] })).toBe(
      'Question about genomeOS',
    );
    expect(subject({ topic: 'partner', offers: [] })).toBe(
      'Partnership proposal for genomeOS',
    );
    expect(subject({ topic: 'press', offers: [] })).toBe(
      'Press inquiry about genomeOS',
    );
  });
});

describe('the letter', () => {
  it('reads greeting, opening, About me, then the sections, then the sign-off', () => {
    expect(buildDraft({ topic: 'contribute', offers: [] }).body).toBe(
      expectedBody(
        "I'd like to contribute to genomeOS by providing [code / data / expertise / funding].",
        [],
      ),
    );
    expect(
      buildDraft({ topic: 'contribute', offers: ['funding', 'code'] }).body,
    ).toBe(
      expectedBody(
        "I'd like to contribute to genomeOS by providing code and funding.",
        ['code', 'funding'],
      ),
    );
  });

  it('gives every set of offers one section each, in the order Code, Data, Expertise, Funding', () => {
    for (const offers of subsets) {
      const draft = buildDraft({
        topic: 'contribute',
        offers: [...offers].reverse(),
      });
      expect(draft.body, offers.join()).toBe(
        expectedBody(opening({ topic: 'contribute', offers }), offers),
      );
      expect(
        draftSections({ topic: 'contribute', offers }).map(({ id }) => id),
      ).toEqual(['about', ...offers]);
    }
  });

  it('gives each other purpose its own section and no offer sections', () => {
    for (const topic of ['question', 'partner', 'press'] as const) {
      const draft = buildDraft({ topic, offers: [...OFFERS] });
      expect(draft.body, topic).toBe(
        expectedBody(opening({ topic, offers: [] }), [topic]),
      );
      expect(draft.subject).toBe(subject({ topic, offers: [] }));
    }
  });

  it('copies as plain text: To, Subject, a blank line, then the body', () => {
    const draft = buildDraft({ topic: 'press', offers: [] });
    expect(draftText('team@example.org', draft)).toBe(
      `To: team@example.org\nSubject: Press inquiry about genomeOS\n\n${draft.body}`,
    );
  });
});

describe('the mailto: link', () => {
  it('keeps the address bare and opens a blank email without a draft', () => {
    expect(mailtoUrl('team@example.org')).toBe('mailto:team@example.org');
  });

  it('encodes the subject and the body, with CRLF line breaks (RFC 6068)', () => {
    const draft = buildDraft({ topic: 'question', offers: [] });
    const url = mailtoUrl('team@example.org', draft);
    expect(url).toBe(
      `mailto:team@example.org?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body.replace(/\n/g, '\r\n'))}`,
    );
    expect(url).toContain('?subject=Question%20about%20genomeOS&body=');
    expect(url).toContain('Dear%20genomeOS%20Foundation%20team%2C%0D%0A%0D%0A');
    expect(url).toContain('%5BYour%20name%5D');
    expect(url).not.toMatch(/%0A(?<!%0D%0A)/);
    expect(url).not.toMatch(/[\s"<>]/);
    // It decodes back to the draft.
    const query = new URL(url).searchParams;
    expect(query.get('subject')).toBe(draft.subject);
    expect(query.get('body')).toBe(draft.body.replace(/\n/g, '\r\n'));
  });

  it('stays within 2,000 characters for the longest draft, every offer pressed', () => {
    const longest = mailtoUrl(
      contactAddress(),
      buildDraft({ topic: 'contribute', offers: [...OFFERS] }),
    );
    expect(MAILTO_MAX_LENGTH).toBe(2000);
    expect(longest.length).toBeLessThanOrEqual(MAILTO_MAX_LENGTH);
    for (const topic of TOPICS)
      for (const offers of subsets)
        expect(
          mailtoUrl(contactAddress(), buildDraft({ topic, offers })).length,
        ).toBeLessThanOrEqual(longest.length);
  });
});

describe('the query string', () => {
  it('preselects a purpose and the offers, in any order and case', () => {
    expect(parseQuery('?topic=contribute&offer=data,funding')).toEqual({
      topic: 'contribute',
      offers: ['data', 'funding'],
    });
    expect(parseQuery('?offer=funding,DATA&topic=Contribute')).toEqual({
      topic: 'contribute',
      offers: ['data', 'funding'],
    });
    expect(parseQuery('?topic=contribute&offer=code&offer=expertise')).toEqual({
      topic: 'contribute',
      offers: ['code', 'expertise'],
    });
    for (const topic of ['question', 'partner', 'press'] as const)
      expect(parseQuery(`?topic=${topic}`)).toEqual({ topic, offers: [] });
  });

  it('ignores unknown values', () => {
    const fallback = { topic: 'contribute', offers: [] };
    expect(parseQuery('')).toEqual(fallback);
    expect(parseQuery('?topic=report')).toEqual(fallback);
    expect(parseQuery('?topic=')).toEqual(fallback);
    expect(parseQuery('?topic=__proto__&offer=constructor')).toEqual(fallback);
    expect(parseQuery('?topic=contribute&offer=money,,time')).toEqual(fallback);
    expect(parseQuery('?topic=press&offer=data')).toEqual({
      topic: 'press',
      offers: [],
    });
    expect(parseQuery('?offer=code')).toEqual({
      topic: 'contribute',
      offers: ['code'],
    });
  });

  it('writes the state back as a link that reads the same', () => {
    expect(toQuery({ topic: 'contribute', offers: [] })).toBe(
      '?topic=contribute',
    );
    expect(toQuery({ topic: 'contribute', offers: ['funding', 'data'] })).toBe(
      '?topic=contribute&offer=data,funding',
    );
    // Offers belong to a contribution only.
    expect(toQuery({ topic: 'press', offers: ['data'] })).toBe('?topic=press');
    for (const topic of TOPICS)
      for (const offers of subsets) {
        const state = { topic, offers: topic === 'contribute' ? offers : [] };
        expect(parseQuery(toQuery(state))).toEqual(state);
      }
  });
});
