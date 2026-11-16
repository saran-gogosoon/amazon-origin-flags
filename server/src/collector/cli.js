// Collector CLI.
//   npm run collect -- --search Gartenschere --pages 2   seed from a search, then work the queue until empty
//   npm run collect -- --asin B0035T5MJM                 queue one product and work the queue
//   npm run collector                                    long-running loop over the queue (resume-safe)
import { parseArgs } from 'node:util';
import { enqueue, log } from '../db.js';
import { runSearch, loop, stop } from './worker.js';
import { BlockedError, HostPausedError, closeBrowser } from './http.js';

const { values: args } = parseArgs({
  options: {
    search: { type: 'string' }, pages: { type: 'string', default: '2' }, asin: { type: 'string', multiple: true },
    loop: { type: 'boolean', default: false }, 'no-process': { type: 'boolean', default: false },
  },
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); log('info', 'collector_stopping', { signal: sig }); });

try {
  if (args.search) {
    try {
      await runSearch(args.search, Number(args.pages));
    } catch (err) {
      if (!(err instanceof BlockedError || err instanceof HostPausedError)) throw err;
      enqueue('search', args.search, { priority: 30, origin: 'cli', rearm: true }); // retried by the loop
    }
  }
  for (const a of args.asin ?? []) enqueue('product', a, { priority: 20, origin: 'cli', rearm: true });
  if (!args['no-process']) await loop({ untilEmpty: !args.loop });
} catch (err) {
  log('error', 'collector_crashed', { error: err.message });
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
