import { Client, Events, GatewayIntentBits, Message, TextChannel, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { SlashSkill, registerGuildCommands } from './discord-slash-commands.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private currentSkills: SlashSkill[] = [];
  private pendingInteractions = new Map<string, ChatInputCommandInteraction>();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map((att) => {
          const contentType = att.contentType || '';
          if (contentType.startsWith('image/')) {
            return `[Image: ${att.name || 'image'}]`;
          } else if (contentType.startsWith('video/')) {
            return `[Video: ${att.name || 'video'}]`;
          } else if (contentType.startsWith('audio/')) {
            return `[Audio: ${att.name || 'audio'}]`;
          } else {
            return `[File: ${att.name || 'file'}]`;
          }
        });
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'discord', isGroup);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle slash command interactions
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const chatJid = `dc:${interaction.channelId}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Acknowledge immediately — Discord requires a response within 3 seconds.
      // Use reply() instead of deferReply() so the bot's display name appears
      // rather than the Discord application name in the "thinking" state.
      await interaction.reply({ content: `_${ASSISTANT_NAME} is thinking..._` }).catch((err: unknown) => {
        logger.warn({ err }, 'discord-slash: failed to send initial reply');
      });
      this.pendingInteractions.set(chatJid, interaction);

      const input = interaction.options.getString('input') ?? '';
      const content = `@${ASSISTANT_NAME} /${interaction.commandName}${input ? ` ${input}` : ''}`;
      const timestamp = new Date().toISOString();
      const senderName =
        (interaction.member as GuildMember | null)?.displayName ??
        interaction.user.displayName ??
        interaction.user.username;

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'discord', true);
      this.opts.onMessage(chatJid, {
        id: interaction.id,
        chat_jid: chatJid,
        sender: interaction.user.id,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid, command: interaction.commandName }, 'Discord slash command received');
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );

        // Set per-guild nickname to match the configured assistant name.
        // This overrides the Discord application name without requiring a
        // global username change (which is heavily rate-limited).
        for (const guild of readyClient.guilds.cache.values()) {
          guild.members.me?.setNickname(ASSISTANT_NAME).catch((err: unknown) => {
            logger.warn({ guild: guild.name, err }, 'Could not set guild nickname');
          });
        }

        // Also set nickname and register slash commands in any guild the bot joins later
        readyClient.on(Events.GuildCreate, (guild) => {
          guild.members.me?.setNickname(ASSISTANT_NAME).catch((err) => {
            logger.debug({ guild: guild.name, err }, 'Could not set guild nickname on join');
          });
          if (this.currentSkills.length > 0) {
            registerGuildCommands(this.botToken, guild.id, this.currentSkills).catch((err: unknown) => {
              logger.warn({ guild: guild.name, err }, 'discord-slash: failed to register commands on guild join');
            });
          }
        });

        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const MAX_LENGTH = 2000;

      // If there's a pending slash command interaction, reply to it
      const interaction = this.pendingInteractions.get(jid);
      if (interaction) {
        this.pendingInteractions.delete(jid);
        await interaction.editReply(text.slice(0, MAX_LENGTH));
        // Send any overflow chunks as regular messages
        if (text.length > MAX_LENGTH) {
          const channel = await this.client.channels.fetch(channelId);
          if (channel && 'send' in channel) {
            for (let i = MAX_LENGTH; i < text.length; i += MAX_LENGTH) {
              await (channel as TextChannel).send(text.slice(i, i + MAX_LENGTH));
            }
          }
        }
        logger.info({ jid, length: text.length }, 'Discord interaction reply sent');
        return;
      }

      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  async registerSlashCommandsForAllGuilds(skills: SlashSkill[]): Promise<void> {
    this.currentSkills = skills;
    if (!this.client?.isReady()) return;
    for (const guild of this.client.guilds.cache.values()) {
      await registerGuildCommands(this.botToken, guild.id, skills).catch((err: unknown) => {
        logger.warn({ guild: guild.name, err }, 'discord-slash: failed to register commands');
      });
    }
    logger.info({ count: skills.length }, 'discord-slash: registered commands in all guilds');
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
