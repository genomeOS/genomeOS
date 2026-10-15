/**
 * "Why hemoglobin S makes it tangible" (round 2 spec §4.2.2; ruling 36), loaded when its section
 * opens (accordion.ts): the genotype triad, and the HbS map with its two data files. Nothing here
 * runs, and no byte of the map's data is fetched, while the section is closed.
 */
import type { FigureControllerOptions } from '../../graphics/figure';
import { initGenotype } from './genotype';
import { initHbsMap } from './hbs-map';

const urls = import.meta.glob(
  [
    '../../data/figures/hbs-region.*.bin',
    '../../data/figures/hbs-surveys.*.bin',
  ],
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>;
const pick = (prefix: string) =>
  Object.entries(urls).find(([file]) => file.includes(`/${prefix}.`))?.[1];

export function init(
  section: HTMLElement,
  options?: FigureControllerOptions,
): Promise<void> | void {
  const triad = section.querySelector<HTMLElement>('[data-genotype-root]');
  if (triad) initGenotype(triad);
  const figure = section.querySelector<HTMLElement>(
    'figure[data-graphic="hbs-threshold"]',
  );
  const region = pick('hbs-region');
  const surveys = pick('hbs-surveys');
  if (figure && region && surveys)
    return initHbsMap(figure, { region, surveys }, options);
}
