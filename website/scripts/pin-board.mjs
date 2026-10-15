#!/usr/bin/env node
/**
 * Pin the project board's cards that Contribute's "How work moves" shows (round 2 spec §4.3.4, plan
 * T5 step 1; #454). Reads, never writes: one read-only GraphQL query through the GitHub CLI (`gh api
 * graphql`, the CLI's own login; no token is read or written here), for the organisation's project
 * board and the pinned items, then writes `src/data/board-snapshot.json`:
 *
 *   { project: { title, number }, fetched: 'YYYY-MM-DD', items: [{ kind, number, title, state,
 *     labels: [{ name, color }], status }] }
 *
 * A discussion is not a board item (GitHub Projects cannot hold discussions), so its status is
 * "Discussion". The page maps statuses to its five columns (board-layout.ts `columnOf`); a pinned
 * item whose status maps to no column fails tests/board-snapshot.test.ts, so a stale pin is caught.
 *
 *   node scripts/pin-board.mjs                 # the default pins: discussion 76, issues 63 45 32 18
 *   node scripts/pin-board.mjs --discussion 76 --issues 63,45,32,18
 *
 * Refresh before a release (the cards go stale); keep Contribute within its word budget.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const OWNER = 'genomeOS';
const REPO = 'genomeOS';
const PROJECT = 1;
const OUT = path.resolve(
  import.meta.dirname,
  '../src/data/board-snapshot.json',
);

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const discussion = Number(option('discussion', '76'));
const issues = option('issues', '63,45,32,18').split(',').map(Number);

/** One read-only GraphQL request through the GitHub CLI. */
function graphql(query, variables = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables))
    args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const body = JSON.parse(out);
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const ITEMS = `query($owner: String!, $number: Int!, $after: String) {
  organization(login: $owner) {
    projectV2(number: $number) {
      title
      number
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content {
            __typename
            ... on Issue {
              number title state
              repository { name }
              labels(first: 30) { nodes { name color } }
            }
          }
          status: fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`;

const DISCUSSION = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { discussion(number: $number) { number title } }
}`;

let project = null;
const found = new Map();
let after = null;
do {
  const data = graphql(ITEMS, {
    owner: OWNER,
    number: PROJECT,
    ...(after ? { after } : {}),
  });
  const board = data.organization.projectV2;
  project ??= { title: board.title, number: board.number };
  for (const node of board.items.nodes) {
    const issue = node.content;
    if (issue?.__typename !== 'Issue' || issue.repository.name !== REPO)
      continue;
    if (!issues.includes(issue.number)) continue;
    found.set(issue.number, {
      kind: 'issue',
      number: issue.number,
      title: issue.title,
      state: issue.state.toLowerCase(),
      labels: issue.labels.nodes.map(({ name, color }) => ({
        name,
        color: `#${color.toUpperCase()}`,
      })),
      status: node.status?.name ?? 'No status',
    });
  }
  after = board.items.pageInfo.hasNextPage
    ? board.items.pageInfo.endCursor
    : null;
} while (after);

const missing = issues.filter((number) => !found.has(number));
if (missing.length)
  throw new Error(`Not on the board: #${missing.join(', #')}`);

const talk = graphql(DISCUSSION, {
  owner: OWNER,
  repo: REPO,
  number: discussion,
}).repository.discussion;
if (!talk) throw new Error(`No discussion #${discussion}`);

const snapshot = {
  project,
  // The pinner's own calendar day (en-CA formats it as YYYY-MM-DD).
  fetched: new Date().toLocaleDateString('en-CA'),
  items: [
    {
      kind: 'discussion',
      number: talk.number,
      title: talk.title,
      state: 'open',
      labels: [],
      status: 'Discussion',
    },
    ...issues.map((number) => found.get(number)),
  ],
};

writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `Pinned ${snapshot.items.length} cards from "${project.title}" on ${snapshot.fetched}: ${snapshot.items
    .map((item) => `#${item.number} ${item.status}`)
    .join(', ')}`,
);
