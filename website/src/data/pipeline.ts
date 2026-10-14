/** The evidence pipeline, as data: one source for Home (3 stages), Project (6 parts) and the Docs
 * map (site redesign spec §3.1, #454).
 *
 * Two lanes that never join. The measured lane (white studs) leaves the observations, bypasses
 * every model and the validation gate, and enters the map at its upper port; in mode 6 it passes
 * the data service as its own parallel wire. The modeled lane runs through the models, the gate
 * and the service and enters at the lower port. A stud becomes a teal hex only on an edge leaving
 * a model node. No numbers are invented here, and no repository part codes appear.
 *
 * Geometry is in viewBox units: horizontal 1200 × 470, vertical 272 wide (spec §2.3: one layout per
 * breakpoint, about 1 unit per CSS px at that breakpoint's narrowest width). The breakpoint is the
 * plate's own width, not the viewport's (PIPELINE_STAGE_WIDTH).
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

export interface PipelineStage {
  label: string;
  keys: string[];
  /** The title's lines in the narrow vertical layout (their words are the label's, in order). */
  lines?: string[];
}

/** A stage title in the vertical layout: text lines, then a short rule under them. */
export interface PipelineHead {
  lines: string[];
  x: number;
  /** Baseline of the first line. */
  y: number;
  ruleY: number;
  /** Length of the rule from `x`. It stops short of the modeled lane's column. */
  rule: number;
}

export interface PipelineLayout {
  orient: Orientation;
  width: number;
  /** viewBox top: the horizontal layout drops its bracket band when it draws no brackets. */
  top: number;
  height: number;
  pos: Record<string, readonly [number, number]>;
  /** Vertical layout: the measured lane's column, or the modeled-only column on the right. */
  column: Record<string, 'centre' | 'lane'>;
  /** Vertical stage titles, when brackets are drawn. */
  heads: PipelineHead[] | null;
}

export interface PipelineModeData {
  mode: PipelineMode;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  stages: PipelineStage[];
  /** Where each lane's label sits: between these two nodes. */
  laneTags: Record<'measured' | 'modeled', readonly [string, string]>;
  idle: string;
}

/** Half the socket size: sockets are 72-unit squares (spec §2.5: 64–72 px). */
export const SOCKET = 36;

/** Type sizes in viewBox units, per layout. `line` and `stageLine` are line steps. */
export const PIPELINE_TYPE = {
  h: { label: 17, sub: 16, line: 19, stage: 16, lane: 16 },
  v: { label: 15.5, sub: 15, line: 17.5, stage: 15, stageLine: 18, lane: 15 },
} as const;

/**
 * The stage widths (CSS px) each layout is drawn at (spec §2.3: a 13-unit label renders at 13 px or
 * more, and one unit is about one px at the narrowest width). Pipeline.astro draws the horizontal
 * layout when its plate's stage is at least `h.min` wide (a container query, so a narrow column
 * such as the Docs content gets the vertical one at any viewport), and the vertical one below it,
 * up to `v.max` wide. `v.min` is the stage of a 320 px phone with the site's gutters.
 */
export const PIPELINE_STAGE_WIDTH = {
  h: { min: 1000 },
  v: { min: 240, max: 352 },
} as const;

const STAGE_LABELS = [
  'Aggregate the evidence',
  'Model what the evidence supports',
  'Open it to the world',
] as const;
/** The long title wraps in the vertical layout, so it clears the modeled lane's wire. */
const STAGE_LINES = ['Model what the', 'evidence supports'];

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
      {
        label: STAGE_LABELS[1],
        keys: ['model', 'surface'],
        lines: STAGE_LINES,
      },
      { label: STAGE_LABELS[2], keys: ['map'] },
    ],
    laneTags: {
      measured: ['observations', 'map'],
      modeled: ['model', 'surface'],
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
      {
        label: STAGE_LABELS[1],
        keys: ['model', 'burden', 'gate'],
        lines: STAGE_LINES,
      },
      { label: STAGE_LABELS[2], keys: ['service', 'map'] },
    ],
    laneTags: {
      measured: ['observations', 'service'],
      modeled: ['model', 'burden'],
    },
  },
};

/** Horizontal node positions: the main row, the models on a lower row (viewBox 1200 × 470). */
const HORIZONTAL: Record<
  PipelineMode,
  Record<string, readonly [number, number]>
> = {
  3: {
    source: [100, 235],
    observations: [330, 235],
    model: [600, 350],
    surface: [850, 350],
    map: [1100, 235],
  },
  6: {
    source: [85, 235],
    observations: [255, 235],
    model: [445, 350],
    burden: [615, 350],
    gate: [785, 350],
    service: [955, 235],
    map: [1115, 235],
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

/** Horizontal: the row the measured lane bypasses the models on. */
const BYPASS_ROW = 118;
/** Horizontal: without stage brackets the viewBox starts here, just above the bypass row's tag. */
const BARE_TOP = 92;
const PORT = 12;

/**
 * Vertical geometry, sized so the smallest type (15 units) renders at 13 px or more on a 240 px
 * stage. Three columns: the measured lane's bypass on the left, the main column (labels under
 * the sockets) and the modeled-only column on the right (labels to the left of the sockets).
 * Stage titles sit at `headX` with a rule that ends before the modeled column's wire.
 */
const V = {
  width: 272,
  bypass: 16,
  centre: 124,
  lane: 230,
  headX: 34,
  rule: 182,
} as const;

/** Nodes in the modeled-only column: the models and the gate, which the measured lane bypasses. */
const LANE_KINDS: ReadonlySet<NodeKind> = new Set(['model', 'surface', 'gate']);

/** Vertical spacing, in units from the previous item's bottom edge to the next item's top. */
const GAP = {
  startHead: 8,
  startNode: 14,
  headNode: 22,
  centreCentre: 94, // the label under the socket, then a wire
  centreHead: 54,
  centreLane: 88,
  laneLane: 52, // room for the "Modeled" tag on the wire
  laneHead: 18,
  laneCentre: 50,
  end: 8,
} as const;

function verticalLayout(
  data: PipelineModeData,
  brackets: boolean,
): PipelineLayout {
  const R = SOCKET;
  const T = PIPELINE_TYPE.v;
  const pos: Record<string, readonly [number, number]> = {};
  const column: PipelineLayout['column'] = {};
  const heads: PipelineHead[] = [];
  const nodeOf = (key: string) => data.nodes.find((node) => node.key === key)!;
  let bottom = 0;
  let previous: 'start' | 'head' | 'centre' | 'lane' = 'start';
  for (const stage of data.stages) {
    if (brackets) {
      const lines = stage.lines ?? [stage.label];
      const top =
        bottom +
        (previous === 'centre'
          ? GAP.centreHead
          : previous === 'lane'
            ? GAP.laneHead
            : GAP.startHead);
      const y = top + T.stage;
      const ruleY = y + (lines.length - 1) * T.stageLine + 9;
      heads.push({ lines, x: V.headX, y, ruleY, rule: V.rule });
      bottom = ruleY;
      previous = 'head';
    }
    for (const key of stage.keys) {
      const lane = LANE_KINDS.has(nodeOf(key).kind);
      const gap =
        previous === 'start'
          ? GAP.startNode
          : previous === 'head'
            ? GAP.headNode
            : previous === 'centre'
              ? lane
                ? GAP.centreLane
                : GAP.centreCentre
              : lane
                ? GAP.laneLane
                : GAP.laneCentre;
      const y = bottom + gap + R;
      pos[key] = [lane ? V.lane : V.centre, y];
      column[key] = lane ? 'lane' : 'centre';
      bottom = y + R;
      previous = lane ? 'lane' : 'centre';
    }
  }
  // The last node's label block (under it in the main column), then a margin.
  const last = data.nodes[data.nodes.length - 1];
  const rows = last.label.length + (last.sub ? 1 : 0);
  const label = previous === 'centre' ? 22 + (rows - 1) * T.line + 6 : 0;
  return {
    orient: 'v',
    width: V.width,
    top: 0,
    height: Math.ceil(bottom + label + GAP.end),
    pos,
    column,
    heads: brackets ? heads : null,
  };
}

function horizontalLayout(
  data: PipelineModeData,
  brackets: boolean,
): PipelineLayout {
  const top = brackets ? 0 : BARE_TOP;
  return {
    orient: 'h',
    width: 1200,
    top,
    height: 470 - top,
    pos: HORIZONTAL[data.mode],
    column: Object.fromEntries(
      data.nodes.map((node) => [node.key, 'centre' as const]),
    ),
    heads: null,
  };
}

const layouts = new Map<string, PipelineLayout>();

/** A mode's layout in one orientation, with or without its stage brackets. */
export function pipelineLayout(
  mode: PipelineMode,
  orient: Orientation,
  brackets = true,
): PipelineLayout {
  const id = `${mode}${orient}${brackets}`;
  let layout = layouts.get(id);
  if (!layout) {
    layout =
      orient === 'h'
        ? horizontalLayout(PIPELINE[mode], brackets)
        : verticalLayout(PIPELINE[mode], brackets);
    layouts.set(id, layout);
  }
  return layout;
}

/** The layout's viewBox attribute. */
export const viewBoxOf = (layout: PipelineLayout): string =>
  `0 ${layout.top} ${layout.width} ${layout.height}`;

/** SVG path data for an edge in a layout. */
export function edgePath(layout: PipelineLayout, edge: PipelineEdge): string {
  const [ax, ay] = layout.pos[edge.from];
  const [bx, by] = layout.pos[edge.to];
  const R = SOCKET;
  const port = edge.port === 'upper' ? -PORT : edge.port === 'lower' ? PORT : 0;
  const n = (value: number) => String(Math.round(value * 10) / 10);
  const pt = (x: number, y: number) => `${n(x)} ${n(y)}`;

  if (layout.orient === 'h') {
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

  // Vertical. Edges leaving a main-column node start below its label.
  const from = layout.column[edge.from];
  const to = layout.column[edge.to];
  const below = ay + R + 58;
  if (edge.route === 'bypass') {
    const column = V.bypass;
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
  if (from === to)
    return `M${pt(ax, from === 'centre' ? below : ay + R)}L${pt(bx, by - R)}`;
  if (to === 'lane')
    return `M${pt(ax + R, ay + 10)}C${pt(bx, ay + 10)} ${pt(bx, ay + 40)} ${pt(bx, by - R)}`;
  // From the modeled column back to the main one: enter from the right, at the lower port.
  return `M${pt(ax, ay + R)}C${pt(ax, by - 20)} ${pt(ax, by + 10)} ${pt(bx + R, by + 10)}`;
}

/** Where a lane's label sits in a layout, and whether it runs up the page. */
export function laneTagPosition(
  data: PipelineModeData,
  layout: PipelineLayout,
  lane: 'measured' | 'modeled',
): { x: number; y: number; vertical: boolean } {
  const [a, b] = data.laneTags[lane];
  const [ax, ay] = layout.pos[a];
  const [bx, by] = layout.pos[b];
  if (layout.orient === 'h')
    return {
      x: (ax + bx) / 2,
      y: lane === 'measured' ? BYPASS_ROW : (ay + by) / 2,
      vertical: false,
    };
  if (lane === 'measured')
    return { x: V.bypass, y: (ay + by) / 2, vertical: true };
  return { x: ax, y: (ay + by) / 2, vertical: false };
}
