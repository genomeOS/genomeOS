/** The working groups' island (site redesign spec §4.3 C2, §2.7, #454).
 *
 * - The transit line plays once: the ion line draws over 2.4 s with the white stud riding its
 *   head; the teal hex joins at the model step and follows; both rest on the map's stretch.
 *   Stations light as the line reaches them. Then nothing runs. As the page's lead figure it plays
 *   at load when 200 px of it show, rests at once when less does, and otherwise plays at 35%.
 * - Hovering, focusing or tapping a group card (or its lane label) lights that group's lane: its
 *   band tints, its stations and its own stretches of the line stay at full strength, and the other
 *   lanes' art drops to 32%. Text only changes colour, never below 4.5:1.
 * - The group vignettes play once when the card row is 35% visible, 300 ms apart, each in at most
 *   1.6 s; hover or focus on a card replays its own. Reduced motion: final frames, no replay; the
 *   lane linking still works.
 *
 * The server markup is the final state of everything; FigureController arms and rests it.
 */

import { FigureController, prefersReducedMotion } from '../../graphics/figure';
import {
  TRANSIT_MS,
  filletRoute,
  tokenAt,
  type TokenPlan,
} from './transit-geometry';

type Lane = 'data' | 'modeling' | 'ui';

const VIGNETTE_STAGGER_MS = 300;
const VIGNETTE_MS = 1600;
/** The lead figure plays once this much of it is in view (see initTransit). */
const LEAD_VISIBLE_PX = 200;

const translate = (point: { x: number; y: number }) =>
  `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`;

function initTransit(figure: HTMLElement): void {
  const parts = [
    ...figure.querySelectorAll<SVGSVGElement>('svg[data-plan]'),
  ].map((svg) => {
    const plan = JSON.parse(svg.dataset.plan!) as TokenPlan;
    const stud = svg.querySelector<SVGGElement>('[data-token="stud"]')!;
    const hex = svg.querySelector<SVGGElement>('[data-token="hex"]')!;
    return {
      plan,
      route: filletRoute(plan.points, plan.corner),
      line: svg.querySelector<SVGPathElement>('[data-line]')!,
      stud,
      hex,
      rest: {
        stud: stud.getAttribute('transform')!,
        hex: hex.getAttribute('transform')!,
      },
      stations: [...svg.querySelectorAll<SVGGElement>('[data-reach]')],
    };
  });

  const draw = (progress: number) => {
    for (const part of parts) {
      const frame = tokenAt(part.route, part.plan, progress);
      const share = frame.line / part.route.length;
      part.line.style.strokeDashoffset = String(1 - share);
      part.stud.setAttribute('transform', translate(frame.stud.point));
      if (frame.hex)
        part.hex.setAttribute('transform', translate(frame.hex.point));
      part.hex.classList.toggle('is-waiting', !frame.hex);
      for (const station of part.stations)
        station.classList.toggle(
          'is-ahead',
          Number(station.dataset.reach) > share + 0.002,
        );
    }
  };

  // The controller's own clock ends the entrance, and ends it early offscreen or in a hidden tab;
  // this loop only draws while the controller says the figure is playing. (A `render` loop would
  // depend on the controller's on-screen flag, which can still read "offscreen" at the moment a
  // figure that loaded below the fold is told to play.)
  let request = 0;
  const controller: FigureController = new FigureController(figure, {
    duration: TRANSIT_MS,
    arm() {
      figure.classList.add('is-armed');
      draw(0);
    },
    start() {
      const begun = performance.now();
      const tick = (now: number) => {
        request = 0;
        if (controller.state !== 'playing') return;
        // Dev captures freeze the entrance at ?t=<ms> (FigureController).
        const frozen = figure.style.getPropertyValue('--figure-freeze');
        if (frozen) {
          draw(-Number.parseFloat(frozen) / TRANSIT_MS);
          return;
        }
        draw((now - begun) / TRANSIT_MS);
        request = requestAnimationFrame(tick);
      };
      request = requestAnimationFrame(tick);
    },
    rest() {
      cancelAnimationFrame(request);
      request = 0;
      figure.classList.remove('is-armed');
      for (const part of parts) {
        part.line.style.removeProperty('stroke-dashoffset');
        part.stud.setAttribute('transform', part.rest.stud);
        part.hex.setAttribute('transform', part.rest.hex);
        part.hex.classList.remove('is-waiting');
        for (const station of part.stations)
          station.classList.remove('is-ahead');
      }
    },
  });

  // The controller now holds the figure's state, which ends the head script's pre-paint arming
  // (contribute.css keys it on a figure with no state yet).
  document.documentElement.removeAttribute('data-arm-transit');

  // The page's lead figure starts in the first screen, but on a phone or a short laptop screen only
  // its top shows, short of the 35% the page's observer waits for, so it would sit undrawn until the
  // visitor scrolled. With LEAD_VISIBLE_PX of it showing it plays now; with less, it rests at once
  // (spec §2.7 rule 5: above the fold never flashes); offscreen, it waits to be scrolled to.
  if (controller.state !== 'armed') return;
  const box = figure.getBoundingClientRect();
  const showing = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
  if (showing >= LEAD_VISIBLE_PX) controller.play();
  else if (showing > 0) controller.finish();
}

function initCards(row: HTMLElement, figure: HTMLElement | null): void {
  const reduced = prefersReducedMotion();
  const vignettes = [...row.querySelectorAll<SVGSVGElement>('.wg-vig')];
  const timers = new Map<Element, number>();

  const controller = new FigureController(row, {
    duration: VIGNETTE_STAGGER_MS * (vignettes.length - 1) + VIGNETTE_MS,
    start() {
      vignettes.forEach((vignette, index) => {
        vignette.style.setProperty(
          '--wg-delay',
          `${index * VIGNETTE_STAGGER_MS}ms`,
        );
        vignette.classList.add('is-playing');
      });
    },
    rest() {
      for (const vignette of vignettes) {
        vignette.classList.remove('is-playing');
        vignette.style.removeProperty('--wg-delay');
      }
    },
  });

  /** Replay one card's vignette once, because the visitor pointed at it. */
  const replay = (lane: Lane) => {
    if (reduced || controller.state !== 'rest') return;
    const vignette = row.querySelector<SVGSVGElement>(
      `.wg-vig[data-wg-vig="${lane}"]`,
    );
    if (!vignette || timers.has(vignette)) return;
    vignette.classList.remove('is-playing');
    void vignette.getBoundingClientRect();
    vignette.classList.add('is-playing');
    timers.set(
      vignette,
      window.setTimeout(() => {
        vignette.classList.remove('is-playing');
        timers.delete(vignette);
      }, VIGNETTE_MS + 50),
    );
  };

  const cards = [...row.querySelectorAll<HTMLElement>('[data-wg-card]')];
  let pinned: Lane | null = null;
  const show = (lane: Lane | null) => {
    if (figure) {
      if (lane) figure.dataset.active = lane;
      else delete figure.dataset.active;
    }
    for (const card of cards)
      card.classList.toggle('is-active', card.dataset.wgCard === lane);
  };

  for (const card of cards) {
    const lane = card.dataset.wgCard as Lane;
    card.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return;
      show(lane);
      replay(lane);
    });
    card.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'touch') return;
      show(pinned);
    });
    card.addEventListener('focusin', () => {
      show(lane);
      replay(lane);
    });
    card.addEventListener('focusout', (event) => {
      if (!card.contains(event.relatedTarget as Node | null)) show(pinned);
    });
    // A tap pins the lane until another card, or the same one, is tapped.
    card.addEventListener('click', (event) => {
      if ((event.target as Element).closest('a')) return;
      pinned = pinned === lane ? null : lane;
      show(pinned);
      if (pinned) replay(lane);
    });
  }

  // The lane labels on the line do the same for pointers (the cards carry the keyboard path).
  for (const hit of figure?.querySelectorAll<SVGElement>('[data-lane-hit]') ??
    []) {
    const lane = hit.dataset.laneHit as Lane;
    hit.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') show(lane);
    });
    hit.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'touch') show(pinned);
    });
    hit.addEventListener('click', () => {
      pinned = pinned === lane ? null : lane;
      show(pinned);
    });
  }
}

const figure = document.querySelector<HTMLElement>(
  '[data-graphic="transit-line"]',
);
if (figure) initTransit(figure);
const row = document.querySelector<HTMLElement>(
  '[data-graphic="group-vignettes"]',
);
if (row) initCards(row, figure);
