import { parentPort, workerData } from 'node:worker_threads';
import { parseStaticTailwindModule } from './tailwind-static-parser.js';

try {
  const config = parseStaticTailwindModule(workerData.source, workerData.limits);
  parentPort.postMessage({ ok: true, config });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'TAILWIND_STATIC_PARSE',
      message: typeof error?.message === 'string' ? error.message : 'Static Tailwind configuration could not be parsed',
    },
  });
}
