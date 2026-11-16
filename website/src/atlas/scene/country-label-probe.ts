/**
 * The e2e build's reading of the country labels (Atlas design §11; owner report 2026-11-16), which
 * `countryLabelsTestHook` publishes as `window.__atlasCountryLabels`: each label's text, whether it
 * is shown, where Cesium draws it, how far it is drawn, and its box on the canvas. A browser test
 * works out from these which labels lie beyond the horizon, and compares the pixels in their boxes
 * with the labels drawn and hidden.
 */

import {
  Label,
  type BoundingRectangle,
  type Cartesian2,
  type Cartesian3,
  type Scene,
} from 'cesium';

import type { CountryLabel, CountryLabels } from '../e2e-hooks';
import { drawnPosition } from './horizon';

/** Cesium's label box, @private and out of its typings (Label.js `getScreenSpaceBoundingBox`). */
const labelBox = (
  Label as unknown as {
    getScreenSpaceBoundingBox(
      label: Label,
      screenSpacePosition: Cartesian2,
    ): BoundingRectangle;
  }
).getScreenSpaceBoundingBox;

const triple = ({ x, y, z }: Cartesian3): [number, number, number] => [x, y, z];

function readLabel(scene: Scene, label: Label): CountryLabel {
  const anchor = label.computeScreenSpacePosition(scene);
  const box = anchor ? labelBox(label, anchor) : undefined;
  return {
    box: box
      ? { height: box.height, width: box.width, x: box.x, y: box.y }
      : null,
    far: label.distanceDisplayCondition?.far ?? Number.POSITIVE_INFINITY,
    position: triple(drawnPosition(label)),
    show: label.show,
    text: label.text,
  };
}

/** The camera and every label in `labels`, as `window.__atlasCountryLabels` reports them. */
export function readCountryLabels(
  scene: Scene,
  labels: readonly Label[],
): CountryLabels {
  return {
    camera: triple(scene.camera.positionWC),
    labels: labels.map((label) => readLabel(scene, label)),
    tilesLoaded: scene.globe.tilesLoaded,
  };
}
