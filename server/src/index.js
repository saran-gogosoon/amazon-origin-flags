import app from './app.js';
import { log } from './db.js';

const port = Number(process.env.PORT ?? 8080);
const server = app.listen(port, () => console.log(`origin-flags api on :${port}`));

// COLLECTOR=1 runs the queue worker inside the API process (what the Docker image does).
if (process.env.COLLECTOR === '1') {
  const { loop, stop } = await import('./collector/worker.js');
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { log('info', 'collector_stopping', { signal: sig }); stop(); server.close(); setTimeout(() => process.exit(0), 2000).unref(); });
  }
  loop().catch((err) => log('error', 'collector_crashed', { error: err.message }));
}
