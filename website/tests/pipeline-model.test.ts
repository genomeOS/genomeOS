/**
 * The shared Pipeline's data model (site redesign spec §3.1, §6.1 rule 1; #454).
 *
 * Measured counts and modeled estimates travel separate lanes that never join; a measured packet
 * never passes through a model or the validation gate; a stud becomes a modeled hex only on an
 * edge leaving a model node; and nothing in the model carries the repository's P-codes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PIPELINE,
  PIPELINE_MODES,
  PIPELINE_STAGE_WIDTH,
  PIPELINE_TYPE,
  SOCKET,
  edgePath,
  labelPlacement,
  laneTagBox,
  pipelineLayout,
  tabStopAfterModeChange,
  type Orientation,
  type PipelineLayout,
  type PipelineMode,
  type PipelineNode,
} from '../src/data/pipeline';

const MODEL_KINDS = new Set(['model']);
const LAYOUTS = (['h', 'v'] as const).flatMap((orient) =>
  [true, false].map((brackets) => ({ orient, brackets })),
);

/**
 * Text width at `size` units, by character class: narrow 0.32 em, wide 0.77 em, others 0.6 em.
 * Fitted to every Pipeline string measured in Figtree at its weights in Chromium; it overestimates
 * each of them by 0–10% and underestimates none.
 */
const NARROW = new Set("iljtfr ,.-'():;!|");
const WIDE = new Set('mwMWOQGDHNCU%');
const textWidth = (text: string, size: number) =>
  [...text].reduce(
    (sum, character) =>
      sum + (NARROW.has(character) ? 0.32 : WIDE.has(character) ? 0.77 : 0.6),
    0,
  ) * size;

type Box = { left: number; right: number; top: number; bottom: number };

/** A node's label as one box per line (its label lines, then its sub line), in layout units. */
function labelBoxes(layout: PipelineLayout, node: PipelineNode): Box[] {
  const T = PIPELINE_TYPE[layout.orient];
  const [x, y] = layout.pos[node.key];
  const place = labelPlacement(layout, node.key);
  const rows = [
    ...node.label.map((text) => ({ text, size: T.label })),
    ...(node.sub ? [{ text: node.sub, size: T.sub }] : []),
  ];
  return rows.map(({ text, size }, index) => {
    const width = textWidth(text, size);
    const left =
      place.anchor === 'middle'
        ? place.x - width / 2
        : place.anchor === 'end'
          ? place.x - width
          : place.x;
    const baseline = y + place.y + index * T.line;
    return {
      left: x + left,
      right: x + left + width,
      top: baseline - size * 0.75,
      bottom: baseline + size * 0.25,
    };
  });
}

/** The gap between two boxes (negative when they overlap). */
const gap = (a: Box, b: Box) =>
  Math.max(
    a.left - b.right,
    b.left - a.right,
    a.top - b.bottom,
    b.top - a.bottom,
  );

/** Points along an SVG path made of M, L and C commands (absolute), 24 per segment. */
function samplePath(d: string): [number, number][] {
  const tokens = d.match(/[MLC]|-?[\d.]+/g)!;
  const points: [number, number][] = [];
  let index = 0;
  let current: [number, number] = [0, 0];
  const read = (): [number, number] => [
    Number(tokens[index++]),
    Number(tokens[index++]),
  ];
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') {
      current = read();
      points.push(current);
    } else if (command === 'L') {
      const end = read();
      for (let k = 1; k <= 24; k += 1) {
        const t = k / 24;
        points.push([
          current[0] + (end[0] - current[0]) * t,
          current[1] + (end[1] - current[1]) * t,
        ]);
      }
      current = end;
    } else if (command === 'C') {
      const [a, b, end] = [read(), read(), read()];
      for (let k = 1; k <= 24; k += 1) {
        const t = k / 24;
        const u = 1 - t;
        const at = (axis: 0 | 1) =>
          u * u * u * current[axis] +
          3 * u * u * t * a[axis] +
          3 * u * t * t * b[axis] +
          t * t * t * end[axis];
        points.push([at(0), at(1)]);
      }
      current = end;
    } else throw new Error(`unexpected path command ${command} in ${d}`);
  }
  return points;
}

describe.each(PIPELINE_MODES)('Pipeline mode %s', (mode: PipelineMode) => {
  const data = PIPELINE[mode];
  const kind = (key: string) =>
    data.nodes.find((node) => node.key === key)!.kind;

  it('has the documented nodes in order', () => {
    expect(data.nodes.map((node) => node.label.join(' '))).toEqual(
      mode === 3
        ? [
            'Published samples',
            'Counted observations',
            'Offline model',
            'Modeled surface',
            'The Atlas',
          ]
        : [
            'Population-location registry',
            'Observations',
            'Frequency modeling',
            'Disease-burden modeling',
            'Validation gate',
            'Data service',
            'Interactive public map',
          ],
    );
  });

  it('gives every edge exactly one lane, and the two lanes no shared edge', () => {
    for (const edge of data.edges)
      expect(['source', 'measured', 'modeled']).toContain(edge.lane);
    const wires = data.edges.map(
      (edge) => `${edge.from}>${edge.to}:${edge.port ?? 'centre'}`,
    );
    expect(new Set(wires).size).toBe(wires.length);
    // Where both lanes connect the same two nodes, they arrive at different ports.
    for (const measured of data.edges.filter(
      (edge) => edge.lane === 'measured',
    ))
      for (const modeled of data.edges.filter(
        (edge) => edge.lane === 'modeled',
      ))
        if (measured.from === modeled.from && measured.to === modeled.to)
          expect(measured.port).not.toBe(modeled.port);
  });

  it('keeps the measured lane away from every model and the gate', () => {
    const measured = data.edges.filter((edge) => edge.lane === 'measured');
    expect(measured.length).toBeGreaterThan(0);
    for (const edge of measured) {
      for (const end of [edge.from, edge.to])
        expect(['model', 'gate'], `${edge.id}`).not.toContain(kind(end));
      expect(edge.packet).toBe('stud');
    }
    // It reaches the map, at the upper port.
    const final = measured.find((edge) => kind(edge.to) === 'map')!;
    expect(final.port ?? 'upper').toBe('upper');
  });

  it('turns a stud into a hex only on an edge leaving a model node', () => {
    const modeled = data.edges.filter((edge) => edge.lane === 'modeled');
    for (const edge of modeled) {
      const incoming = modeled.filter((other) => other.to === edge.from);
      if (edge.packet === 'stud')
        expect(MODEL_KINDS.has(kind(edge.from)), edge.id).toBe(false);
      if (
        edge.packet === 'hex' &&
        incoming.every((other) => other.packet === 'stud')
      )
        expect(kind(edge.from), `${edge.id} becomes a hex`).toBe('model');
    }
    // The modeled lane starts as studs from the observations and ends as hexes at the map.
    expect(modeled.find((edge) => edge.from === 'observations')?.packet).toBe(
      'stud',
    );
    const arrival = modeled.find((edge) => kind(edge.to) === 'map')!;
    expect(arrival.packet).toBe('hex');
    expect(arrival.port ?? 'lower').toBe('lower');
  });

  it('only passes source material along the source lane', () => {
    for (const edge of data.edges)
      expect(edge.lane === 'source').toBe(edge.packet === 'square');
  });

  it('names its parts with part-* ids', () => {
    for (const node of data.nodes) expect(node.id).toMatch(/^part-[a-z-]+$/);
    expect(new Set(data.nodes.map((node) => node.id)).size).toBe(
      data.nodes.length,
    );
  });

  it('routes every edge in both orientations', () => {
    for (const { orient, brackets } of LAYOUTS)
      for (const edge of data.edges)
        expect(edgePath(pipelineLayout(mode, orient, brackets), edge)).toMatch(
          /^M[\d.-]+ [\d.-]+/,
        );
  });

  it('places every node and wire inside its layout', () => {
    for (const { orient, brackets } of LAYOUTS) {
      const layout = pipelineLayout(mode, orient, brackets);
      const inside = ([x, y]: readonly [number, number], margin: number) => {
        expect(x).toBeGreaterThanOrEqual(margin);
        expect(x).toBeLessThanOrEqual(layout.width - margin);
        expect(y).toBeGreaterThanOrEqual(layout.top + margin);
        expect(y).toBeLessThanOrEqual(layout.top + layout.height - margin);
      };
      for (const node of data.nodes) inside(layout.pos[node.key], SOCKET);
      for (const edge of data.edges)
        for (const point of samplePath(edgePath(layout, edge)))
          inside(point, 0);
    }
  });

  it('keeps the vertical stage heads clear of every wire', () => {
    // Each head is a block of text with a short hairline under it (design review, fix round 1:
    // the hairline used to run the full width and cross both lanes).
    const layout = pipelineLayout(mode, 'v', true);
    expect(layout.heads).toHaveLength(data.stages.length);
    for (const head of layout.heads!) {
      const box = {
        left: head.x - 4,
        right: head.x + head.rule + 4,
        top: head.y - PIPELINE_TYPE.v.stage,
        bottom: head.ruleY + 4,
      };
      for (const edge of data.edges)
        for (const [x, y] of samplePath(edgePath(layout, edge)))
          expect(
            x > box.left && x < box.right && y > box.top && y < box.bottom,
            `${edge.id} crosses "${head.lines.join(' ')}" at ${x.toFixed(0)}, ${y.toFixed(0)}`,
          ).toBe(false);
    }
  });

  it('keeps every label clear of every wire, socket and lane tag', () => {
    // Labels sit under their sockets (or beside them in the vertical layout's modeled column);
    // a wire through a label, or a label under a tag, is a collision (spec Appendix A fix n).
    for (const { orient, brackets } of LAYOUTS) {
      const layout = pipelineLayout(mode, orient, brackets);
      const where = `${orient}${brackets ? '' : ' bare'}`;
      const tags = (['measured', 'modeled'] as const).map((lane) =>
        laneTagBox(data, layout, lane),
      );
      for (const node of data.nodes) {
        const boxes = labelBoxes(layout, node);
        for (const box of boxes)
          for (const edge of data.edges)
            for (const [x, y] of samplePath(edgePath(layout, edge)))
              // The boxes already run 0–10% wide; the wire's own half-width is the margin.
              expect(
                x > box.left - 1 &&
                  x < box.right + 1 &&
                  y > box.top - 1 &&
                  y < box.bottom + 1,
                `${where}: ${edge.id} crosses the ${node.key} label at ${x.toFixed(0)}, ${y.toFixed(0)}`,
              ).toBe(false);
        const nearest = (others: Box[]) =>
          Math.min(
            ...boxes.flatMap((box) => others.map((other) => gap(box, other))),
          );
        for (const other of data.nodes) {
          const [x, y] = layout.pos[other.key];
          const socket = {
            left: x - SOCKET,
            right: x + SOCKET,
            top: y - SOCKET,
            bottom: y + SOCKET,
          };
          expect(
            nearest([socket]),
            `${where}: the ${node.key} label and the ${other.key} socket`,
          ).toBeGreaterThanOrEqual(other.key === node.key ? 4 : 8);
          if (other.key !== node.key)
            expect(
              nearest(labelBoxes(layout, other)),
              `${where}: the ${node.key} and ${other.key} labels`,
            ).toBeGreaterThanOrEqual(8);
        }
        expect(
          nearest(tags),
          `${where}: the ${node.key} label and a lane tag`,
        ).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('gives each lane tag room on its wire, clear of every socket and arrowhead', () => {
    // The mode-6 "Modeled" tag sat on a 98-unit wire with about 8 units to each socket
    // (design review, fix round 2). 14 units leaves the 7-unit arrowhead a clear gap.
    for (const { orient, brackets } of LAYOUTS) {
      const layout = pipelineLayout(mode, orient, brackets);
      for (const lane of ['measured', 'modeled'] as const) {
        const tag = laneTagBox(data, layout, lane);
        for (const node of data.nodes) {
          const [x, y] = layout.pos[node.key];
          const gapX = Math.max(
            tag.left - (x + SOCKET),
            x - SOCKET - tag.right,
          );
          const gapY = Math.max(
            tag.top - (y + SOCKET),
            y - SOCKET - tag.bottom,
          );
          expect(
            Math.max(gapX, gapY),
            `${orient}${brackets ? '' : ' bare'}: ${lane} tag to ${node.key}`,
          ).toBeGreaterThanOrEqual(14);
        }
      }
    }
  });

  it('drops the bracket band when it draws no stage brackets', () => {
    for (const orient of ['h', 'v'] as const) {
      const bare = pipelineLayout(mode, orient, false);
      const full = pipelineLayout(mode, orient, true);
      expect(bare.heads).toBeNull();
      expect(bare.height).toBeLessThan(full.height);
      // The first mark sits near the top of the box: no empty band above it.
      const firstMark = Math.min(
        ...data.nodes.map((node) => bare.pos[node.key][1] - SOCKET),
        ...data.edges.flatMap((edge) =>
          samplePath(edgePath(bare, edge)).map(([, y]) => y),
        ),
      );
      expect(firstMark - bare.top, orient).toBeLessThanOrEqual(30);
    }
  });
});

describe('Pipeline labels stay 13 px or more (spec §2.3)', () => {
  const smallest = (orient: Orientation) =>
    Math.min(
      PIPELINE_TYPE[orient].label,
      PIPELINE_TYPE[orient].sub,
      PIPELINE_TYPE[orient].stage,
      PIPELINE_TYPE[orient].lane,
    );

  it.each(['h', 'v'] as const)(
    'the %s layout at the narrowest stage it is drawn in',
    (orient) => {
      for (const { brackets } of LAYOUTS)
        for (const mode of PIPELINE_MODES) {
          const { width } = pipelineLayout(mode, orient, brackets);
          const scale = PIPELINE_STAGE_WIDTH[orient].min / width;
          expect(smallest(orient) * scale).toBeGreaterThanOrEqual(13);
          // One unit is about one CSS px at that width: the viewBox is within ±20% of it.
          expect(width / PIPELINE_STAGE_WIDTH[orient].min).toBeLessThanOrEqual(
            1.2,
          );
          expect(
            width / PIPELINE_STAGE_WIDTH[orient].min,
          ).toBeGreaterThanOrEqual(0.8);
        }
    },
  );

  it('chooses the layout from the plate, not the viewport', () => {
    // The Docs column is narrower than the page, so a viewport breakpoint drew the horizontal
    // layout there at half size (design review, fix round 1).
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../src/components/kit/Pipeline.astro'),
      'utf8',
    );
    expect(source).toMatch(/container:\s*kit-pipeline\s*\/\s*inline-size/);
    expect(source).toContain(
      `@container kit-pipeline (min-width: ${PIPELINE_STAGE_WIDTH.h.min}px)`,
    );
    expect(source).not.toMatch(/@media \((max|min)-width: [\d.]+rem\)/);
    // The vertical layout stops growing before its labels get coarse.
    expect(source).toContain(`max-width: ${PIPELINE_STAGE_WIDTH.v.max}px`);
    expect(
      PIPELINE_STAGE_WIDTH.v.max / pipelineLayout(6, 'v', true).width,
    ).toBeLessThanOrEqual(1.35);
  });

  it('wraps a stage title in the vertical layout without changing its words', () => {
    for (const mode of PIPELINE_MODES)
      for (const head of pipelineLayout(mode, 'v', true).heads!)
        expect(PIPELINE[mode].stages.map((stage) => stage.label)).toContain(
          head.lines.join(' '),
        );
  });
});

describe('the Pipeline keyboard tab stop across a mode change', () => {
  it('stays on a part both modes share', () => {
    expect(tabStopAfterModeChange('observations', 3)).toBe('observations');
    expect(tabStopAfterModeChange('map', 6)).toBe('map');
  });

  it('moves to the first part when the new mode lacks it', () => {
    // A keyboard user arrowed to the gate, then chose "3 stages": the gate is hidden, so Tab
    // would skip the whole figure (design review, fix round 1).
    for (const key of ['gate', 'service', 'burden'])
      expect(tabStopAfterModeChange(key, 3)).toBe(PIPELINE[3].nodes[0].key);
    expect(tabStopAfterModeChange('surface', 6)).toBe(PIPELINE[6].nodes[0].key);
    expect(tabStopAfterModeChange(null, 6)).toBe(PIPELINE[6].nodes[0].key);
  });
});

describe('the Pipeline copy', () => {
  it('uses the three stage names, in order', () => {
    for (const mode of PIPELINE_MODES)
      expect(PIPELINE[mode].stages.map((stage) => stage.label)).toEqual([
        'Aggregate the evidence',
        'Model what the evidence supports',
        'Open it to the world',
      ]);
  });

  it('marks the gate as validation, in words that match the Atlas', () => {
    const gate = PIPELINE[6].nodes.find((node) => node.kind === 'gate')!;
    expect(gate.caption).toContain('not yet validated');
    expect(gate.caption).not.toMatch(/nothing ships/i);
  });

  it('carries no invented counts and no P-codes', () => {
    const text = JSON.stringify(PIPELINE);
    expect(text).not.toMatch(/\bP[0-9]\b/);
    expect(text).not.toMatch(/\b\d+ of \d+\b/);
    for (const file of [
      '../src/data/pipeline.ts',
      '../src/components/kit/Pipeline.astro',
      '../src/components/kit/pipeline.ts',
    ])
      expect(
        readFileSync(path.resolve(import.meta.dirname, file), 'utf8'),
        file,
      ).not.toMatch(/P[0-5]/);
  });
});
