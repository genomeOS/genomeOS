/**
 * The astronaut kit (round 2 spec §3.1, §11.1; R2-6; #454): the TypeScript port draws exactly what
 * the design prototype drew, covers every beat the storyboards need, keeps its weight, anchors
 * speech bubbles to the speaker, and keeps its accents away from the site's status colours.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CAST, CAST_IDS, BUILDS } from '../src/graphics/astro/cast';
import { ACCENT, C, SKIN } from '../src/graphics/astro/palette';
import { POSES, POSE_NAMES, type PoseName } from '../src/graphics/astro/poses';
import {
  KIT_CSS,
  anchors,
  astronaut,
  ghost,
  helmet,
  kitDefs,
  solve,
  type AstronautOptions,
} from '../src/graphics/astro/rig';
import {
  avatar,
  bubble,
  chartCard,
  spaceship,
  tablet,
  workbench,
} from '../src/graphics/astro/props';

const table = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, 'fixtures/astro-kit.sha256.json'),
    'utf8',
  ),
) as {
  astronaut: Record<string, string>;
  lite: Record<string, string>;
  helmet: Record<string, string>;
  ghost: Record<string, string>;
  kitDefs: string;
  options: Record<string, string>;
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const elements = (markup: string) =>
  (markup.match(/<(?!\/)[a-zA-Z]/g) ?? []).length;

describe('the astronaut kit draws what the prototype drew', () => {
  it('has the eleven cast members and thirty poses of the prototype', () => {
    expect(CAST_IDS).toEqual([
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
      'A7',
      'A8',
      'E1',
      'E2',
      'E3',
    ]);
    expect(POSE_NAMES).toHaveLength(30);
    expect(Object.keys(table.astronaut)).toHaveLength(
      CAST_IDS.length * POSE_NAMES.length,
    );
  });

  it('matches the prototype byte for byte, for every cast member in every pose', () => {
    const mismatched: string[] = [];
    for (const cast of CAST_IDS)
      for (const pose of POSE_NAMES)
        if (sha(astronaut(cast, pose)) !== table.astronaut[`${cast}/${pose}`])
          mismatched.push(`${cast}/${pose}`);
    expect(mismatched).toEqual([]);
  });

  it('matches it for the lite figure, the helmet, the ghost and the shared defs', () => {
    for (const cast of CAST_IDS) {
      expect(sha(astronaut(cast, 'stand', { lod: 'lite' })), cast).toBe(
        table.lite[cast],
      );
      expect(sha(helmet(cast, 'smile', { noAntenna: true })), cast).toBe(
        table.helmet[cast],
      );
    }
    for (const build of Object.keys(BUILDS) as (keyof typeof BUILDS)[])
      expect(sha(ghost(build)), build).toBe(table.ghost[build]);
    expect(sha(kitDefs())).toBe(table.kitDefs);
    expect(KIT_CSS).toBe(
      '.astro .j{transform-box:view-box;transform-origin:0 0}',
    );
  });

  it('matches it on the option paths the scenes use', () => {
    const cases: [
      string,
      Parameters<typeof astronaut>[0],
      PoseName,
      AstronautOptions,
    ][] = [
      ['A3/present face-1', 'A3', 'present', { face: -1 }],
      ['A2/stand x40', 'A2', 'stand', { x: 40 }],
      ['A1/carry holdBlock lit', 'A1', 'carry', { holdBlock: 'lit' }],
      ['A3/hammerUp crateLit', 'A3', 'hammerUp', { crateLit: true }],
      ['E1/stand propN clipboard', 'E1', 'stand', { propN: 'clipboard' }],
      [
        'A6/stand propFar pick noShadow',
        'A6',
        'stand',
        { propFar: 'pick', noShadow: true },
      ],
      ['A5/idea expr talk', 'A5', 'idea', { expr: 'talk' }],
    ];
    for (const [key, cast, pose, options] of cases)
      expect(sha(astronaut(cast, pose, options)), key).toBe(table.options[key]);
  });

  it('draws the same markup every time (no randomness, no counters)', () => {
    expect(astronaut('E1', 'celebrate')).toBe(astronaut('E1', 'celebrate'));
    expect(spaceship(['A4', 'A2', 'A3'])).toBe(spaceship(['A4', 'A2', 'A3']));
    expect(avatar('A6', 11)).toBe(avatar('A6', 11));
  });
});

describe('the poses cover every beat of the storyboards (R2-6)', () => {
  it.each([
    ['float and land', ['float', 'crouch', 'stand']],
    ['hop (low gravity)', ['crouch', 'hop']],
    ['walk', ['walkA', 'walkMid', 'walkB']],
    ['sit', ['sit']],
    ['chat (speech bubbles)', ['chat', 'listen']],
    ['scroll a list', ['scroll']],
    ['lightbulb idea', ['idea']],
    ['hammer and inspect', ['hammerUp', 'hammerHit', 'inspect']],
    ['present (raise a block)', ['present']],
    ['think (hand on chin)', ['think']],
    ['nod', ['nod']],
    ['carry', ['carry']],
    ['fit a block', ['fit']],
    ['celebrate (jump)', ['celebrate']],
  ])('%s', (_beat, poses) => {
    for (const pose of poses) expect(POSES).toHaveProperty(pose);
  });

  it('raises the presented block clear of the helmet, and puts the thinker’s glove on the chin', () => {
    for (const cast of CAST_IDS) {
      // Raised above the helmet's centre and held in front of it, never over the visor.
      const present = anchors(cast, solve(cast, POSES.present));
      expect(present.block![1], cast).toBeLessThan(present.helmet[1]);
      expect(present.block![0], cast).toBeGreaterThan(present.helmet[0]);
      const think = anchors(cast, solve(cast, POSES.think));
      expect(
        Math.hypot(
          think.handN[0] - think.visor[0],
          think.handN[1] - think.visor[1],
        ),
        cast,
      ).toBeLessThan(think.hr * 1.2);
    }
  });
});

describe('weight', () => {
  const plain = POSE_NAMES.filter((pose) => {
    const spec = POSES[pose];
    return !(
      spec.prop ||
      spec.prop2 ||
      spec.propF ||
      spec.block ||
      spec.bench ||
      spec.seat
    );
  });

  it('keeps every astronaut to 85 elements, with nothing in its hands', () => {
    for (const cast of CAST_IDS)
      for (const pose of plain)
        expect(
          elements(astronaut(cast, pose)),
          `${cast}/${pose}`,
        ).toBeLessThanOrEqual(85);
  });

  it('keeps an astronaut near 6.5 KB of markup: the cast standing averages under it', () => {
    const sizes = CAST_IDS.map((cast) => astronaut(cast, 'stand').length);
    const mean = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
    expect(mean).toBeLessThanOrEqual(6.5 * 1024);
    // The experts' coats, beards and glasses cost the most: never past 7 KB in any plain pose.
    for (const cast of CAST_IDS)
      for (const pose of plain)
        expect(
          astronaut(cast, pose).length,
          `${cast}/${pose}`,
        ).toBeLessThanOrEqual(7 * 1024);
  });

  it('drops knee pads, cuffs, chest lights and patches at the lite level of detail', () => {
    for (const cast of CAST_IDS)
      expect(elements(astronaut(cast, 'stand', { lod: 'lite' }))).toBeLessThan(
        elements(astronaut(cast, 'stand')),
      );
  });
});

describe('speech bubbles point at the speaker', () => {
  const tip = (markup: string): [number, number] => {
    const [, tx, ty] = markup
      .match(/translate\(([-\d.]+) ([-\d.]+)\)/)!
      .map(Number);
    const path = markup.match(/<path d="([^"]+)"/)![1];
    // The tail's tip is the one L command that leaves the bubble's bottom edge.
    const points = [...path.matchAll(/L([-\d.]+) ([-\d.]+)/g)].map(
      ([, x, y]) => [Number(x), Number(y)] as const,
    );
    const [x, y] = points.reduce((low, point) =>
      point[1] > low[1] ? point : low,
    );
    return [tx + x, ty + y];
  };

  it.each(['chat', 'listen', 'think'] as const)(
    'a %s bubble’s tail lands at the helmet top',
    (pose) => {
      for (const cast of CAST_IDS) {
        const { headTop } = anchors(cast, solve(cast, POSES[pose]));
        const [x, y] = tip(
          bubble(headTop[0], headTop[1], 'Hi!', { tail: 'c', lift: 4 }),
        );
        expect(
          Math.hypot(x - headTop[0], y - headTop[1]),
          cast,
        ).toBeLessThanOrEqual(4);
        for (const tail of ['l', 'r'] as const) {
          const [sx, sy] = tip(
            bubble(headTop[0], headTop[1], 'Hi!', { tail, lift: 4 }),
          );
          expect(
            Math.abs(sy - headTop[1]),
            `${cast} ${tail}`,
          ).toBeLessThanOrEqual(4 + 1e-9);
          expect(
            Math.abs(sx - headTop[0]),
            `${cast} ${tail}`,
          ).toBeLessThanOrEqual(3 + 1e-9);
        }
      }
    },
  );
});

/* ------------------------------------------------------------------------------------ colour */

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
/** OKLab, ported from the design tools (r2/characters/tools/palette.py). */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) =>
    lin(parseInt(hex.slice(i, i + 2), 16)),
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const deltaE = (a: string, b: string) => {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
const tokens = readFileSync(
  path.resolve(import.meta.dirname, '../src/styles/tokens.css'),
  'utf8',
);
const token = (name: string) =>
  tokens.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'))![1];

describe('colour', () => {
  it('keeps every accent at an OKLab ΔE of 0.12 or more from ion, aurora, genome and signal', () => {
    const accents = {
      ...Object.fromEntries(
        Object.entries(ACCENT).map(([name, [base]]) => [name, base]),
      ),
      bulb: C.bulb,
    };
    for (const [name, hex] of Object.entries(accents))
      for (const status of ['ion', 'aurora', 'genome', 'signal'])
        expect(
          deltaE(hex, token(status)),
          `${name} vs ${status}`,
        ).toBeGreaterThanOrEqual(0.12);
  });

  it('draws six skin tones, the deepest on a contributor and on an expert', () => {
    expect(Object.keys(SKIN)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(new Set(Object.values(CAST).map((member) => member.skin)).size).toBe(
      6,
    );
    const deepest = CAST_IDS.filter((id) => CAST[id].skin === 's6');
    expect(deepest.some((id) => id.startsWith('A'))).toBe(true);
    expect(deepest.some((id) => id.startsWith('E'))).toBe(true);
  });

  it('lets genome violet into a figure only as the dashed "Your spot" ghost', () => {
    const genome = token('genome');
    for (const cast of CAST_IDS)
      for (const pose of POSE_NAMES)
        expect(astronaut(cast, pose).toLowerCase()).not.toContain(genome);
    expect(ghost()).toContain(`stroke="${genome}"`);
    expect(ghost()).toContain('stroke-dasharray');
  });
});

describe('props new in the build', () => {
  it('puts a glyph on the coder’s tablet, escaped, and keeps the list rows by default', () => {
    expect(tablet('</>')).toContain('&lt;/&gt;');
    expect(tablet()).toContain('tablet-rows');
    expect(astronaut('A2', 'scroll', { tabletGlyph: '</>' })).toContain(
      '&lt;/&gt;',
    );
  });

  it('holds a chart card in place of the block when asked', () => {
    const presenting = astronaut('A4', 'present', { held: chartCard() });
    expect(presenting).toContain('prop-chart-card');
    expect(presenting).not.toContain('prop-block');
  });

  it('draws a workbench beside a seated figure', () => {
    expect(workbench('A6')).toContain('prop-crate');
    expect(workbench('A6', { block: false })).not.toContain('crate-block');
  });
});

describe('determinism under src/graphics', () => {
  it('never calls Math.random (SEED = 42 and mulberry32 for anything seeded)', () => {
    const root = path.resolve(import.meta.dirname, '../src/graphics');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? files(full) : [full];
      });
    for (const file of files(root))
      expect(readFileSync(file, 'utf8'), path.relative(root, file)).not.toMatch(
        /Math\.random/,
      );
  });
});
