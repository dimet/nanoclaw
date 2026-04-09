import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const SKYCLAW_API_URL = process.env.SKYCLAW_API_URL;
const SKYCLAW_INSTANCE_ID = process.env.SKYCLAW_INSTANCE_ID;
const SKYCLAW_INSTANCE_SECRET = process.env.SKYCLAW_INSTANCE_SECRET;
const SKYCLAW_GROUP_FOLDER = process.env.SKYCLAW_GROUP_FOLDER || 'discord_main';

interface RemoteSkill {
  slug: string;
  content: string | null;
}

function skillsDir(): string {
  return path.join(GROUPS_DIR, SKYCLAW_GROUP_FOLDER, 'skills');
}

export async function syncSkills(): Promise<void> {
  if (!SKYCLAW_API_URL || !SKYCLAW_INSTANCE_ID || !SKYCLAW_INSTANCE_SECRET) {
    return; // Not configured — skip silently
  }

  try {
    const res = await fetch(
      `${SKYCLAW_API_URL}/api/instances/${SKYCLAW_INSTANCE_ID}/skills`,
      {
        headers: { Authorization: `Bearer ${SKYCLAW_INSTANCE_SECRET}` },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      logger.warn({ status: res.status }, 'skill-syncer: fetch failed');
      return;
    }

    const { skills }: { skills: RemoteSkill[] } = await res.json();
    const dir = skillsDir();

    // Write installed skills
    const installedSlugs = new Set<string>();
    for (const skill of skills) {
      if (!skill.content) continue;
      installedSlugs.add(skill.slug);
      const skillDir = path.join(dir, skill.slug);
      const skillFile = path.join(skillDir, 'SKILL.md');

      fs.mkdirSync(skillDir, { recursive: true });
      const current = fs.existsSync(skillFile)
        ? fs.readFileSync(skillFile, 'utf-8')
        : null;

      if (current !== skill.content) {
        fs.writeFileSync(skillFile, skill.content, 'utf-8');
        logger.info({ slug: skill.slug }, 'skill-syncer: wrote skill');
      }
    }

    // Remove skills that are no longer installed
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (!installedSlugs.has(entry)) {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
          logger.info({ slug: entry }, 'skill-syncer: removed skill');
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'skill-syncer: sync error');
  }
}

export function startSkillSyncer(): void {
  if (!SKYCLAW_API_URL || !SKYCLAW_INSTANCE_ID || !SKYCLAW_INSTANCE_SECRET) {
    return;
  }

  logger.info('skill-syncer: starting');

  // Initial sync
  syncSkills().catch(() => {});

  // Poll every 5 minutes
  setInterval(() => syncSkills().catch(() => {}), POLL_INTERVAL_MS);
}
