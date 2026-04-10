/**
 * Discord slash command registration via REST API.
 *
 * We register commands per-guild (not globally) so changes take effect
 * instantly — global commands can take up to 1 hour to propagate.
 *
 * Requires DISCORD_APPLICATION_ID in the .env file alongside DISCORD_BOT_TOKEN.
 */

import { REST, Routes } from 'discord.js';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

export interface SlashSkill {
  slug: string;
  name: string;
  description: string;
}

async function getRestClient(botToken: string): Promise<{ rest: REST; appId: string } | null> {
  const env = readEnvFile(['DISCORD_APPLICATION_ID']);
  let appId = process.env.DISCORD_APPLICATION_ID || env.DISCORD_APPLICATION_ID;

  if (!appId) {
    // Auto-detect from the bot token — the bot user's ID is the application ID
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const user = await res.json() as { id?: string };
        if (user.id) appId = user.id;
      }
    } catch {
      // fall through
    }
  }

  if (!appId) {
    logger.debug('discord-slash: could not determine DISCORD_APPLICATION_ID — skipping slash command sync');
    return null;
  }

  const rest = new REST({ version: '10' }).setToken(botToken);
  return { rest, appId };
}

/**
 * Register skill-derived slash commands for a single guild.
 * Overwrites existing commands with the full list (Discord replaces, not merges).
 */
export async function registerGuildCommands(
  botToken: string,
  guildId: string,
  skills: SlashSkill[],
): Promise<void> {
  const client = await getRestClient(botToken);
  if (!client) return;

  const body = skills.map((s) => ({
    name: s.slug.slice(0, 32),
    description: (s.description || s.name || s.slug).slice(0, 100) || 'Run this skill',
    options: [
      {
        type: 3, // ApplicationCommandOptionType.String
        name: 'input',
        description: 'Additional context or parameters',
        required: false,
      },
    ],
  }));

  await client.rest.put(
    Routes.applicationGuildCommands(client.appId, guildId),
    { body },
  );
  logger.info({ guildId, count: body.length }, 'discord-slash: registered guild commands');
}

/**
 * Clear all slash commands for a guild (e.g. on bot removal).
 */
export async function clearGuildCommands(
  botToken: string,
  guildId: string,
): Promise<void> {
  const client = await getRestClient(botToken);
  if (!client) return;

  await client.rest.put(
    Routes.applicationGuildCommands(client.appId, guildId),
    { body: [] },
  );
  logger.info({ guildId }, 'discord-slash: cleared guild commands');
}
