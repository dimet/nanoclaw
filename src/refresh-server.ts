import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { syncSkills } from './skill-syncer.js';

const PORT = 3001;
const _env = readEnvFile(['SKYCLAW_INSTANCE_SECRET', 'SKYCLAW_GROUP_FOLDER']);
const SKYCLAW_INSTANCE_SECRET = _env.SKYCLAW_INSTANCE_SECRET;
const SKYCLAW_GROUP_FOLDER = _env.SKYCLAW_GROUP_FOLDER || 'discord_main';

export interface RuntimeState {
  channelsConnected: number;
  registeredGroups: number;
  messageLoopRunning: boolean;
}

function checkDocker(): 'ok' | 'error' {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    return 'ok';
  } catch {
    return 'error';
  }
}

function countSkills(): number {
  const dir = path.join(GROUPS_DIR, SKYCLAW_GROUP_FOLDER, 'skills');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((entry) => {
    return fs.statSync(path.join(dir, entry)).isDirectory();
  }).length;
}

function buildHealthPayload(getState?: () => RuntimeState): string {
  const state = getState?.();
  const docker = checkDocker();
  const skills = countSkills();

  return JSON.stringify({
    ok: true,
    uptime: Math.floor(process.uptime()),
    docker,
    skills,
    channelsConnected: state?.channelsConnected ?? null,
    registeredGroups: state?.registeredGroups ?? null,
    messageLoopRunning: state?.messageLoopRunning ?? null,
  });
}

export function startRefreshServer(opts?: { getState?: () => RuntimeState; onNewSkill?: import('./skill-syncer.js').OnNewSkill; onSkillsChanged?: import('./skill-syncer.js').OnSkillsChanged }): void {
  if (!SKYCLAW_INSTANCE_SECRET) {
    return; // Not configured — skip
  }

  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    if (token !== SKYCLAW_INSTANCE_SECRET) {
      res.writeHead(401).end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      const payload = buildHealthPayload(opts?.getState);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload);
      return;
    }

    if (req.method === 'POST' && req.url === '/refresh') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');

        // Provision any secrets included in the payload
        if (body) {
          try {
            const parsed = JSON.parse(body) as { secrets?: unknown[] };
            if (Array.isArray(parsed.secrets)) {
              for (const s of parsed.secrets) {
                const secret = s as { name: string; value: string; hostPattern: string; headerName: string };
                const result = spawnSync('onecli', [
                  'secrets', 'create',
                  '--name', secret.name,
                  '--type', 'generic',
                  '--value', secret.value,
                  '--host-pattern', secret.hostPattern,
                  '--header-name', secret.headerName,
                ], {
                  env: { ...process.env, ONECLI_API_HOST: 'http://127.0.0.1:10254', ONECLI_URL: 'http://127.0.0.1:10254' },
                  stdio: 'pipe',
                  timeout: 10000,
                });
                if (result.status !== 0) {
                  logger.warn({ stderr: result.stderr?.toString() }, 'refresh-server: onecli secrets create failed');
                } else {
                  logger.info({ name: secret.name }, 'refresh-server: secret provisioned');
                }
              }
            }
          } catch {
            // ignore parse errors
          }
        }

        syncSkills(opts?.onNewSkill, opts?.onSkillsChanged).catch((err: unknown) =>
          logger.warn({ err }, 'refresh-server: sync error'),
        );
      });
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'refresh-server: listening');
  });

  server.on('error', (err) => {
    logger.warn({ err }, 'refresh-server: error');
  });
}
