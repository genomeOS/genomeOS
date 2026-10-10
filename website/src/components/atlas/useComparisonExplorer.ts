/** Comparison navigation and URL ownership for Atlas design §11. */

import {
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { SharedNavigation } from '../../atlas/comparison';
import type { AtlasSceneController } from '../../atlas/scene/atlas-scene';
import type { StaticAtlasDataProvider } from '../../atlas/static-provider';
import {
  serializeExplorerState,
  type ExplorerState,
} from '../../atlas/url-state';
import { useComparisonNavigation } from './useComparisonNavigation';

export interface ComparisonExplorerProps {
  initialQuery?: string;
  dataProvider?: StaticAtlasDataProvider;
  writeUrl?: boolean;
  panel?: 'left' | 'right';
  navigation?: SharedNavigation;
  onStateChange?: (state: ExplorerState) => void;
  onReady?: () => void;
}

export function useComparisonExplorer(
  props: ComparisonExplorerProps,
  ready: boolean,
  scene: RefObject<AtlasSceneController | null>,
  state: ExplorerState | null,
  setState: Dispatch<SetStateAction<ExplorerState | null>>,
  onError: (message: string) => void,
): void {
  const { navigation, panel, onReady, onStateChange, writeUrl = true } = props;
  useEffect(() => {
    if (ready) onReady?.();
  }, [ready, onReady]);
  useComparisonNavigation(
    navigation,
    panel,
    ready,
    scene,
    state,
    setState,
    onError,
  );
  useEffect(() => {
    if (!state) return;
    onStateChange?.(state);
    if (!writeUrl) return;
    const query = serializeExplorerState(state);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${query}${window.location.hash}`,
    );
  }, [state, writeUrl, onStateChange]);
}
