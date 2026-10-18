/**
 * The explorer's Earth-presentation effects, for Atlas design §11 and interaction design §5
 * (#483): the basemap, its appearance and day/night lighting, physical terrain, and the relief of
 * that terrain. They left AtlasExplorer.tsx, which is held at its size (tests/atlas-module-size).
 *
 * Before an artifact is displayed a basemap or terrain change goes straight to the scene; once
 * one is, the change shows as scene activity while its imagery or terrain service answers.
 */

import { useEffect, type RefObject } from 'react';

import type { AtlasSceneController } from '../../atlas/scene/types';
import type { ExplorerState } from '../../atlas/url-state';
import type { useAtlasActivity } from './useAtlasActivity';

interface EarthPresentationOptions {
  runSceneActivity: ReturnType<typeof useAtlasActivity>['runScene'];
  scene: RefObject<AtlasSceneController | null>;
  sceneAttempt: number;
  sceneController: AtlasSceneController | null;
  sceneHasArtifact: () => boolean;
  state: ExplorerState | null;
}

export function useEarthPresentation({
  runSceneActivity,
  scene,
  sceneAttempt,
  sceneController,
  sceneHasArtifact,
  state,
}: EarthPresentationOptions): void {
  useEffect(() => {
    if (!state) return;
    if (!sceneHasArtifact()) {
      void scene.current?.setBasemap(state.basemap);
      return;
    }
    return runSceneActivity(
      'Changing basemap',
      'Waiting for imagery services',
      (controller) => controller.setBasemap(state.basemap),
    );
  }, [state?.basemap, sceneAttempt, sceneController]);

  useEffect(() => {
    if (state)
      scene.current?.setMapPresentation(
        state.basemapOpacity,
        state.basemapBrightness,
        state.dayNightLighting,
      );
  }, [
    state?.basemapOpacity,
    state?.basemapBrightness,
    state?.dayNightLighting,
    sceneAttempt,
    sceneController,
  ]);

  useEffect(() => {
    if (!state) return;
    if (!sceneHasArtifact()) {
      void scene.current?.setTerrain(state.terrain);
      return;
    }
    return runSceneActivity(
      'Changing terrain',
      'Waiting for terrain services',
      (controller) => controller.setTerrain(state.terrain),
    );
  }, [state?.terrain, sceneAttempt, sceneController]);

  useEffect(() => {
    if (state) scene.current?.setRelief(state.relief);
  }, [state?.relief, sceneAttempt, sceneController]);
}
