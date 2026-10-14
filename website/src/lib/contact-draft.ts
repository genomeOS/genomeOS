/**
 * The Contact page's email drafts (Contact page spec §3): a pure module with no DOM access, so the
 * letter's grammar, its sections, the subject, the `mailto:` link and the page's query string are
 * unit-tested directly (tests/contact-draft.test.ts). The page renders its live letter from the
 * same words, and its island builds every draft here.
 *
 *   buildDraft({ topic, offers })  → { subject, body }   the letter, lines joined with \n
 *   mailtoUrl(address, draft?)     → mailto:…            RFC 6068, CRLF line breaks
 *   draftText(address, draft)      → To / Subject / body as plain text (Copy draft)
 *   parseQuery(search) / toQuery(state)                  ?topic=contribute&offer=data,funding
 *
 * The address is never passed in here at build time: the page joins it only on a visitor's action
 * (src/lib/contact-address.ts).
 */

/** What the visitor is writing about (spec §3.1). Reporting a problem goes to GitHub Issues. */
export const TOPICS = ['contribute', 'question', 'partner', 'press'] as const;
export type Topic = (typeof TOPICS)[number];

/** What a contributor offers, in the order the letter lists them. */
export const OFFERS = ['code', 'data', 'expertise', 'funding'] as const;
export type Offer = (typeof OFFERS)[number];

export const TOPIC_LABELS: Readonly<Record<Topic, string>> = {
  contribute: 'Contribute',
  question: 'Ask a question',
  partner: 'Partner or collaborate',
  press: 'Press & media',
};

export const OFFER_LABELS: Readonly<Record<Offer, string>> = {
  code: 'Code',
  data: 'Data',
  expertise: 'Expertise',
  funding: 'Funding',
};

export interface DraftState {
  topic: Topic;
  /** Pressed offers. Only a contribution reads them. */
  offers: readonly Offer[];
}

export interface Draft {
  subject: string;
  /** The letter, lines joined with \n and blocks separated by a blank line. */
  body: string;
}

export type SectionId = 'about' | Offer | Exclude<Topic, 'contribute'>;

export interface Section {
  id: SectionId;
  heading: string;
  /** Each a `- label:` line in the letter, written without its dash. */
  fields: readonly string[];
}

export const GREETING = 'Dear genomeOS Foundation team,';
export const SIGN_OFF = ['Best regards,', '[Your name]'] as const;
/** Where the offers go in a contribution's opening until one is chosen. */
export const OFFER_PLACEHOLDER = '[code / data / expertise / funding]';
/** The longest draft, every offer pressed, stays a link mail apps accept (spec §3.3). */
export const MAILTO_MAX_LENGTH = 2000;

export const SECTIONS: Readonly<Record<SectionId, Section>> = {
  about: {
    id: 'about',
    heading: 'About me',
    fields: ['Name:', 'Affiliation:', 'Role:'],
  },
  code: {
    id: 'code',
    heading: 'Code',
    fields: [
      "What I'd like to work on (Atlas, pipeline, docs, other):",
      'GitHub username:',
      'Relevant experience:',
    ],
  },
  data: {
    id: 'data',
    heading: 'Data',
    fields: [
      'Dataset (name or publication):',
      'Populations and sample size:',
      'Data type (genotypes, allele counts, phenotypes):',
      'Consent and access terms:',
    ],
  },
  expertise: {
    id: 'expertise',
    heading: 'Expertise',
    fields: ['Field:', "How I'd like to help:", 'Time I can offer:'],
  },
  funding: {
    id: 'funding',
    heading: 'Funding',
    fields: [
      'Organization:',
      'Kind of support (grant, donation, in-kind):',
      'Timeline:',
    ],
  },
  question: {
    id: 'question',
    heading: 'My question',
    fields: ['Question:', 'Related page or link:'],
  },
  partner: {
    id: 'partner',
    heading: 'Proposal',
    fields: ['Organization:', "What we'd like to do together:", 'Timeline:'],
  },
  press: {
    id: 'press',
    heading: 'Press inquiry',
    fields: ['Outlet:', 'Topic:', 'Deadline:'],
  },
};

/** The opening for each purpose; a contribution's names its offers. */
export const OPENINGS: Readonly<Record<Topic, string>> = {
  contribute: "I'd like to contribute to genomeOS by providing {offers}.",
  question: 'I have a question about genomeOS.',
  partner: "I'd like to discuss a partnership or collaboration with genomeOS.",
  press: "I'm writing with a press inquiry about genomeOS.",
};

export const SUBJECTS: Readonly<Record<Topic, string>> = {
  contribute: 'Contributing to genomeOS',
  question: 'Question about genomeOS',
  partner: 'Partnership proposal for genomeOS',
  press: 'Press inquiry about genomeOS',
};

export const isTopic = (value: string): value is Topic =>
  (TOPICS as readonly string[]).includes(value);
export const isOffer = (value: string | undefined): value is Offer =>
  (OFFERS as readonly string[]).includes(value ?? '');

/** Known offers only, once each, in the letter's order. */
export function normalizeOffers(values: Iterable<string>): Offer[] {
  const wanted = new Set(
    [...values].map((value) => value.trim().toLowerCase()),
  );
  return OFFERS.filter((offer) => wanted.has(offer));
}

/** The offers a draft actually uses: a contribution's, in order; none for any other purpose. */
function offersOf({ topic, offers }: DraftState): Offer[] {
  return topic === 'contribute' ? normalizeOffers(offers) : [];
}

/** "code", "code and data", "code, data and funding": lower case, no serial comma. */
export function offerList(offers: readonly Offer[]): string {
  const words = normalizeOffers(offers);
  if (words.length === 0) return OFFER_PLACEHOLDER;
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** What a contribution's subject adds for its offers: ": code, data", or nothing. */
export function subjectSuffix(offers: readonly Offer[]): string {
  const words = normalizeOffers(offers);
  return words.length === 0 ? '' : `: ${words.join(', ')}`;
}

export function opening(state: DraftState): string {
  return OPENINGS[state.topic].replace('{offers}', offerList(offersOf(state)));
}

export function subject(state: DraftState): string {
  const base = SUBJECTS[state.topic];
  return state.topic === 'contribute'
    ? `${base}${subjectSuffix(offersOf(state))}`
    : base;
}

/** About me, then one section per offer (a contribution) or the purpose's own section. */
export function draftSections(state: DraftState): Section[] {
  const rest: SectionId[] =
    state.topic === 'contribute' ? offersOf(state) : [state.topic];
  return [SECTIONS.about, ...rest.map((id) => SECTIONS[id])];
}

export function buildDraft(state: DraftState): Draft {
  const blocks = [
    GREETING,
    opening(state),
    ...draftSections(state).map(({ heading, fields }) =>
      [heading, ...fields.map((field) => `- ${field}`)].join('\n'),
    ),
    SIGN_OFF.join('\n'),
  ];
  return { subject: subject(state), body: blocks.join('\n\n') };
}

/**
 * `mailto:` per RFC 6068: the address bare after the scheme, then the subject and the body
 * percent-encoded, with CRLF line breaks (%0D%0A). Without a draft, a blank email.
 */
export function mailtoUrl(address: string, draft?: Draft): string {
  if (!draft) return `mailto:${address}`;
  const body = draft.body.replace(/\r?\n/g, '\r\n');
  return `mailto:${address}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(body)}`;
}

/** The draft as plain text, for webmail: To, Subject, a blank line, the body. */
export function draftText(address: string, draft: Draft): string {
  return `To: ${address}\nSubject: ${draft.subject}\n\n${draft.body}`;
}

/** `?topic=…&offer=a,b` (or repeated `offer`); anything unknown is ignored. */
export function parseQuery(search: string): DraftState {
  const query = new URLSearchParams(search);
  const asked = (query.get('topic') ?? '').trim().toLowerCase();
  const topic: Topic = isTopic(asked) ? asked : 'contribute';
  const offers =
    topic === 'contribute'
      ? normalizeOffers(
          query.getAll('offer').flatMap((value) => value.split(',')),
        )
      : [];
  return { topic, offers };
}

/** The query that reproduces a state; offers only for a contribution. */
export function toQuery(state: DraftState): string {
  const offers = offersOf(state);
  return offers.length === 0
    ? `?topic=${state.topic}`
    : `?topic=${state.topic}&offer=${offers.join(',')}`;
}
