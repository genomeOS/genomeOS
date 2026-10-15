/** How the groups fit together: the transit line's island (site redesign spec §4.3 C2, §2.7;
 * round 2 spec §4.3.3; #454).
 *
 * - The transit line plays once when 35% of it shows: the ion line draws over 2.4 s with the white
 *   stud riding its head; the teal hex joins at the model step and follows; both rest on the map's
 *   stretch. Stations light as the line reaches them. Then nothing runs. (It no longer opens the
 *   page, so it needs no pre-paint arming: FigureController arms it below the fold.)
 * - Hovering or tapping a lane's label lights that group's lane: its band tints, its stations and
 *   its own stretches of the line stay at full strength, and the other lanes' art drops to 32%. A
 *   tap pins the lane until the same label, or another, is tapped. Text only changes colour,
 *   never below 4.5:1. The figure's description names every lane's stations for assistive tech.
 *
 * The server markup is the final state of everything; FigureController arms and rests it.
 */

import { FigureController } from '../../graphics/figure';
import {
  TRANSIT_MS,
  filletRoute,
  tokenAt,
  type TokenPlan,
} from './transit-geometry';

type Lane = 'data' | 'modeling' | 'ui';

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

  initLanes(figure);
}

/** Each lane's label lights its lane: hover for pointers, a tap pins it (and a second tap lets go). */
function initLanes(figure: HTMLElement): void {
  let pinned: Lane | null = null;
  const show = (lane: Lane | null) => {
    if (lane) figure.dataset.active = lane;
    else delete figure.dataset.active;
  };
  for (const hit of figure.querySelectorAll<SVGElement>('[data-lane-hit]')) {
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
