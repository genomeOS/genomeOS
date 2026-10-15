/**
 * How it works, the moving parts (round 2 spec §4.1.4 storyboard; R2-7; #454). Imported by
 * pages/index.astro as the figure approaches (lazy chunk `how-it-works`, ≤ 8 KB gz). One 4.9 s story
 * on the scene timeline (src/graphics/timeline.ts), registered as `how-it-works`, played once at
 * 35% visible; Replay plays it again. Under reduced motion nothing is built and the
 * server-rendered figure (HowItWorks.astro) is the final state.
 *
 *   0–0.7 s     the wires draw (structure first)
 *   0.3–2.1 s   12 mixed records ride in, 4 per source, and shrink into the gate, which glows
 *   1.3–2.7 s   6 identical white studs leave the gate: one copy of each into the model, one along
 *               the measured lane, landing on the globe (never through the model)
 *   1.9–2.6 s   the model's layers light in turn; step 2's caption lights at 2.0 s
 *   2.6–3.5 s   7 teal hexes leave the model on the modeled lane
 *   3.0–3.8 s   the globe's cells fade in nearest a survey first; step 3 lights at 3.0 s
 *   3.9–4.6 s   hatched cells last (gaps stay gaps); the visitor's cursor glides in
 *   4.3–4.9 s   the model settles to rest
 *
 * Captions dim by colour (a registered --hiw-lit mixes faint into their own colours, home.css),
 * never by opacity, so they hold 4.5:1 at every instant.
 */
import {
  EASE,
  sceneController,
  type Frame,
  type Timeline,
} from '../../graphics/timeline';

export const STEPS_STORY = 4900;

const NS = 'http://www.w3.org/2000/svg';
const SHAPES = [
  'M-5 4 0 -5 5 4Z',
  'M-4 -4h8v8h-8Z',
  'M0 -5.5 5.5 0 0 5.5 -5.5 0Z',
  'M-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0Z',
  'M-6 -2.5h12v5h-12Z',
];
const HEX = 'M0 -7 6 -3.5v7L0 7l-6-3.5v-7Z';
const HEX_FILLS = [1, 3, 5, 2, 4, 6, 3].map(
  (step) => `var(--enc-mean-${step})`,
);
const GLOW = 'rgb(112 230 255 / 35%)';
const BRIGHT_EDGE = 'rgb(112 230 255 / 55%)';

const inOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

function make(tag: string, attrs: Record<string, string | number>): Element {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs))
    node.setAttribute(name, String(value));
  return node;
}

/**
 * A token riding `path` from `at` for `ms`: translate keys sampled along the path (eased in time
 * when `eased`), fading in over the first tenth and out over the last.
 */
function ride(
  path: SVGPathElement,
  at: number,
  ms: number,
  steps: number,
  eased: boolean,
): Frame[] {
  const length = path.getTotalLength();
  const frames: Frame[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const point = path.getPointAtLength(length * (eased ? inOut(t) : t));
    const opacity = t < 0.08 ? t / 0.08 : t > 0.92 ? (1 - t) / 0.08 : 1;
    frames.push([
      at + ms * t,
      {
        transform: `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`,
        opacity: Number(opacity.toFixed(3)),
      },
    ]);
  }
  return frames;
}

function build(tl: Timeline, figure: HTMLElement): void {
  const svg = [
    ...figure.querySelectorAll<SVGSVGElement>('svg[data-layout]'),
  ].find((candidate) => candidate.getClientRects().length > 0);
  if (!svg) return;
  const wire = (name: string) =>
    svg.querySelector<SVGPathElement>(`[data-wire="${name}"]`)!;
  const tokens = svg.querySelector('.hiw-tokens')!;
  tokens.replaceChildren();
  const add = (node: Element) => tokens.appendChild(node);
  const look = getComputedStyle(svg);
  const color = (name: string) => look.getPropertyValue(name).trim();

  // 0–0.7 s: the wires draw. The dashed inputs are revealed by a clip (a dash offset would lose
  // their dashes); the two lanes and the model's input draw along their length.
  const across = svg.querySelector<SVGGElement>('.hiw-in')!;
  tl.story(across, [
    [
      0,
      {
        clipPath:
          across.dataset.direction === 'x'
            ? 'inset(0 100% 0 0)'
            : 'inset(0 0 100% 0)',
      },
      EASE.out,
    ],
    [700, { clipPath: 'inset(0 0 0 0)' }],
  ]);
  for (const name of ['to-model', 'measured', 'modeled']) {
    const path = wire(name);
    const length = Math.ceil(path.getTotalLength()) + 1;
    const dash = `${length} ${length}`;
    tl.story(path, [
      [0, { strokeDasharray: dash, strokeDashoffset: length }, EASE.out],
      [700, { strokeDasharray: dash, strokeDashoffset: 0 }],
    ]);
  }

  // 0.3–2.1 s: mixed records (different formats) ride each input wire into the gate.
  for (let source = 0; source < 3; source += 1)
    for (let k = 0; k < 4; k += 1) {
      const token = add(make('g', { class: 'hiw-record', opacity: 0 }));
      token.appendChild(make('path', { d: SHAPES[(source * 2 + k) % 5] }));
      tl.story(
        token,
        ride(wire(`in${source}`), 300 + k * 270 + source * 90, 820, 20, true),
      );
    }
  const gate = svg.querySelector('.hiw-gate')!;
  const rest = getComputedStyle(gate).fill;
  tl.story(gate, [
    [800, { fill: rest }, EASE.inOut],
    [1500, { fill: GLOW }, EASE.inOut],
    [2200, { fill: rest }],
  ]);

  // 1.3–2.7 s: six identical studs leave the gate; each is one measurement on both lanes.
  const landed = [
    ...svg.querySelectorAll<SVGCircleElement>('.atlas-mark__studs circle'),
  ];
  for (let k = 0; k < 6; k += 1) {
    const at = 1300 + k * 130;
    const intoModel = add(
      make('circle', { class: 'hiw-stud', r: 4, opacity: 0 }),
    );
    tl.story(intoModel, ride(wire('to-model'), at, 520, 8, false));
    const measured = add(
      make('circle', {
        class: 'hiw-stud',
        r: 4,
        opacity: 0,
        'data-lane': 'measured',
      }),
    );
    tl.story(measured, ride(wire('measured'), at, 1300, 32, true));
    tl.story(landed[k] ?? null, [
      [at + 1260, { opacity: 0, transform: 'scale(2)' }, EASE.out],
      [at + 1520, { opacity: 1, transform: 'scale(1)' }],
    ]);
  }

  // 1.9–2.6 s: the model lights layer by layer, then settles to rest by 4.9 s.
  const dark = { fill: color('--color-plate'), stroke: color('--color-muted') };
  const lit = { fill: color('--color-ion'), stroke: color('--color-ion') };
  svg.querySelectorAll('.hiw-nodes').forEach((layer, k) =>
    tl.story(layer, [
      [1900 + k * 200, dark, EASE.out],
      [2160 + k * 200, lit],
      [4300, lit, EASE.inOut],
      [STEPS_STORY, dark],
    ]),
  );
  svg.querySelectorAll('.hiw-edges').forEach((layer, k) => {
    const dim = getComputedStyle(layer).stroke;
    tl.story(layer, [
      [2000 + k * 200, { stroke: dim }, EASE.out],
      [2300 + k * 200, { stroke: BRIGHT_EDGE }],
      [4300, { stroke: BRIGHT_EDGE }, EASE.inOut],
      [STEPS_STORY, { stroke: dim }],
    ]);
  });

  // 2.6–3.5 s: estimates leave the model as hexes (a stud never becomes a hex anywhere else).
  for (let k = 0; k < 7; k += 1) {
    const hex = add(make('path', { d: HEX, fill: HEX_FILLS[k], opacity: 0 }));
    tl.story(hex, ride(wire('modeled'), 2600 + k * 120, 760, 16, true));
  }

  // 3.0–3.8 s: the globe fills outward from the surveys (the mark lists its cells nearest-first);
  // 3.9 s on: the gaps, hatched.
  const cells = [
    ...svg.querySelectorAll<SVGPathElement>('.atlas-mark__cells path'),
  ];
  const solid = cells.filter((cell) => !cell.hasAttribute('data-hatch'));
  const hatched = cells.filter((cell) => cell.hasAttribute('data-hatch'));
  solid.forEach((cell, i) => {
    const at = 3000 + Math.round((i * 800) / solid.length);
    tl.story(cell, [
      [at, { opacity: 0 }, EASE.out],
      [at + 300, { opacity: 1 }],
    ]);
  });
  hatched.forEach((cell, i) =>
    tl.story(cell, [
      [3900 + i * 30, { opacity: 0 }],
      [4200 + i * 30, { opacity: 1 }],
    ]),
  );

  // 4.0–4.6 s: the visitor's cursor arrives on the globe.
  const cursor = svg.querySelector<SVGPathElement>('.hiw-cursor')!;
  const x = Number(cursor.dataset.x);
  const y = Number(cursor.dataset.y);
  tl.story(cursor, [
    [
      4000,
      { opacity: 0, transform: `translate(${x + 44}px, ${y + 48}px)` },
      EASE.inOut,
    ],
    [4600, { opacity: 1, transform: `translate(${x}px, ${y}px)` }],
  ]);

  // Steps 2 and 3 light as their stages do.
  for (const [step, at] of [
    ['2', 2000],
    ['3', 3000],
  ] as const)
    tl.story(figure.querySelector(`.hiw-step[data-step="${step}"]`), [
      [at, { '--hiw-lit': 0 }, EASE.out],
      [at + 240, { '--hiw-lit': 1 }],
    ]);
}

export function initHowItWorks(figure: HTMLElement): void {
  sceneController(figure, (tl) => build(tl, figure), {
    name: 'how-it-works',
    timeline: { story: STEPS_STORY },
    controls: {
      replay: figure.querySelector<HTMLButtonElement>('[data-scene-replay]'),
    },
  });
}
