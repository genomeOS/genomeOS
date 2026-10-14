/** The evidence pipeline, as data: one source for Home (3 stages), Project (6 parts) and the Docs
 * map (site redesign spec §3.1, #454).
 *
 * Two lanes that never join. The measured lane (white studs) leaves the observations, bypasses
 * every model and the validation gate, and enters the map at its upper port; in mode 6 it passes
 * the data service as its own parallel wire. The modeled lane runs through the models, the gate
 * and the service and enters at the lower port. A stud becomes a teal hex only on an edge leaving
 * a model node. No numbers are invented here, and no repository part codes appear.
 *
 * Geometry is in viewBox units: horizontal 1200 × 470, vertical 360 wide (spec §2.3: one layout per
 * breakpoint, about 1 unit per CSS px at that breakpoint's narrowest width).
 */

export const PIPELINE_MODES = [3, 6] as const;
export type PipelineMode = (typeof PIPELINE_MODES)[number];
export type Orientation = 'h' | 'v';

export type NodeKind =
  'source' | 'observations' | 'model' | 'surface' | 'gate' | 'service' | 'map';
export type NodeGlyph =
  | 'docs'
  | 'pin'
  | 'studs'
  | 'model'
  | 'surface'
  | 'burden'
  | 'gate'
  | 'service'
  | 'atlas';
export type Lane = 'source' | 'measured' | 'modeled';
export type Packet = 'square' | 'stud' | 'hex';

export interface PipelineNode {
  /** Morph key: a node keeps its key across modes and moves instead of being rebuilt. */
  key: string;
  /** DOM id (prefixed per instance): `part-*`. */
  id: string;
  kind: NodeKind;
  glyph: NodeGlyph;
  /** Visible label, one entry per line. */
  label: string[];
  /** Short line under the label. */
  sub?: string;
  /** The bottom-bar sentence when the node is focused. */
  caption: string;
  /** Docs guide for the `links` variant, relative to /docs/. */
  guide?: string;
}

export interface PipelineEdge {
  id: string;
  from: string;
  to: string;
  lane: Lane;
  packet: Packet;
  /** How the wire runs: straight or curved between neighbours, around the models, or port to port. */
  route: 'direct' | 'bypass' | 'port';
  /** Which side of the receiving node the wire enters (both lanes into one node). */
  port?: 'upper' | 'lower';
}

export interface PipelineLayout {
  width: number;
  height: number;
  pos: Record<string, readonly [number, number]>;
  /** Vertical layout only: y of each stage header row. */
  heads?: readonly number[];
}

export interface PipelineModeData {
  mode: PipelineMode;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  stages: { label: string; keys: string[] }[];
  /** Where each lane's label sits: between these two nodes. */
  laneTags: Record<'measured' | 'modeled', readonly [string, string]>;
  idle: string;
  layouts: Record<Orientation, PipelineLayout>;
}

/** Half the socket size: sockets are 72-unit squares (spec §2.5: 64–72 px). */
export const SOCKET = 36;

const STAGE_LABELS = [
  'Aggregate the evidence',
  'Model what the evidence supports',
  'Open it to the world',
] as const;

const CAPTION = {
  samples: 'Allele counts from papers, theses and databases, in any language.',
  observations:
    'Each survey keeps its place, a location radius and its count: AC of AN, never just a percentage.',
  model:
    'Bayesian spatial models are fitted ahead of time and published as versioned results.',
  surface:
    'Every estimate carries a 95% range. Too little evidence means no number, only a hatch.',
  burden:
    'Frequency, inheritance, penetrance and population become expected cases, with a range.',
  gate: 'Results stay labelled “not yet validated” until they reproduce published HbS, G6PD and carrier-screening estimates.',
  service: 'Serves versioned results fast. No model runs on this path.',
  map: 'Measured and modeled arrive as separate layers you can switch on and off.',
  registry:
    'Where each population was sampled, with a stated radius and provenance.',
} as const;

export const PIPELINE: Record<PipelineMode, PipelineModeData> = {
  3: {
    mode: 3,
    idle: 'Select a step to read it.',
    nodes: [
      {
        key: 'source',
        id: 'part-samples',
        kind: 'source',
        glyph: 'docs',
        label: ['Published samples'],
        caption: CAPTION.samples,
      },
      {
        key: 'observations',
        id: 'part-observations',
        kind: 'observations',
        glyph: 'studs',
        label: ['Counted observations'],
        sub: 'AC of AN',
        caption: CAPTION.observations,
      },
      {
        key: 'model',
        id: 'part-model',
        kind: 'model',
        glyph: 'model',
        label: ['Offline model'],
        sub: 'versioned',
        caption: CAPTION.model,
      },
      {
        key: 'surface',
        id: 'part-surface',
        kind: 'surface',
        glyph: 'surface',
        label: ['Modeled surface'],
        sub: 'with 95% range',
        caption: CAPTION.surface,
      },
      {
        key: 'map',
        id: 'part-atlas',
        kind: 'map',
        glyph: 'atlas',
        label: ['The Atlas'],
        caption: CAPTION.map,
      },
    ],
    edges: [
      {
        id: 'source-observations',
        from: 'source',
        to: 'observations',
        lane: 'source',
        packet: 'square',
        route: 'direct',
      },
      {
        id: 'observations-map',
        from: 'observations',
        to: 'map',
        lane: 'measured',
        packet: 'stud',
        route: 'bypass',
        port: 'upper',
      },
      {
        id: 'observations-model',
        from: 'observations',
        to: 'model',
        lane: 'modeled',
        packet: 'stud',
        route: 'direct',
      },
      {
        id: 'model-surface',
        from: 'model',
        to: 'surface',
        lane: 'modeled',
        packet: 'hex',
        route: 'direct',
      },
      {
        id: 'surface-map',
        from: 'surface',
        to: 'map',
        lane: 'modeled',
        packet: 'hex',
        route: 'direct',
        port: 'lower',
      },
    ],
    stages: [
      { label: STAGE_LABELS[0], keys: ['source', 'observations'] },
      { label: STAGE_LABELS[1], keys: ['model', 'surface'] },
      { label: STAGE_LABELS[2], keys: ['map'] },
    ],
    laneTags: {
      measured: ['observations', 'map'],
      modeled: ['model', 'surface'],
    },
    layouts: {
      h: {
        width: 1200,
        height: 470,
        pos: {
          source: [100, 235],
          observations: [330, 235],
          model: [600, 350],
          surface: [850, 350],
          map: [1100, 235],
        },
      },
      v: {
        width: 360,
        height: 940,
        heads: [26, 386, 734],
        pos: {
          source: [180, 108],
          observations: [180, 272],
          model: [300, 476],
          surface: [300, 636],
          map: [180, 842],
        },
      },
    },
  },
  6: {
    mode: 6,
    idle: 'Select a part to read its contract.',
    nodes: [
      {
        key: 'source',
        id: 'part-registry',
        kind: 'source',
        glyph: 'pin',
        label: ['Population-location', 'registry'],
        caption: CAPTION.registry,
        guide: 'data-and-literature/',
      },
      {
        key: 'observations',
        id: 'part-observations',
        kind: 'observations',
        glyph: 'studs',
        label: ['Observations'],
        sub: 'AC of AN',
        caption: CAPTION.observations,
        guide: 'data-and-literature/',
      },
      {
        key: 'model',
        id: 'part-frequency',
        kind: 'model',
        glyph: 'model',
        label: ['Frequency', 'modeling'],
        caption: CAPTION.model,
        guide: 'modeling-and-validation/',
      },
      {
        key: 'burden',
        id: 'part-burden',
        kind: 'model',
        glyph: 'burden',
        label: ['Disease-burden', 'modeling'],
        caption: CAPTION.burden,
        guide: 'modeling-and-validation/',
      },
      {
        key: 'gate',
        id: 'part-gate',
        kind: 'gate',
        glyph: 'gate',
        label: ['Validation gate'],
        sub: 'HbS, G6PD, screening',
        caption: CAPTION.gate,
        guide: 'scientific-safeguards/',
      },
      {
        key: 'service',
        id: 'part-service',
        kind: 'service',
        glyph: 'service',
        label: ['Data service'],
        sub: 'no model runs here',
        caption: CAPTION.service,
        guide: 'system-overview/',
      },
      {
        key: 'map',
        id: 'part-map',
        kind: 'map',
        glyph: 'atlas',
        label: ['Interactive public', 'map'],
        caption: CAPTION.map,
        guide: 'system-overview/',
      },
    ],
    edges: [
      {
        id: 'source-observations',
        from: 'source',
        to: 'observations',
        lane: 'source',
        packet: 'square',
        route: 'direct',
      },
      {
        id: 'observations-service',
        from: 'observations',
        to: 'service',
        lane: 'measured',
        packet: 'stud',
        route: 'bypass',
        port: 'upper',
      },
      {
        id: 'observations-model',
        from: 'observations',
        to: 'model',
        lane: 'modeled',
        packet: 'stud',
        route: 'direct',
      },
      {
        id: 'model-burden',
        from: 'model',
        to: 'burden',
        lane: 'modeled',
        packet: 'hex',
        route: 'direct',
      },
      {
        id: 'burden-gate',
        from: 'burden',
        to: 'gate',
        lane: 'modeled',
        packet: 'hex',
        route: 'direct',
      },
      {
        id: 'gate-service',
        from: 'gate',
        to: 'service',
        lane: 'modeled',
        packet: 'hex',
        route: 'direct',
        port: 'lower',
      },
      {
        id: 'service-map-measured',
        from: 'service',
        to: 'map',
        lane: 'measured',
        packet: 'stud',
        route: 'port',
        port: 'upper',
      },
      {
        id: 'service-map-modeled',
        from: 'service',
        to: 'map',
        lane: 'modeled',
        packet: 'hex',
        route: 'port',
        port: 'lower',
      },
    ],
    stages: [
      { label: STAGE_LABELS[0], keys: ['source', 'observations'] },
      { label: STAGE_LABELS[1], keys: ['model', 'burden', 'gate'] },
      { label: STAGE_LABELS[2], keys: ['service', 'map'] },
    ],
    laneTags: {
      measured: ['observations', 'service'],
      modeled: ['model', 'burden'],
    },
    layouts: {
      h: {
        width: 1200,
        height: 470,
        pos: {
          source: [85, 235],
          observations: [255, 235],
          model: [445, 350],
          burden: [615, 350],
          gate: [785, 350],
          service: [955, 235],
          map: [1115, 235],
        },
      },
      v: {
        width: 360,
        height: 1220,
        heads: [26, 386, 876],
        pos: {
          source: [180, 108],
          observations: [180, 278],
          model: [300, 476],
          burden: [300, 628],
          gate: [300, 776],
          service: [180, 976],
          map: [180, 1130],
        },
      },
    },
  },
};

/** Every node key across both modes, in pipeline order (the morph's union). */
export const ALL_KEYS = [
  'source',
  'observations',
  'model',
  'surface',
  'burden',
  'gate',
  'service',
  'map',
] as const;

/** Row the measured lane bypasses on in the horizontal layout. */
const BYPASS_ROW = 118;
/** Column the measured lane bypasses on in the vertical layout. */
const BYPASS_COLUMN = 34;
/** Vertical layout: the centre column, where nodes carry their labels below. */
export const CENTRE_COLUMN = 180;
const PORT = 12;

/** SVG path data for an edge in one orientation. */
export function edgePath(
  data: PipelineModeData,
  edge: PipelineEdge,
  orient: Orientation,
): string {
  const layout = data.layouts[orient];
  const [ax, ay] = layout.pos[edge.from];
  const [bx, by] = layout.pos[edge.to];
  const R = SOCKET;
  const port = edge.port === 'upper' ? -PORT : edge.port === 'lower' ? PORT : 0;
  const n = (value: number) => String(Math.round(value * 10) / 10);
  const pt = (x: number, y: number) => `${n(x)} ${n(y)}`;

  if (orient === 'h') {
    if (edge.route === 'bypass') {
      const row = BYPASS_ROW;
      return (
        `M${pt(ax + R, ay - PORT)}` +
        `C${pt(ax + R + 46, ay - PORT)} ${pt(ax + R + 26, row)} ${pt(ax + R + 86, row)}` +
        `L${pt(bx - R - 86, row)}` +
        `C${pt(bx - R - 26, row)} ${pt(bx - R - 46, by + port)} ${pt(bx - R, by + port)}`
      );
    }
    if (edge.route === 'port')
      return `M${pt(ax + R, ay + port)}L${pt(bx - R, by + port)}`;
    if (Math.abs(ay - by) < 1) return `M${pt(ax + R, ay)}L${pt(bx - R, by)}`;
    // Leaving the centre row downward uses the lower port; arriving at it from below, too.
    const sy = ay < by ? ay + PORT : ay;
    const ey = by < ay ? by + PORT : by;
    const mx = (ax + R + bx - R) / 2;
    return `M${pt(ax + R, sy)}C${pt(mx, sy)} ${pt(mx, ey)} ${pt(bx - R, ey)}`;
  }

  // Vertical. Edges leaving a centre-column node start below its label.
  const below = ay + R + 58;
  if (edge.route === 'bypass') {
    const column = BYPASS_COLUMN;
    return (
      `M${pt(ax - R, ay)}` +
      `C${pt(ax - R - 40, ay)} ${pt(column, ay + 10)} ${pt(column, ay + 70)}` +
      `L${pt(column, by - 70)}` +
      `C${pt(column, by - 14)} ${pt(bx - R - 40, by - 10)} ${pt(bx - R, by - 10)}`
    );
  }
  if (edge.route === 'port') {
    const dx = edge.port === 'upper' ? -10 : 10;
    return `M${pt(ax + dx, below)}L${pt(bx + dx, by - R)}`;
  }
  if (Math.abs(ax - bx) < 1)
    return `M${pt(ax, ax === CENTRE_COLUMN ? below : ay + R)}L${pt(bx, by - R)}`;
  if (bx > ax)
    return `M${pt(ax + R, ay + 10)}C${pt(bx, ay + 10)} ${pt(bx, ay + 40)} ${pt(bx, by - R)}`;
  // From the lane column back to the centre: enter from the right, at the lower port.
  return `M${pt(ax, ay + R)}C${pt(ax, by - 20)} ${pt(ax, by + 10)} ${pt(bx + R, by + 10)}`;
}

/** Where a lane's label sits in one orientation, and whether it runs up the page. */
export function laneTagPosition(
  data: PipelineModeData,
  lane: 'measured' | 'modeled',
  orient: Orientation,
): { x: number; y: number; vertical: boolean } {
  const layout = data.layouts[orient];
  const [a, b] = data.laneTags[lane];
  const [ax, ay] = layout.pos[a];
  const [bx, by] = layout.pos[b];
  if (orient === 'h')
    return {
      x: (ax + bx) / 2,
      y: lane === 'measured' ? BYPASS_ROW : (ay + by) / 2,
      vertical: false,
    };
  if (lane === 'measured')
    return { x: BYPASS_COLUMN, y: (ay + by) / 2, vertical: true };
  return { x: ax, y: (ay + by) / 2, vertical: false };
}
