import assert from 'assert';
import * as dotenv from 'dotenv';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { GatewayIntentBits, IntentsBitField, Partials } from 'discord.js';
import { Client, Message } from 'discord.js';
dotenv.config();
import { Incident, PrismaClient } from './generated/client';
import { deleteOldMessages } from './generated/sql';
import { DetectIncident } from './spotter';
import * as Triage from './triage';
import { IncidentLog } from './audit';

//TODO: implement special bouncer routine which evaluates all new member's messages

type Ctx = { apiKey: string };

const dutyCycleMs = 15_000;
/** Statute of limitations */
const limitationMs = 60_000;
const probationMs = 30 * 60_000;
const punishmentHours = 1;
const punishmentMs = punishmentHours * 60 * 60_000;
let dutyCycleTimer: NodeJS.Timeout | undefined;

const adapter = new PrismaBetterSqlite3({ url: 'file:./prisma/db.db' });
export const prisma = new PrismaClient({ adapter });

export const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const truncate = (str: string, maxLength: number) =>
  str.length > maxLength ? str.slice(0, maxLength) + '...' : str;

async function FetchOffender(guildSf: bigint, offenderSf: bigint) {
  try {
    const guild = await client.guilds.fetch(`${guildSf}`);
    if (!guild) {
      console.warn(`Guild ${guildSf} not found.`);
      return null;
    }
    const offender = await guild.members.fetch(`${offenderSf}`);
    if (!offender) {
      console.warn(`Offender ${offenderSf} not found.`);
      return null;
    }
    return offender;
  } catch (err) {
    console.error(
      `Failed to fetch offender ${offenderSf} in guild ${guildSf}:`,
      err,
    );
    return null;
  }
}

async function MatchPriorIncident(incident: Incident): Promise<boolean> {
  const [probation] = await prisma.probation.findMany({
    where: {
      originalIncident: {
        id: { not: incident.id },
        guildSf: incident.guildSf,
        offenderSf: incident.offenderSf,
      },
      expiresAt: { gt: new Date() },
    },
    include: { originalIncident: true },
  });
  if (!probation) return false;

  const prior = probation.originalIncident;
  IncidentLog(incident, `**Incident is a repeat of #${prior.id}.**`);
  const until = new Date(Date.now() + punishmentMs);
  await prisma.incident.update({
    where: { id: incident.id },
    data: { punishments: { create: { probationId: probation.id, until } } },
  });

  const offender = await FetchOffender(incident.guildSf, incident.offenderSf);
  if (!offender) {
    IncidentLog(
      incident,
      `**Failed to notify <@${incident.offenderSf}> of repeat incident.**`,
    );
    return true;
  }

  const t = Math.floor(until.getTime() / 1000);
  try {
    await offender.send({
      embeds: [
        {
          title: `You misbehaved again!`,
          description:
            'I told you if you if you broke the same rule again this would happen.',
          fields: [
            { name: 'You sent', value: `> ${incident.msgContent}` },
            {
              name: 'What happens now',
              value: `Any suspicious messages will be automatically deleted`,
            },
            { name: 'When this will stop happening', value: `<t:${t}:R>` },
          ],
          color: 0xff0000,
          footer: { text: `Incident #${incident.id}` },
        },
      ],
    });
  } catch (err) {
    IncidentLog(
      incident,
      `**Failed to notify <@${offender?.user.id}> of repeat incident.**`,
    );
    console.error(
      `Failed to notify repeat offender ${offender?.user.id}:`,
      err,
    );
  }
  return true;
}

async function TriageIncident({ apiKey }: Ctx, incident: Incident) {
  const result = await Triage.TriageIncident(apiKey, incident);
  const message = await (async () => {
    try {
      return await client.channels
        .fetch(`${incident.channelSf}`)
        .then(channel =>
          channel?.isTextBased()
            ? channel.messages.fetch(`${incident.messageSf}`)
            : undefined,
        );
    } catch {}
  })();
  if (!message) return;
  if (result.kind === 'ignore') {
    IncidentLog(incident, '**Incident ignored.**', result.thoughts);
    await prisma.incident.update({
      where: { id: incident.id },
      data: { ignoredBecause: result.thoughts },
    });
    try {
      await message.reactions.resolve('🚨')?.remove();
    } catch {}
  }
  if (result.kind === 'punish') {
    const { thoughts, caution, notification } = result;
    IncidentLog(
      incident,
      ':rotating_light: **Intervention required.**',
      thoughts,
    );

    const messageStatus = (() => {
      if (notification) {
        const payload = {
          content:
            '_' +
            notification.replace(/\[offender\]/g, `<@${incident.offenderSf}>`) +
            '_',
          allowedMentions: { parse: [] },
        };
        try {
          if (message.reference && !message.messageSnapshots.size) {
            void message
              .fetchReference()
              .then(reference => reference.reply(payload));
          } else if ('send' in message.channel) {
            void message.channel.send(payload);
          }
        } catch (err) {
          console.error('Failed to notify chat', err);
        }
      }
      void message.delete();
      return 'deleted';
    })();
    IncidentLog(
      incident,
      `https://discord.com/channels/${incident.guildSf}/${incident.channelSf}/${incident.messageSf} ${messageStatus} `,
    );

    if (await MatchPriorIncident(incident)) return;

    const expiresAt = new Date(Date.now() + probationMs);
    await prisma.incident.update({
      where: { id: incident.id },
      data: { probations: { create: { expiresAt, caution, notification } } },
    });
  }
}

async function ProcessIncidents(ctx: Ctx) {
  const unprocessed = await prisma.incident.findMany({
    where: {
      at: { gt: new Date(Date.now() - limitationMs) },
      ignoredBecause: null,
      probations: { none: {} },
      punishments: { none: {} },
    },
  });
  if (!unprocessed.length) return;

  console.log(
    `Found unprocessed incidents: #${unprocessed.map(u => u.id).join(', #')}`,
  );
  for (const incident of unprocessed) {
    await TriageIncident(ctx, incident);
  }
}

async function ProcessProbations() {
  const startUninformedProbations = await prisma.probation.findMany({
    where: { startInformed: false },
    include: { originalIncident: true },
  });
  if (!startUninformedProbations.length) return;
  for (const probation of startUninformedProbations) {
    const { originalIncident: incident, caution } = probation;
    const t = Math.floor(probation.expiresAt.getTime() / 1000);
    try {
      const offender = await client.users.fetch(`${incident.offenderSf}`);
      if (!offender) {
        console.warn(`Offender ${incident.offenderSf} not found.`);
        continue;
      }
      await offender.send({
        embeds: [
          {
            title: "I'm going to be watching you closely.",
            description: caution ?? undefined,
            color: 0xffff00,
            fields: [
              { name: 'You sent', value: `> ${incident.msgContent}` },
              {
                name: 'If you misbehave again',
                value: `Any even slightly suspicious messages will be automatically deleted for ${punishmentHours}h.`,
              },
              {
                name: 'If you do not misbehave',
                value: `You will be forgiven <t:${t}:R>.`,
              },
            ],
            footer: { text: `Incident #${incident.id}` },
          },
        ],
      });
      IncidentLog(
        incident,
        `**Cautioned <@${offender.id}>.**`,
        caution ?? undefined,
      );
    } catch (err) {
      IncidentLog(
        incident,
        `**Failed to notify <@${incident.offenderSf}> of probation.**`,
      );
      console.error(`Failed to notify offender ${incident.offenderSf}:`, err);
    }
    await prisma.probation.update({
      where: { id: probation.id },
      data: { startInformed: true },
    });
  }
}

let dutyCycleSemaphore = false;
const DutyCycle = (ctx: Ctx) => async () => {
  if (dutyCycleSemaphore) {
    console.log('Duty cycle already running, skipping this cycle.');
    return;
  }
  dutyCycleSemaphore = true;
  clearTimeout(dutyCycleTimer);
  await ProcessIncidents(ctx);
  await ProcessProbations();
  dutyCycleTimer = setTimeout(DutyCycle(ctx), dutyCycleMs);
  dutyCycleSemaphore = false;
};

client.once('ready', () => {
  console.log(`Logged in as ${client.user?.id}`);
  const { OPENAI_API_KEY } = process.env;
  assert(OPENAI_API_KEY, 'OPENAI_API_KEY must be set in environment variables');
  const ctx: Ctx = { apiKey: OPENAI_API_KEY };
  void DutyCycle(ctx)();

  void client.application?.commands.create({
    name: 'audit-here',
    description: 'Log activity in this channel for auditing',
  });

  async function HandleMessage(message: Message, OPENAI_API_KEY: string) {
    if (!message.guildId || message.author.bot) return;
    //Check the message is not more than one day old
    const oneDayAgo = Date.now() - 1000 * 60 * 60 * 24;
    if (message.createdAt.getTime() < oneDayAgo) return;

    const [guildSf, channelSf, messageSf, authorSf] = [
      BigInt(message.guildId),
      BigInt(message.channelId),
      BigInt(message.id),
      BigInt(message.author.id),
    ];

    const repliedTo =
      !message.messageSnapshots.size && message.reference?.messageId
        ? await (async messageId => {
            try {
              return await message.channel.messages
                .fetch(messageId)
                .then(m => m.content);
            } catch {}
          })(message.reference.messageId)
        : undefined;
    const truncatedContent = truncate(
      message.content ||
        [...message.messageSnapshots].map(x => x[1].content).join('\n'),
      512,
    );
    const content =
      truncatedContent +
      (repliedTo ? ` (in reply to "${truncate(repliedTo, 50)}")` : '') +
      ' ' +
      message.attachments.map(a => `[Attachment: ${a.name}]`).join(' ');
    const sanitisedContent = content.replaceAll(
      /[\uD800-\uDBFF][\uDC00-\uDFFF]/g,
      pair => {
        const codePoint =
          ((pair.charCodeAt(0) - 0xd800) << 10) +
          (pair.charCodeAt(1) - 0xdc00) +
          0x10000;
        return `\\u{${codePoint.toString(16)}}`;
      },
    );

    try {
      const existingMessage = await prisma.message.findUnique({
        where: {
          guildSf_channelSf_messageSf: { guildSf, channelSf, messageSf },
        },
      });
      if (existingMessage) {
        await prisma.message.update({
          where: { id: existingMessage.id },
          data: { content: sanitisedContent },
        });
      } else {
        await prisma.message.create({
          data: {
            ...{ guildSf, channelSf, messageSf, authorSf },
            content: sanitisedContent,
          },
        });
      }
    } catch (err) {
      console.error('Failed to save message:', content, sanitisedContent, err);
      return;
    }
    await prisma.$queryRawTyped(deleteOldMessages());
    const incidentCategories = await (async () => {
      try {
        return await DetectIncident(
          OPENAI_API_KEY,
          truncatedContent,
          message.attachments,
        );
      } catch {}
    })();
    if (!incidentCategories) return;

    //Check if they're currently punished
    const punishment = await prisma.punishment.findFirst({
      where: {
        secondIncident: { guildSf, offenderSf: authorSf },
        until: { gt: new Date() },
      },
      include: { secondIncident: true },
    });

    if (punishment) {
      const untilSec = Math.floor(punishment.until.getTime() / 1000);
      void message.delete();
      IncidentLog(
        punishment.secondIncident,
        `**Deleted <@${authorSf}>'s message.** They are still being punished (expires <t:${untilSec}:R>).`,
        message.content,
      );
      return;
    }

    try {
      await message.react('🚨');
    } catch {}
    const context = await prisma.message
      .findMany({ where: { guildSf, channelSf }, orderBy: { at: 'asc' } })
      .then(messages =>
        messages.map(m => `${m.authorSf}: ${m.content}`).join('\n'),
      );
    const attachments = message.attachments.map(a => a.url).join(' ');
    const msgContent = content + attachments;
    const incident = await prisma.incident.create({
      data: {
        ...{ guildSf, channelSf, messageSf },
        offenderSf: authorSf,
        msgContent,
        context,
        categories: incidentCategories,
      },
    });
    IncidentLog(
      incident,
      `**New incident.** <@${authorSf}>. Flagged for *${incidentCategories}*. https://discord.com/channels/${incident.guildSf}/${incident.channelSf}/${incident.messageSf}`,
      content,
    );
    await DutyCycle(ctx)();
  }

  client.on('messageUpdate', async (_, newMessage) => {
    await HandleMessage(newMessage, OPENAI_API_KEY);
  });
  client.on('messageCreate', async message => {
    await HandleMessage(message, OPENAI_API_KEY);
  });

  client.on('interactionCreate', async interaction => {
    if (
      !interaction.guildId ||
      !interaction.guild ||
      !interaction.member ||
      !interaction.isCommand()
    ) {
      return;
    }
    if (interaction.commandName !== 'audit-here') return;
    //Check the user has higher role than the bot
    const me = await interaction.guild.members.fetchMe();
    const them = await interaction.guild.members.fetch(interaction.user.id);
    if (
      !me.roles.highest ||
      !them.roles.highest ||
      them.roles.highest.position <= me.roles.highest.position
    ) {
      await interaction.reply({
        content: 'You must have a higher role than me to use this command.',
        ephemeral: true,
      });
      return;
    }
    const sf = BigInt(interaction.guildId);
    const existing = await prisma.guild.findUnique({ where: { sf } });
    const auditChannelSf = existing?.auditChannelSf
      ? null
      : BigInt(interaction.channelId);
    await prisma.guild.upsert({
      where: { sf },
      create: { sf, auditChannelSf },
      update: { auditChannelSf },
    });
    await interaction.reply({
      content: auditChannelSf
        ? 'This channel will now be used for auditing.'
        : 'This channel is no longer being used for auditing.',
      ephemeral: true,
    });
  });
});

assert(
  process.env.DISCORD_TOKEN,
  'DISCORD_TOKEN must be set in environment variables',
);
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Failed to login to Discord:', err);
  process.exit(1);
});
