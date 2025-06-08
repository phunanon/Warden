import assert from 'assert';
import * as dotenv from 'dotenv';
dotenv.config();
import { Incident, PrismaClient } from '@prisma/client';
import { GatewayIntentBits, IntentsBitField, Partials } from 'discord.js';
import { Client } from 'discord.js';
import { DetectIncident } from './spotter';
import * as Triage from './traige';

type Ctx = { apiKey: string };

const dutyCycleMs = 15_000;
const probationMs = 60 * 60_000;
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
  closeTimeout: 6_000,
});

async function TriageIncident({ apiKey }: Ctx, incident: Incident) {
  const result = await Triage.TriageIncident(apiKey, incident);
  const message = await client.channels
    .fetch(`${incident.channelSf}`)
    .then(channel =>
      channel?.isTextBased()
        ? channel.messages.fetch(`${incident.messageSf}`)
        : undefined,
    );
  void message?.reactions.resolve('🚨')?.remove();
  if ('ignoreReason' in result) {
    console.log(`Ignoring incident ${incident.id}: ${result.ignoreReason}`);
    await prisma.incident.update({
      where: { id: incident.id },
      data: { resolution: result.ignoreReason },
    });
    return;
  }
  if ('victimId' in result) {
    const { victimId, rule } = result;
    const { offenderSf } = incident;
    const pardons = await prisma.pardon
      .findMany({
        where: { incident: { offenderSf } },
        include: { intervention: { select: { victimSf: true } } },
      })
      .then(p => p.map(p => p.intervention.victimSf));
    if (!/^[0-9]+$/.test(victimId)) {
      console.warn(
        `Invalid victim ID format: "${victimId}". Expected a numeric SF.`,
      );
      return;
    }
    const victimSf = BigInt(victimId);
    if (pardons.includes(victimSf)) {
      console.log(
        `Pardon found for offender ${offenderSf} by victim ${victimSf}; ignoring incident ${incident.id}.`,
      );
      await prisma.incident.update({
        where: { id: incident.id },
        data: { resolution: 'Pardon found for victim' },
      });
      return;
    }
    console.log(
      `Intervening in incident ${incident.id} for victim ${victimSf}.`,
    );
    await prisma.incident.update({
      where: { id: incident.id },
      data: {
        resolution: `Intervened in protection of <@${victimSf}>`,
        victimInterventions: { create: { victimSf, rule } },
      },
    });
  } else if ('delete' in result) {
    const { delete: msgDeleted, rule } = result;
    console.log(`Intervening in incident ${incident.id} for group protection.`);
    const messageStatus = (() => {
      if (!message) return 'not found';
      if (msgDeleted) {
        void message.delete();
        return 'deleted';
      }
      void message.reply(
        `I'd like everybody to know this message breaks a rule: ${rule}.`,
      );
      return 'replied to';
    })();
    console[messageStatus === 'not found' ? 'warn' : 'log'](
      `Message ${incident.messageSf} in channel ${incident.channelSf} ${messageStatus}.`,
    );
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
      const reason = `To read my DM; rule: ${rule.slice(0, 10)}...`;
      try {
        await offender.timeout(60_000, reason);
      } catch (err) {
        console.error(`Failed to timeout offender ${offender.user.tag}:`, err);
      }
    }
    const expiresAt = new Date(Date.now() + probationMs);
    await prisma.incident.update({
      where: { id: incident.id },
      data: {
        resolution: `Intervened in protection of the group`,
        groupInterventions: { create: { rule, msgDeleted } },
        probations: { create: { expiresAt } },
      },
    });
  }
}

async function ProcessIncidents(ctx: Ctx) {
  const unprocessed = await prisma.incident.findMany({
    where: {
      at: { gt: new Date(Date.now() - dutyCycleMs) },
      resolution: null,
      groupInterventions: { none: {} },
      victimInterventions: { none: {} },
      probations: { none: {} },
    },
  });
  if (unprocessed.length) {
    console.log(`Found ${unprocessed.length} unprocessed incident(s).`);
    for (const incident of unprocessed) {
      await TriageIncident(ctx, incident);
    }
  } else {
    console.log('No incidents to triage.');
  }
}

async function ProcessProbations(ctx: Ctx) {
  const include = {
    originalIncident: {
      include: { victimInterventions: true, groupInterventions: true },
    },
  };
  const startUninformedProbations = await prisma.probation.findMany({
    where: { startInformed: false },
    include,
  });
  const expiryUninformedProbations = await prisma.probation.findMany({
    where: { expiresAt: { lt: new Date() }, expiryInformed: false },
    include,
  });
  if (!startUninformedProbations.length && !expiryUninformedProbations.length) {
    console.log('No probations to process.');
    return;
  }
  for (const probation of startUninformedProbations) {
    const { originalIncident: incident } = probation;
    const [intervention] = [
      ...incident.victimInterventions,
      ...incident.groupInterventions,
    ];
    if (!intervention) {
      console.warn(
        `No intervention found for probation ${probation.id}, skipping notification.`,
      );
      continue;
    }
    const { rule } = intervention;
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
            title: 'You broke a rule!',
            description: `Your behaviour will now be monitored until <t:${t}>.
You will be timed out if you break the same rule again.`,
            color: 0xffff00,
            fields: [
              { name: 'Broken rule:', value: rule },
              { name: 'You sent:', value: incident.msgContent },
            ],
          },
        ],
      });
      await prisma.probation.update({
        where: { id: probation.id },
        data: { startInformed: true },
      });
      console.log(`Notified offender ${offender.tag} about probation.`);
    } catch (err) {
      console.error(`Failed to notify offender ${offender.tag}:`, err);
    }
  }
}

const DutyCycle = (ctx: Ctx) => async () => {
  clearTimeout(dutyCycleTimer);
  await ProcessIncidents(ctx);
  await ProcessProbations(ctx);
  dutyCycleTimer = setTimeout(DutyCycle(ctx), dutyCycleMs);
};

client.once('ready', () => {
  console.log(`Logged in as ${client.user?.tag}`);
  const { OPENAI_API_KEY } = process.env;
  assert(OPENAI_API_KEY, 'OPENAI_API_KEY must be set in environment variables');
  const ctx: Ctx = { apiKey: OPENAI_API_KEY };
  void DutyCycle(ctx)();

  client.on('messageCreate', async message => {
    if (!message.guildId || message.author.bot) return;
    const incidentCategories = await DetectIncident(OPENAI_API_KEY, message);
    if (!incidentCategories) return;
    await message.react('🚨');
    const context = await message.channel.messages
      .fetch({ limit: 10, before: message.id })
      .then(messages =>
        [...messages.values()].toSorted(
          (a, b) => a.createdTimestamp - b.createdTimestamp,
        ),
      )
      .then(messages =>
        messages.map(m => `${m.author.id}: ${m.content}`).join('\n'),
      );
    const attachments = message.attachments.map(a => a.url).join(' ');
    const msgContent =
      message.content.slice(0, 1000) +
      (message.content.length > 1000 ? '... ' : ' ') +
      attachments;
    const incident = await prisma.incident.create({
      data: {
        guildSf: BigInt(message.guildId),
        channelSf: BigInt(message.channelId),
        messageSf: BigInt(message.id),
        offenderSf: BigInt(message.author.id),
        msgContent,
        context: context + `\n${message.author.id}: ${message.content}`,
        categories: incidentCategories,
      },
    });
    console.log(
      `Message ${message.id}: ${incidentCategories}: ${incident.id}`,
    );
    await DutyCycle(ctx)();
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
