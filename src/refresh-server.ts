import http from 'http';

import { logger } from './logger.js';
import { syncSkills } from './skill-syncer.js';

const PORT = 3001;
const SKYCLAW_INSTANCE_SECRET = process.env.SKYCLAW_INSTANCE_SECRET;

export function startRefreshServer(): void {
  if (!SKYCLAW_INSTANCE_SECRET) {
    return; // Not configured — skip
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/refresh') {
      res.writeHead(404).end();
      return;
    }

    const auth = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    if (token !== SKYCLAW_INSTANCE_SECRET) {
      res.writeHead(401).end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');

    // Trigger skill sync in the background — non-blocking
    syncSkills().catch((err) =>
      logger.warn({ err }, 'refresh-server: sync error'),
    );
  });

  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'refresh-server: listening');
  });

  server.on('error', (err) => {
    logger.warn({ err }, 'refresh-server: error');
  });
}
