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
  edgePath,
  type PipelineMode,
} from '../src/data/pipeline';

const MODEL_KINDS = new Set(['model']);

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
    for (const orient of ['h', 'v'] as const)
      for (const edge of data.edges)
        expect(edgePath(data, edge, orient)).toMatch(/^M[\d.-]+ [\d.-]+/);
  });

  it('places every node inside its layout', () => {
    for (const orient of ['h', 'v'] as const) {
      const layout = data.layouts[orient];
      for (const node of data.nodes) {
        const [x, y] = layout.pos[node.key];
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(layout.width);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(layout.height);
      }
    }
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
