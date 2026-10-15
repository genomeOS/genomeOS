/** The evidence pipeline, as data: one source for Home (3 stages), Project (6 parts) and the Docs
 * map (site redesign spec §3.1, #454).
 *
 * Two lanes that never join. The measured lane (white studs) leaves the observations, bypasses
 * every model and the validation gate, and enters the map at its upper port; in mode 6 it passes
 * the data service as its own parallel wire. The modeled lane runs through the models, the gate
 * and the service and enters at the lower port. A stud becomes a teal hex only on an edge leaving
 * a model node. No numbers are invented here, and no repository part codes appear.
 *
 * Geometry is in viewBox units, in three layouts: horizontal (1200 × 470), stage columns for mid
 * widths (620 wide: one column per stage) and vertical (272 wide). Spec §2.3: one layout per
 * breakpoint, about 1 unit per CSS px at that breakpoint's narrowest width. The breakpoint is the
 * plate's own width, not the viewport's (PIPELINE_STAGE_WIDTH).
 */

export const PIPELINE_MODES = [3, 6] as const;
export type PipelineMode = (typeof PIPELINE_MODES)[number];
/** Horizontal, stage columns (mid widths) or vertical. */
export type Orientation = 'h' | 'm' | 'v';

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

/** A stage title in the vertical and stage-column layouts: text lines, then a rule under them. */
export interface PipelineHead {
  lines: string[];
  /** Where the text is anchored: its start (vertical) or its middle (stage columns). */
  x: number;
  anchor: 'start' | 'middle';
  /** Baseline of the first line. */
  y: number;
  /** The rule: from `ruleX`, `rule` units long, at `ruleY`. It stops short of every wire. */
  ruleX: number;
  ruleY: number;
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
  /** Vertical and stage-column titles, when brackets are drawn. */
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
  h: { label: 17, sub: 16, line: 19, stage: 16, stageLine: 19, lane: 16 },
  m: { label: 16, sub: 16, line: 18.5, stage: 16, stageLine: 18.5, lane: 16 },
  v: { label: 15.5, sub: 15, line: 17.5, stage: 15, stageLine: 18, lane: 15 },
} as const;

/**
 * The stage widths (CSS px) each layout is drawn at (spec §2.3: a 13-unit label renders at 13 px or
 * more, and one unit is about one px at the narrowest width). Pipeline.astro picks by its plate's
 * stage width (a container query, so a column narrower than the page, such as the Docs content,
 * gets the layout that fits it at any viewport): horizontal from `h.min`, stage columns from
 * `m.min` (drawn up to `m.max` wide and centred beyond that), vertical below (up to `v.max`).
 * `v.min` is the stage of a 320 px phone with the site's gutters.
 */
export const PIPELINE_STAGE_WIDTH = {
  h: { min: 1000 },
  m: { min: 520, max: 744 },
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
  // Round 2 (spec §4.2.6, §0.2 #12): the frequency model is named as machine learning, so Home's
  // "Build AI models" step has a visible referent on Projects.
  frequency:
    'Bayesian spatial models, a kind of machine learning, are fitted ahead of time and published as versioned results.',
  surface:
    'Every estimate carries a 95% range. Too little evidence means no number, only a hatch.',
  burden:
    'Frequency, inheritance, penetrance and population become expected cases, with a range.',
  // R2-14 and ruling 37: the gate is described plainly, never as a caveat or a scare label.
  gate: 'Results are checked against published HbS, G6PD and carrier-screening estimates.',
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
        // One line, so the subtitle fits under it in the stage-column layout (two text rows, as
        // every part has); the full method name is in the caption (round 2 spec §4.2.6).
        label: ['Frequency modeling'],
        sub: 'Machine learning',
        caption: CAPTION.frequency,
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
  // The models sit 195 apart so the "Modeled" tag has room on the wire between them.
  6: {
    source: [85, 235],
    observations: [255, 235],
    model: [420, 350],
    burden: [615, 350],
    gate: [780, 350],
    service: [955, 235],
    map: [1115, 235],
  },
};

/** After a mode change, the part that keeps the keyboard tab stop: the same part when the new
 * mode has it, otherwise the new mode's first part (a hidden tab stop would drop the figure out
 * of the tab order). */
export function tabStopAfterModeChange(
  key: string | null,
  mode: PipelineMode,
): string {
  const { nodes } = PIPELINE[mode];
  return nodes.some((node) => node.key === key) ? key! : nodes[0].key;
}

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
      heads.push({
        lines,
        x: V.headX,
        anchor: 'start',
        y,
        ruleX: V.headX,
        ruleY,
        rule: V.rule,
      });
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

/**
 * Stage columns, for mid widths (a tablet, the Docs content column): one column per stage under its
 * title, each stage's parts stacked top to bottom, labels under the sockets. Wires between columns
 * turn on rounded right angles in the gutters, the modeled lane `split` units right of a gutter's
 * middle and the measured lane `split` units left, so the two never cross; the measured lane runs
 * over the models' column on its own row (as it runs over the model row in the horizontal layout).
 */
const M = {
  width: 620,
  column: [100, 310, 520],
  split: 8,
  /** Stage titles share the last line's baseline; the rule sits under it, `halfRule` each side. */
  titleBase: 50,
  ruleY: 62,
  halfRule: 92,
  /** The measured lane's row over the models (its tag sits on it). */
  bypass: 100,
  firstRow: 168,
  rowPitch: 160,
  /** Wires leave a part this far below its centre, under a two-line label. */
  below: 89,
  corner: 12,
  /** Without stage titles the viewBox starts here, just above the measured lane's tag. */
  bareTop: 74,
} as const;

function mediumLayout(
  data: PipelineModeData,
  brackets: boolean,
): PipelineLayout {
  const T = PIPELINE_TYPE.m;
  const pos: Record<string, readonly [number, number]> = {};
  const column: PipelineLayout['column'] = {};
  let bottom = 0;
  data.stages.forEach((stage, index) =>
    stage.keys.forEach((key, row) => {
      const y = M.firstRow + row * M.rowPitch;
      pos[key] = [M.column[index], y];
      column[key] = 'centre';
      const node = data.nodes.find((candidate) => candidate.key === key)!;
      const rows = node.label.length + (node.sub ? 1 : 0);
      bottom = Math.max(bottom, y + SOCKET + 22 + (rows - 1) * T.line + 6);
    }),
  );
  const heads = data.stages.map((stage, index): PipelineHead => {
    const lines = stage.lines ?? [stage.label];
    return {
      lines,
      x: M.column[index],
      anchor: 'middle',
      y: M.titleBase - (lines.length - 1) * T.stageLine,
      ruleX: M.column[index] - M.halfRule,
      ruleY: M.ruleY,
      rule: 2 * M.halfRule,
    };
  });
  const top = brackets ? 0 : M.bareTop;
  return {
    orient: 'm',
    width: M.width,
    top,
    height: Math.ceil(bottom + 8 - top),
    pos,
    column,
    heads: brackets ? heads : null,
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
        : orient === 'm'
          ? mediumLayout(PIPELINE[mode], brackets)
          : verticalLayout(PIPELINE[mode], brackets);
    layouts.set(id, layout);
  }
  return layout;
}

/** The layout's viewBox attribute. */
export const viewBoxOf = (layout: PipelineLayout): string =>
  `0 ${layout.top} ${layout.width} ${layout.height}`;

const n = (value: number) => String(Math.round(value * 10) / 10);
const pt = (x: number, y: number) => `${n(x)} ${n(y)}`;

/** A polyline of right angles as path data, each corner rounded to radius `r` (M, L and C only). */
function rounded(points: (readonly [number, number])[], r: number): string {
  const unit = (dx: number, dy: number) => {
    const length = Math.hypot(dx, dy) || 1;
    return [dx / length, dy / length] as const;
  };
  const k = 0.5523 * r; // a quarter circle's cubic handle
  let d = `M${pt(...points[0])}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const [px, py] = points[index - 1];
    const [cx, cy] = points[index];
    const [nx, ny] = points[index + 1];
    const [ix, iy] = unit(cx - px, cy - py);
    const [ox, oy] = unit(nx - cx, ny - cy);
    const [ax, ay] = [cx - ix * r, cy - iy * r];
    const [bx, by] = [cx + ox * r, cy + oy * r];
    d += `L${pt(ax, ay)}C${pt(ax + ix * k, ay + iy * k)} ${pt(bx - ox * k, by - oy * k)} ${pt(bx, by)}`;
  }
  return `${d}L${pt(...points[points.length - 1])}`;
}

/** Stage columns: within a column straight down; between columns along a gutter. */
function mediumEdge(layout: PipelineLayout, edge: PipelineEdge): string {
  const [ax, ay] = layout.pos[edge.from];
  const [bx, by] = layout.pos[edge.to];
  const R = SOCKET;
  const from = M.column.indexOf(ax as (typeof M.column)[number]);
  const to = M.column.indexOf(bx as (typeof M.column)[number]);
  const gutter = (index: number) => (M.column[index] + M.column[index + 1]) / 2;
  if (from === to) {
    // Down the column from under the label; two lanes into one part keep their ports' sides.
    const dx = edge.port === 'upper' ? -10 : edge.port === 'lower' ? 10 : 0;
    return `M${pt(ax + dx, ay + M.below)}L${pt(bx + dx, by - R)}`;
  }
  if (edge.route === 'bypass') {
    const [up, down] = [gutter(from) - M.split, gutter(to - 1) - M.split];
    return rounded(
      [
        [ax + R, ay - PORT],
        [up, ay - PORT],
        [up, M.bypass],
        [down, M.bypass],
        [down, by - PORT],
        [bx - R, by - PORT],
      ],
      M.corner,
    );
  }
  // The modeled lane climbs the gutter right of its middle. Out of the first column it leaves the
  // observations' lower port, since the measured lane has the upper one.
  const x = gutter(from) + M.split;
  const sy = from === 0 ? ay + PORT : ay;
  const ey = edge.port === 'lower' ? by + PORT : by;
  return rounded(
    [
      [ax + R, sy],
      [x, sy],
      [x, ey],
      [bx - R, ey],
    ],
    M.corner,
  );
}

/** SVG path data for an edge in a layout. */
export function edgePath(layout: PipelineLayout, edge: PipelineEdge): string {
  if (layout.orient === 'm') return mediumEdge(layout, edge);
  const [ax, ay] = layout.pos[edge.from];
  const [bx, by] = layout.pos[edge.to];
  const R = SOCKET;
  const port = edge.port === 'upper' ? -PORT : edge.port === 'lower' ? PORT : 0;

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
  if (layout.orient === 'm') {
    if (lane === 'measured')
      return { x: M.column[1], y: M.bypass, vertical: false };
    // Up the gutter out of the models' column, where only the modeled lane runs.
    const climb = data.edges.find(
      (edge) =>
        edge.lane === 'modeled' &&
        layout.pos[edge.from][0] === M.column[1] &&
        layout.pos[edge.to][0] === M.column[2],
    )!;
    const [, ay] = layout.pos[climb.from];
    const [, by] = layout.pos[climb.to];
    const ey = climb.port === 'lower' ? by + PORT : by;
    return {
      x: (M.column[1] + M.column[2]) / 2 + M.split,
      y: (ay + ey) / 2,
      vertical: true,
    };
  }
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

/** Where a node's label goes, relative to its centre: under the socket, or to its left in the
 * vertical layout's modeled-only column. */
export function labelPlacement(
  layout: PipelineLayout,
  key: string,
): { x: number; y: number; anchor: 'middle' | 'end' } {
  return layout.column[key] === 'lane'
    ? { x: -SOCKET - 14, y: -12, anchor: 'end' }
    : { x: 0, y: SOCKET + (layout.orient === 'h' ? 24 : 22), anchor: 'middle' };
}

/** A lane tag's words. */
export const LANE_TAG_TEXT = {
  measured: 'Measured',
  modeled: 'Modeled',
} as const;

/**
 * A lane tag's box on its wire: the rect Pipeline.astro draws (text width estimated at 0.56 em per
 * character, plus 9 units of padding each side), in layout units, turned upright when the tag runs
 * up the page.
 */
export function laneTagBox(
  data: PipelineModeData,
  layout: PipelineLayout,
  lane: 'measured' | 'modeled',
): {
  x: number;
  y: number;
  vertical: boolean;
  /** Along the tag's own text. */
  length: number;
  /** Across it. */
  thickness: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const { x, y, vertical } = laneTagPosition(data, layout, lane);
  const size = PIPELINE_TYPE[layout.orient].lane;
  const length = LANE_TAG_TEXT[lane].length * size * 0.56 + 18;
  const thickness = size * 1.5;
  const [w, h] = vertical ? [thickness, length] : [length, thickness];
  return {
    x,
    y,
    vertical,
    length,
    thickness,
    left: x - w / 2,
    right: x + w / 2,
    top: y - h / 2,
    bottom: y + h / 2,
  };
}
