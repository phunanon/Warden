import assert from 'assert';
import * as dotenv from 'dotenv';
dotenv.config();
import { Incident, PrismaClient } from '@prisma/client';
import { deleteOldMessages } from '@prisma/client/sql';
import { GatewayIntentBits, IntentsBitField, Partials } from 'discord.js';
import { ButtonStyle, ComponentType, Client } from 'discord.js';
import { DetectIncident } from './spotter';
import * as Triage from './traige';

//TODO: parole

type Ctx = { apiKey: string };

const dutyCycleMs = 15_000;
const probationMs = 60 * 60_000;
const timeoutMs = 60 * 60_000;
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

async function MatchPriorIncident(
  incident: Incident,
  victimSf?: bigint,
): Promise<boolean> {
  const [probation] = await prisma.probation.findMany({
    where: {
      originalIncident: {
        guildSf: incident.guildSf,
        offenderSf: incident.offenderSf,
        ...(victimSf
          ? { victimInterventions: { some: { victimSf } } }
          : { groupInterventions: { some: {} } }),
      },
      expiresAt: { gt: new Date() },
    },
    include: { originalIncident: true },
  });
  if (!probation) return false;

  const prior = probation.originalIncident;
  console.log(
    `Incident ${incident.id} is a repeat of prior incident ${prior.id}.`,
  );
  const until = new Date(Date.now() + timeoutMs);
  await prisma.incident.update({
    where: { id: incident.id },
    data: {
      resolution: 'Repeat incident',
      punishments: {
        create: { probationId: probation.id, until, timeOut: true, ban: false },
      },
    },
  });
  return true;
}

async function TriageIncident({ apiKey }: Ctx, incident: Incident) {
  const result = await Triage.TriageIncident(apiKey, incident);
  const message = await client.channels
    .fetch(`${incident.channelSf}`)
    .then(channel =>
      channel?.isTextBased()
        ? channel.messages.fetch(`${incident.messageSf}`)
        : undefined,
    );
  if ('ignoreReason' in result) {
    console.log(`Ignoring incident ${incident.id}: ${result.ignoreReason}`);
    await prisma.incident.update({
      where: { id: incident.id },
      data: { resolution: result.ignoreReason },
    });
    try {
      await message?.reactions.resolve('🚨')?.remove();
    } catch {}
    return;
  }
  if ('victimId' in result) {
    const { victimId, rule, reason } = result;
    console.log(reason);
    const { guildSf, offenderSf, } = incident;
    const pardons = await prisma.pardon
      .findMany({
        where: { incident: { guildSf, offenderSf } },
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
        data: { resolution: 'Pardon found for victim', pardoned: true },
      });
      try {
        await message?.reactions.resolve('🚨')?.remove();
      } catch {}
      return;
    }

    if (await MatchPriorIncident(incident, victimSf)) return;

    console.log(
      `Intervening in incident ${incident.id} for victim ${victimSf}.`,
    );
    const victim = await (async () => {
      try {
        return await client.users.fetch(`${victimSf}`);
      } catch {}
    })();
    const victimTag = victim ? victim.tag : 'Unknown';
    const victimUrl = victim ? victim.displayAvatarURL() : '';
    const intervention = { victimSf, rule, victimTag, victimUrl };
    await prisma.incident.update({
      where: { id: incident.id },
      data: {
        resolution: `Intervened in protection of <@${victimSf}>`,
        victimInterventions: { create: intervention },
      },
    });
    if (!victim) {
      console.warn(`Victim ${victimSf} not found.`);
      return;
    }
    //Beg pardon
    const components = [
      {
        ...{ customId: `pardon-${offenderSf}`, label: 'I forgive them' },
        ...{ type: ComponentType.Button, style: ButtonStyle.Primary },
      },
      {
        ...{ customId: `prosecute-${offenderSf}`, label: 'I dislike it' },
        ...{ type: ComponentType.Button, style: ButtonStyle.Danger },
      },
    ];
    await message?.reply({
      allowedMentions: { parse: [] },
      embeds: [
        {
          author: { name: `${victimTag}'s decision`, icon_url: victimUrl },
          title: 'Is this message okay?',
          color: 0xffff00,
        },
      ],
      components: [{ type: ComponentType.ActionRow, components }],
    });
  } else if ('delete' in result) {
    const { delete: msgDeleted, rule, reason } = result;
    console.log(`Intervening in incident ${incident.id} for group protection.`);
    console.log(reason);

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
      const reason = `To read my DM; rule: ${rule.slice(0, 10)}...`;
      try {
        await offender.timeout(60_000, reason);
      } catch (err) {
        console.error(`Failed to timeout offender ${offender.user.id}:`, err);
      }
    }
    const expiresAt = new Date(Date.now() + probationMs);
    await prisma.incident.update({
      where: { id: incident.id },
      data: {
        resolution: 'Intervened to protect the group',
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

async function ProcessProbations() {
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
    where: { expiresAt: { lt: new Date() }, endInformed: false },
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
      console.warn(`No intervention found for probation ${probation.id}.`);
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
            description: `If you do it again before <t:${t}> you will be timed out.`,
            color: 0xffff00,
            fields: [
              { name: 'You sent', value: `> ${incident.msgContent}` },
              { name: 'Broken rule', value: rule },
            ],
            footer: { text: `Incident #${incident.id}` },
          },
        ],
      });
      await prisma.probation.update({
        where: { id: probation.id },
        data: { startInformed: true },
      });
      console.log(`Notified offender ${offender.id} about probation.`);
    } catch (err) {
      console.error(`Failed to notify offender ${offender.id}:`, err);
    }
  }
  for (const probation of expiryUninformedProbations) {
    const { originalIncident: incident } = probation;
    const [intervention] = [
      ...incident.victimInterventions,
      ...incident.groupInterventions,
    ];
    if (!intervention) {
      console.warn(`No intervention found for probation ${probation.id}.`);
      continue;
    }
    const { rule } = intervention;
    const offender = await client.users.fetch(`${incident.offenderSf}`);
    if (!offender) {
      console.warn(`Offender ${incident.offenderSf} not found.`);
      continue;
    }
    try {
      await offender.send({
        embeds: [
          {
            title: 'Thank you',
            description: 'You are forgiven for the incident earlier.',
            color: 0x00ff00,
            footer: { text: `Incident #${incident.id}` },
          },
        ],
      });
      await prisma.probation.update({
        where: { id: probation.id },
        data: { endInformed: true },
      });
      console.log(`Notified offender ${offender.id} about probation end.`);
    } catch (err) {
      console.error(`Failed to notify offender ${offender.id}:`, err);
    }
  }
}

async function ProcessPunishments() {
  const unexecutedPunishments = await prisma.punishment.findMany({
    where: { executed: false },
    include: { probation: { include: { originalIncident: true } } },
  });
  if (!unexecutedPunishments.length) {
    console.log('No punishments to process.');
    return;
  }
  console.log(
    `Found ${unexecutedPunishments.length} unexecuted punishment(s).`,
  );
  for (const punishment of unexecutedPunishments) {
    const { probation, timeOut, ban, until } = punishment;
    const { originalIncident: incident } = probation;
    const { guildSf, offenderSf, resolution } = incident;
    const guild = await client.guilds.fetch(`${guildSf}`);
    if (!guild) {
      console.warn(`Guild ${guildSf} not found for punishment.`);
      return;
    }
    const offender = await guild.members.fetch(`${offenderSf}`);
    if (!offender) {
      console.warn(`Offender ${offenderSf} not found for punishment.`);
      return;
    }
    try {
      const timeOutStr = timeOut ? 'timed out' : '';
      const banStr = ban ? 'banned' : '';
      await offender.send({
        embeds: [
          {
            title: `You've been ${timeOutStr}${banStr}!`,
            description: `I told you if you if you broke the same rule again this would happen.
You'll be permitted to return at <t:${Math.floor(until.getTime() / 1000)}>.`,
            color: 0xff0000,
            footer: { text: `Incident #${incident.id}` },
          },
        ],
      });
    } catch (err) {
      console.error(`Failed to notify offender ${offender.user.id}:`, err);
    }
    if (timeOut) {
      try {
        await offender.timeout(timeoutMs, 'Punishment timeout');
        console.log(`Timed out offender ${offender.user.id}`);
      } catch (err) {
        console.error(`Failed to timeout offender ${offender.user.id}:`, err);
      }
    }
    if (ban) {
      try {
        await offender.ban({ reason: resolution ?? 'Punishment' });
        console.log(`Banned offender ${offender.user.id}.`);
      } catch (err) {
        console.error(`Failed to ban offender ${offender.user.id}:`, err);
      }
    }
    await prisma.punishment.update({
      where: { id: punishment.id },
      data: { executed: true },
    });
  }
}

const DutyCycle = (ctx: Ctx) => async () => {
  clearTimeout(dutyCycleTimer);
  await ProcessIncidents(ctx);
  await ProcessProbations();
  await ProcessPunishments();
  dutyCycleTimer = setTimeout(DutyCycle(ctx), dutyCycleMs);
};

client.once('ready', () => {
  console.log(`Logged in as ${client.user?.id}`);
  const { OPENAI_API_KEY } = process.env;
  assert(OPENAI_API_KEY, 'OPENAI_API_KEY must be set in environment variables');
  const ctx: Ctx = { apiKey: OPENAI_API_KEY };
  void DutyCycle(ctx)();

  client.on('messageCreate', async message => {
    if (!message.guildId || message.author.bot) return;
    const truncatedContent =
      message.content.slice(0, 1000) +
      (message.content.length > 1000 ? '... ' : ' ');
    const [guildSf, channelSf, messageSf, authorSf] = [
      BigInt(message.guildId),
      BigInt(message.channelId),
      BigInt(message.id),
      BigInt(message.author.id),
    ];
    await prisma.message.create({
      data: {
        ...{ guildSf, channelSf, messageSf, authorSf },
        content: truncatedContent,
      },
    });
    await prisma.$queryRawTyped(deleteOldMessages());
    const incidentCategories = await DetectIncident(OPENAI_API_KEY, message);
    if (!incidentCategories) return;
    await message.react('🚨');
    const context = await prisma.message
      .findMany({ where: { guildSf, channelSf }, orderBy: { at: 'asc' } })
      .then(messages =>
        messages.map(m => `${m.authorSf}: ${m.content}`).join('\n'),
      );
    const attachments = message.attachments.map(a => a.url).join(' ');
    const msgContent = truncatedContent + attachments;
    const incident = await prisma.incident.create({
      data: {
        ...{ guildSf, channelSf, messageSf },
        offenderSf: authorSf,
        msgContent,
        context: context,
        categories: incidentCategories,
      },
    });
    console.log(`Message ${message.id}: ${incidentCategories}: ${incident.id}`);
    await DutyCycle(ctx)();
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton() || !interaction.guildId) return;
    await interaction.deferReply({ flags: 'Ephemeral' });
    const [guildSf, userSf] = [
      BigInt(interaction.guildId),
      BigInt(interaction.user.id),
    ];
    const isPardon = interaction.customId.startsWith('pardon-');
    const isProsecute = interaction.customId.startsWith('prosecute-');
    const offenderSf = BigInt(interaction.customId.split('-')[1]!);
    const [incident] = await prisma.incident.findMany({
      where: { guildSf, offenderSf, victimInterventions: { some: {} } },
      include: { victimInterventions: true },
    });
    if (!incident) {
      await interaction.editReply('Incident not found.');
      return;
    }
    const victimIntervention = incident.victimInterventions.find(
      v => v.victimSf === userSf,
    );
    if (!victimIntervention) {
      await interaction.editReply('You are not the victim of this incident.');
      return;
    }
    if (isPardon) {
      await prisma.pardon.create({
        data: {
          incidentId: incident.id,
          interventionId: victimIntervention.id,
        },
      });
      await interaction.editReply(`You have pardoned <@${offenderSf}>.
For 24h I will ignore incidents against you by them.`);
      await interaction.message.delete();
    }
    if (isProsecute) {
      await prisma.probation.create({
        data: {
          originalIncidentId: incident.id,
          expiresAt: new Date(Date.now() + probationMs),
        },
      });
      await interaction.editReply(`You have prosecuted the offender.
Any incidents against you by them in the next 24 hours will be ignored.`);
      await interaction.message.delete();
    }
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
