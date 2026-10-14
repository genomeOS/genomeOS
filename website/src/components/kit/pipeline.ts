/** The Pipeline island (site redesign spec §3.1, §2.7; #454).
 *
 * Adds to the server-rendered figure: the entrance (edges draw, then packets travel at a constant
 * 0.34 units/ms, chained by arrival, all within 4.0 s), focus (hover, focus or tap a part to light
 * it, its wires and neighbours, and read its sentence in the bottom bar; click or Enter pins,
 * Escape unpins; arrows move between parts), the keyed 3 ↔ 6 morph, and Replay. Packets are grey
 * squares on the source wire, white studs on both lanes, and teal hexes only after a model node:
 * the data says which (`data-packet`). Everything rests after the entrance: no frame is scheduled.
 */

import { PIPELINE, type PipelineMode } from '../../data/pipeline';
import { ENC } from '../../graphics/encoding';
import { FigureController, prefersReducedMotion } from '../../graphics/figure';
import { easeCamera } from '../../graphics/tween';

const SPEED = 0.34; // viewBox units per ms
const START = 250; // the first packet leaves once the first edges have drawn in
const HOP = 40; // a packet waits this long at a socket before the next wire
const COUNT = 2;
const GAP = 120;
const BUDGET = 4000; // the whole entrance, spec §3.1
const PULSE = 300;
const MORPH = 1200;

const hexPath = (r: number) =>
  Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k + Math.PI / 6;
    return `${k ? 'L' : 'M'}${(r * Math.cos(a)).toFixed(1)} ${(r * Math.sin(a)).toFixed(1)}`;
  }).join('') + 'Z';
const PACKET: Record<string, string> = {
  square: `<rect x="-3" y="-3" width="6" height="6" fill="#a5b9d3"/>`,
  stud: `<circle r="4.2" fill="${ENC.obs}" stroke="#020712" stroke-width="1.4"/>`,
  hex: `<path d="${hexPath(5.4)}" fill="${ENC.mean[4]}" stroke="#020712" stroke-width="1"/>`,
};

interface Flight {
  path: SVGPathElement;
  from: string;
  to: string;
  packet: string;
  length: number;
  start: number;
  duration: number;
  gap: number;
}

function setup(root: HTMLElement): void {
  root.dataset.pipelineReady = '';
  const svgs = [...root.querySelectorAll<SVGSVGElement>('svg[data-orient]')];
  const caption = root.querySelector<HTMLElement>('[data-pipeline-caption]');
  let mode = Number(root.dataset.mode) as PipelineMode;
  let pinned: string | null = null;
  let flights: Flight[] = [];
  let end = 0;
  let morphTimer = 0;

  const visibleSvg = () =>
    svgs.find((svg) => svg.getClientRects().length > 0) ?? svgs[0];
  const nodesOf = (svg: SVGSVGElement) =>
    [...svg.querySelectorAll<SVGGElement>('.pl-node')].filter((node) =>
      (node.dataset.modes ?? '').split(' ').includes(String(mode)),
    );

  /* ---------- packets ---------- */
  function schedule(): void {
    const svg = visibleSvg();
    const ready: Record<string, number> = { source: START };
    flights = [];
    for (const path of svg.querySelectorAll<SVGPathElement>(
      `.pl-edge[data-modes~="${mode}"]`,
    )) {
      const from = path.dataset.from!;
      const to = path.dataset.to!;
      const length = path.getTotalLength();
      const start = (ready[from] ?? START) + HOP;
      const duration = length / SPEED;
      ready[to] = Math.max(ready[to] ?? 0, start + duration);
      flights.push({
        path,
        from,
        to,
        packet: path.dataset.packet ?? 'stud',
        length,
        start,
        duration,
        gap: GAP,
      });
    }
    end = Math.max(
      ...flights.map((f) => f.start + f.duration + (COUNT - 1) * f.gap),
    );
    // Over budget (a long vertical layout): speed every packet up by the same factor.
    if (end > BUDGET - 100) {
      const k = (BUDGET - 100 - START) / (end - START);
      for (const flight of flights) {
        flight.start = START + (flight.start - START) * k;
        flight.duration *= k;
        flight.gap *= k;
      }
      end = BUDGET - 100;
    }
  }

  function drawPackets(t: number): void {
    const svg = visibleSvg();
    const layer = svg.querySelector<SVGGElement>('[data-packets]');
    if (!layer) return;
    let html = '';
    const arriving = new Set<string>();
    for (const flight of flights)
      for (let index = 0; index < COUNT; index += 1) {
        const local = (t - flight.start - index * flight.gap) / flight.duration;
        if (local >= 1 && local < 1 + PULSE / flight.duration)
          arriving.add(flight.to);
        if (local <= 0 || local >= 1) continue;
        const point = flight.path.getPointAtLength(
          easeCamera(local) * flight.length,
        );
        html += `<g transform="translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})">${PACKET[flight.packet]}</g>`;
      }
    layer.innerHTML = html;
    for (const node of svg.querySelectorAll<SVGGElement>('.pl-node'))
      node.classList.toggle('is-pulse', arriving.has(node.dataset.key!));
  }

  function clearPackets(): void {
    for (const svg of svgs) {
      const layer = svg.querySelector('[data-packets]');
      if (layer) layer.innerHTML = '';
      for (const node of svg.querySelectorAll('.pl-node.is-pulse'))
        node.classList.remove('is-pulse');
    }
  }

  const controller = new FigureController(root, {
    get duration() {
      return end || BUDGET;
    },
    arm() {
      root.classList.remove('is-drawing', 'is-drawn');
      schedule();
    },
    start() {
      root.classList.add('is-drawing');
      schedule();
    },
    render: drawPackets,
    rest() {
      root.classList.remove('is-drawing');
      root.classList.add('is-drawn');
      clearPackets();
    },
  });

  /* ---------- focus ---------- */
  function setCaption(key: string | null): void {
    if (!caption) return;
    const node = key ? PIPELINE[mode].nodes.find((n) => n.key === key) : null;
    if (!node) {
      caption.textContent = PIPELINE[mode].idle;
      return;
    }
    caption.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = `${node.label.join(' ')}.`;
    caption.append(title, ` ${node.caption}`);
  }

  function focusNode(key: string | null): void {
    root.classList.toggle('has-focus', key !== null);
    for (const svg of svgs) {
      const linked = new Set<string>();
      for (const edge of svg.querySelectorAll<SVGPathElement>('.pl-edge')) {
        const lit =
          key !== null &&
          (edge.dataset.modes ?? '').split(' ').includes(String(mode)) &&
          (edge.dataset.from === key || edge.dataset.to === key);
        edge.classList.toggle('is-lit', lit);
        if (lit) linked.add(edge.dataset.from!).add(edge.dataset.to!);
      }
      for (const node of svg.querySelectorAll<SVGGElement>('.pl-node')) {
        node.classList.toggle('is-active', node.dataset.key === key);
        node.classList.toggle('is-linked', linked.has(node.dataset.key!));
      }
    }
    setCaption(key);
  }

  function rove(target: SVGGElement): void {
    for (const svg of svgs)
      for (const node of svg.querySelectorAll<SVGGElement>('.pl-node'))
        node.setAttribute(
          'tabindex',
          node.dataset.key === target.dataset.key ? '0' : '-1',
        );
    target.focus();
  }

  for (const svg of svgs)
    for (const node of svg.querySelectorAll<SVGGElement>('.pl-node')) {
      const key = node.dataset.key!;
      const toggle = () => {
        pinned = pinned === key ? null : key;
        focusNode(pinned ?? key);
      };
      node.addEventListener('pointerenter', () => focusNode(key));
      node.addEventListener('pointerleave', () => focusNode(pinned));
      node.addEventListener('focus', () => focusNode(key));
      node.addEventListener('blur', () => focusNode(pinned));
      node.addEventListener('click', toggle);
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
          return;
        }
        if (event.key === 'Escape') {
          if (pinned === null) return;
          event.preventDefault();
          pinned = null;
          focusNode(key);
          return;
        }
        const order = nodesOf(svg);
        const index = order.indexOf(node);
        const next =
          event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? order[(index + 1) % order.length]
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
              ? order[(index - 1 + order.length) % order.length]
              : event.key === 'Home'
                ? order[0]
                : event.key === 'End'
                  ? order[order.length - 1]
                  : null;
        if (!next) return;
        event.preventDefault();
        rove(next);
      });
    }

  /* ---------- the 3 ↔ 6 morph ---------- */
  function setMode(next: PipelineMode): void {
    if (next === mode) return;
    controller.finish();
    window.clearTimeout(morphTimer);
    mode = next;
    pinned = null;
    root.dataset.mode = String(mode);
    for (const svg of svgs) {
      const box = svg.getAttribute(`data-viewbox-${mode}`);
      if (box) svg.setAttribute('viewBox', box);
      for (const node of svg.querySelectorAll<SVGGElement>('.pl-node')) {
        const position = node.getAttribute(`data-pos-${mode}`);
        if (!position) continue;
        const [x, y] = position.split(' ');
        node.style.transform = `translate(${x}px, ${y}px)`;
        const id = node.getAttribute(`data-id-${mode}`);
        const label = node.getAttribute(`data-label-${mode}`);
        if (id) node.id = id;
        if (label) node.setAttribute('aria-label', label);
      }
    }
    const description = root.querySelector<HTMLElement>(
      `.kit-pipeline__alt[data-modes="${mode}"]`,
    );
    const stage = root.querySelector<HTMLElement>('[data-figure-stage]');
    if (description && stage)
      stage.setAttribute('aria-describedby', description.id);
    focusNode(null);
    // Edges redraw; reduced motion swaps at once.
    if (prefersReducedMotion()) return;
    root.classList.remove('is-drawn');
    root.classList.add('is-drawing');
    morphTimer = window.setTimeout(() => {
      root.classList.remove('is-drawing');
      root.classList.add('is-drawn');
    }, MORPH);
  }

  root.addEventListener('segmented:change', (event) => {
    const value = (event as CustomEvent<{ value: string }>).detail.value;
    if (value === '3' || value === '6') setMode(Number(value) as PipelineMode);
  });
  root
    .querySelector('[data-pipeline-replay]')
    ?.addEventListener('click', () => controller.replay());
}

for (const root of document.querySelectorAll<HTMLElement>(
  '[data-pipeline="interactive"]:not([data-pipeline-ready])',
))
  setup(root);
