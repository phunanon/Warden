import assert from 'assert';
import * as dotenv from 'dotenv';
dotenv.config();
import { Incident, PrismaClient } from '@prisma/client';
import { deleteOldMessages } from '@prisma/client/sql';
import { GatewayIntentBits, IntentsBitField, Partials } from 'discord.js';
import { Client } from 'discord.js';
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

export const prisma = new PrismaClient();

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
  const t = Math.floor(until.getTime() / 1000);
  try {
    await offender?.send({
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
  if (result.kind === 'ignore') {
    IncidentLog(incident, '**Incident ignored.**', result.thoughts);
    await prisma.incident.update({
      where: { id: incident.id },
      data: { ignoredBecause: result.thoughts },
    });
    try {
      await message?.reactions.resolve('🚨')?.remove();
    } catch {}
  }
  if (result.kind === 'punish') {
    const { thoughts, caution = 'The server does not tolerate misbehaviour.' } =
      result;
    IncidentLog(
      incident,
      ':rotating_light: **Intervention required.**',
      thoughts,
    );

    const messageStatus = (() => {
      if (!message) return 'not found';
      void message.delete();
      return 'deleted';
    })();
    IncidentLog(
      incident,
      `https://discord.com/channels/${incident.guildSf}/${incident.channelSf}/${incident.messageSf} ${messageStatus} `,
    );

    if (await MatchPriorIncident(incident)) return;

    {
      const guild = await client.guilds.fetch(`${incident.guildSf}`);
      if (!guild) {
        console.warn(`Guild ${incident.guildSf} not found.`);
        return;
      }
      const offender = await guild.members.fetch(`${incident.offenderSf}`);
      if (!offender) {
        console.warn(`Offender ${incident.offenderSf} not found.`);
        return;
      }
      try {
        await offender.timeout(
          10_000,
          `To read my DM about incident #${incident.id}`,
        );
      } catch (err) {
        console.error(`Failed to timeout offender ${offender.user.id}:`, err);
      }
    }
    const expiresAt = new Date(Date.now() + probationMs);
    await prisma.incident.update({
      where: { id: incident.id },
      data: { probations: { create: { expiresAt, caution } } },
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
  if (unprocessed.length) {
    console.log(
      `Found unprocessed incidents: #${unprocessed.map(u => u.id).join(', #')}`,
    );
    for (const incident of unprocessed) {
      await TriageIncident(ctx, incident);
    }
  } else {
    console.log('No incidents to triage.');
  }
}

async function ProcessProbations() {
  const startUninformedProbations = await prisma.probation.findMany({
    where: { startInformed: false },
    include: { originalIncident: true },
  });
  const expiryUninformedProbations = await prisma.probation.findMany({
    where: { expiresAt: { lt: new Date() }, endInformed: false },
    include: { originalIncident: true },
  });
  if (!startUninformedProbations.length && !expiryUninformedProbations.length) {
    console.log('No probations to process.');
    return;
  }
  for (const probation of startUninformedProbations) {
    const { originalIncident: incident, caution } = probation;
    const offender = await client.users.fetch(`${incident.offenderSf}`);
    if (!offender) {
      console.warn(`Offender ${incident.offenderSf} not found.`);
      continue;
    }
    const t = Math.floor(probation.expiresAt.getTime() / 1000);
    try {
      await offender.send({
        embeds: [
          {
            title: "I'm going to be watching you closely.",
            description: caution,
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
      IncidentLog(incident, `**Cautioned <@${offender.id}>.**`, caution);
    } catch (err) {
      IncidentLog(
        incident,
        `**Failed to notify <@${offender.id}> of probation.**`,
      );
      console.error(`Failed to notify offender ${offender.id}:`, err);
    }
    await prisma.probation.update({
      where: { id: probation.id },
      data: { startInformed: true },
    });
  }
  for (const probation of expiryUninformedProbations) {
    const { originalIncident: incident } = probation;
    const offender = await client.users.fetch(`${incident.offenderSf}`);
    if (!offender) {
      console.warn(`Offender ${incident.offenderSf} not found.`);
      continue;
    }
    try {
      await offender.send({
        embeds: [
          {
            title: 'Thank you.',
            description: 'You are forgiven for the earlier incident.',
            color: 0x00ff00,
            footer: { text: `Incident #${incident.id}` },
          },
        ],
      });
      IncidentLog(incident, `**<@${offender.id}> is forgiven.**`);
    } catch (err) {
      IncidentLog(
        incident,
        `**Failed to notify offender <@${offender.id}> of forgiveness.**`,
      );
      console.error(`Failed to notify ex-offender ${offender.id}:`, err);
    }
    await prisma.probation.update({
      where: { id: probation.id },
      data: { endInformed: true },
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

  client.on('messageCreate', async message => {
    // if (message.guildId !== '965259347250782238') return;
    if (!message.guildId || message.author.bot) return;
    const [guildSf, channelSf, messageSf, authorSf] = [
      BigInt(message.guildId),
      BigInt(message.channelId),
      BigInt(message.id),
      BigInt(message.author.id),
    ];
    const repliedTo = message.reference?.messageId
      ? await (async messageId => {
          try {
            return await message.channel.messages
              .fetch(messageId)
              .then(m => m.content);
          } catch {}
        })(message.reference.messageId)
      : undefined;
    const unsanitised =
      truncate(message.content, 512) +
      (repliedTo ? ` (in reply to "${truncate(repliedTo, 50)}")` : '') +
      message.attachments.map(a => `[Attachment: ${a.name}]`).join(' ');
    const content = unsanitised.replace(/\\/g, '/');
    await prisma.message.create({
      data: { guildSf, channelSf, messageSf, authorSf, content },
    });
    await prisma.$queryRawTyped(deleteOldMessages());
    const incidentCategories = await (async () => {
      try {
        return await DetectIncident(OPENAI_API_KEY, message);
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
      void message.delete();
      IncidentLog(
        punishment.secondIncident,
        `**Deleted <@${authorSf}>'s message.** They are currently being punished.`,
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
    // interaction.guild.channels
    //   .fetch('981171582691082240')
    //   .then(x =>
    //     x?.send('<@1371248865159942175> and <@1272273667283488881> shall duel to the death.'),
    //   );
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
