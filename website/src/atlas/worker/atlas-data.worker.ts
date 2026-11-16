/**
 * Atlas data worker entry for Atlas design §11 and fast-load design §B.6.3: Cesium-free; its one
 * `import()` loads the raster runtime on the first raster request (terrain draping design, "Per
 * layer under World Terrain", #483). All logic lives in importable modules that vitest tests
 * directly.
 */

import { createDispatcher } from './dispatcher';
import { ATLAS_WORKER_HANDLERS } from './handlers';
import type { WorkerInbound } from './protocol';

const dispatch = createDispatcher(
  { post: (message, transfer) => self.postMessage(message, { transfer }) },
  ATLAS_WORKER_HANDLERS,
);

self.addEventListener('message', (event: MessageEvent<WorkerInbound>) =>
  dispatch(event.data),
);
