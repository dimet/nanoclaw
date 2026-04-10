import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const _env = readEnvFile(['SKYCLAW_API_URL', 'SKYCLAW_INSTANCE_ID', 'SKYCLAW_INSTANCE_SECRET', 'SKYCLAW_GROUP_FOLDER']);
const SKYCLAW_API_URL = _env.SKYCLAW_API_URL;
const SKYCLAW_INSTANCE_ID = _env.SKYCLAW_INSTANCE_ID;
const SKYCLAW_INSTANCE_SECRET = _env.SKYCLAW_INSTANCE_SECRET;
const SKYCLAW_GROUP_FOLDER = _env.SKYCLAW_GROUP_FOLDER || 'discord_main';

export type OnNewSkill = (slug: string, name: string, description: string) => void;

interface RemoteSkill {
  slug: string;
  content: string | null;
}

function skillsDir(): string {
  return path.join(DATA_DIR, 'sessions', SKYCLAW_GROUP_FOLDER, '.claude', 'skills');
}

function parseSkillMeta(content: string): { name: string; description: string } {
  const lines = content.split('\n');

  // Name: first # heading, stripping any subtitle after ":"
  const headingLine = lines.find((l) => l.startsWith('# '));
  const rawName = headingLine ? headingLine.replace(/^# /, '').trim() : '';
  const name = rawName.split(':')[0].trim() || rawName;

  // Description: first non-empty plain paragraph after the heading
  let pastHeading = false;
  let description = '';
  for (const line of lines) {
    if (line.startsWith('# ')) { pastHeading = true; continue; }
    if (!pastHeading) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip headings, bold metadata lines, list items, code fences
    if (trimmed.startsWith('#') || trimmed.startsWith('**') || trimmed.startsWith('-') || trimmed.startsWith('*') || trimmed.startsWith('`')) continue;
    description = trimmed;
    break;
  }

  return { name: name || 'New skill', description };
}

export async function syncSkills(onNewSkill?: OnNewSkill): Promise<void> {
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

    const body = await res.json() as { skills: RemoteSkill[] };
    const dir = skillsDir();

    // Write installed skills
    const { skills } = body;
    const installedSlugs = new Set<string>();
    for (const skill of skills) {
      if (!skill.content) continue;
      installedSlugs.add(skill.slug);
      const skillDir = path.join(dir, skill.slug);
      const skillFile = path.join(skillDir, 'SKILL.md');

      fs.mkdirSync(skillDir, { recursive: true });
      const isNew = !fs.existsSync(skillFile);
      const current = isNew ? null : fs.readFileSync(skillFile, 'utf-8');

      if (current !== skill.content) {
        fs.writeFileSync(skillFile, skill.content, 'utf-8');
        logger.info({ slug: skill.slug }, 'skill-syncer: wrote skill');

        if (isNew && onNewSkill) {
          const { name, description } = parseSkillMeta(skill.content);
          onNewSkill(skill.slug, name, description);
        }
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

export function startSkillSyncer(opts?: { onNewSkill?: OnNewSkill }): void {
  if (!SKYCLAW_API_URL || !SKYCLAW_INSTANCE_ID || !SKYCLAW_INSTANCE_SECRET) {
    return;
  }

  logger.info('skill-syncer: starting');

  const notify = opts?.onNewSkill;

  // Initial sync
  syncSkills(notify).catch(() => {});

  // Poll every 5 minutes
  setInterval(() => syncSkills(notify).catch(() => {}), POLL_INTERVAL_MS);
}
