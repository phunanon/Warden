import assert from 'assert';
import * as dotenv from 'dotenv';
dotenv.config();
import { Incident, PrismaClient } from '@prisma/client';
import { deleteOldMessages } from '@prisma/client/sql';
import { GatewayIntentBits, IntentsBitField, Partials } from 'discord.js';
import { ButtonStyle, ComponentType, Client } from 'discord.js';
import { DetectIncident } from './spotter';
import * as Triage from './triage';
import { IncidentLog } from './audit';

//FIXME: people can offend the bot
//TODO: what about, instead of a timeout, just blindly delete all suspicious messages for the next hour?

type Ctx = { apiKey: string };

const dutyCycleMs = 15_000;
/** Statute of limitations */
const limitationMs = 60_000;
const probationMs = 60 * 60_000;
const pardonMs = 24 * 60 * 60_000;
const muteMs = 60 * 60_000;
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

async function MatchPriorIncident(
  incident: Incident,
  victimSf?: bigint,
): Promise<boolean> {
  const [probation] = await prisma.probation.findMany({
    where: {
      originalIncident: {
        id: { not: incident.id },
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
  IncidentLog(incident, `**Incident is a repeat of #${prior.id}.**`);
  const until = new Date(Date.now() + muteMs);
  await prisma.incident.update({
    where: { id: incident.id },
    data: {
      resolution: 'Repeat incident',
      punishments: {
        create: { probationId: probation.id, until, mute: true, ban: false },
      },
    },
  });
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
  if ('ignoreReason' in result) {
    IncidentLog(incident, '**Incident ignored.**', result.ignoreReason);
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
    IncidentLog(incident, `**Detected victim: <@${victimId}>.**`, reason);
    const { guildSf, offenderSf } = incident;
    const pardonsSince = new Date(Date.now() - pardonMs);
    const pardons = await prisma.pardon
      .findMany({
        where: { incident: { guildSf, offenderSf }, at: { gt: pardonsSince } },
        include: { intervention: { select: { victimSf: true } } },
      })
      .then(p => p.map(p => p.intervention.victimSf));
    if (!/^[0-9]+$/.test(victimId)) {
      IncidentLog(incident, '**AI error.**');
      console.warn(
        `Invalid victim ID format: "${victimId}". Expected a numeric SF.`,
      );
      return;
    }
    const victimSf = BigInt(victimId);
    if (pardons.includes(victimSf)) {
      IncidentLog(
        incident,
        `**Ignoring incident.** Offender <@${offenderSf}> previously pardoned by victim <@${victimSf}>.`,
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

    IncidentLog(incident, `**Intervening for victim <@${victimSf}>.**`);
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
      IncidentLog(incident, `**Victim not reachable: <@${victimSf}>.**`);
      console.warn(`Victim ${victimSf} not found.`);
      return;
    }
    //Beg pardon
    const components = [
      {
        ...{ customId: `pardon-${offenderSf}`, label: 'I forgive them' },
        ...{ type: ComponentType.Button, style: ButtonStyle.Success },
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
    IncidentLog(incident, '**Intervening for group protection.**', reason);

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
      const reason = `To read my DM; rule: ${rule.slice(0, 24)}...`;
      try {
        await offender.timeout(30_000, reason);
      } catch (err) {
        console.error(`Failed to mute offender ${offender.user.id}:`, err);
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
      at: { gt: new Date(Date.now() - limitationMs) },
      resolution: null,
      groupInterventions: { none: {} },
      victimInterventions: { none: {} },
      probations: { none: {} },
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
            description: `If you do it again before <t:${t}> you will be muted.`,
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
      IncidentLog(incident, `**Notified <@${offender.id}> of probation.**`);
    } catch (err) {
      IncidentLog(
        incident,
        `**Failed to notify <@${offender.id}> of probation.**`,
      );
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
            description: 'You are forgiven for the earlier incident.',
            color: 0x00ff00,
            footer: { text: `Incident #${incident.id}` },
          },
        ],
      });
      IncidentLog(
        incident,
        `**Notified offender <@${offender.id}> of probation end.**`,
      );
    } catch (err) {
      IncidentLog(
        incident,
        `**Failed to notify offender <@${offender.id}> of probation end.**`,
      );
      console.error(`Failed to notify offender ${offender.id}:`, err);
    }
    await prisma.probation.update({
      where: { id: probation.id },
      data: { endInformed: true },
    });
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
    const { probation, mute, ban, until } = punishment;
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
      const muteStr = mute ? 'muted' : '';
      const banStr = ban ? 'banned' : '';
      await offender.send({
        embeds: [
          {
            title: `You've been ${muteStr}${banStr}!`,
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
    if (mute) {
      try {
        await offender.timeout(muteMs, 'Punishment');
        IncidentLog(incident, `**Muted offender <@${offender.user.id}>.**`);
      } catch (err) {
        IncidentLog(
          incident,
          `**Failed to mute offender <@${offender.user.id}>.**`,
        );
        console.error(`Failed to mute offender ${offender.user.id}:`, err);
      }
    }
    if (ban) {
      try {
        await offender.ban({ reason: resolution ?? 'Punishment' });
        IncidentLog(incident, `**Banned offender <@${offender.user.id}>.**`);
      } catch (err) {
        IncidentLog(
          incident,
          `**Failed to ban offender <@${offender.user.id}>.**`,
        );
        console.error(`Failed to ban offender ${offender.user.id}:`, err);
      }
    }
    await prisma.punishment.update({
      where: { id: punishment.id },
      data: { executed: true },
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
  await ProcessPunishments();
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
    const content = unsanitised.replace(/\\/g, '\\\\');
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
    await message.react('🚨');
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
    if (!interaction.guildId) return;
    if (interaction.isCommand()) {
      if (interaction.commandName === 'audit-here') {
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
        return;
      }
    }
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
    const victimIntervention = incident.victimInterventions[0];
    if (!victimIntervention) {
      console.warn(`Incident ${incident.id} has no victim intervention.`);
      return;
    }
    const { victimSf } = victimIntervention;
    if (userSf !== victimSf) {
      await interaction.editReply(
        `You are not the victim of this incident - <@${victimSf}> is.`,
      );
      return;
    }
    if (isPardon) {
      await prisma.pardon.create({
        data: {
          incidentId: incident.id,
          interventionId: victimIntervention.id,
        },
      });
      const hours = Math.floor(pardonMs / (60 * 60_000));
      await interaction.editReply(`You have pardoned <@${offenderSf}>.
For ${hours}h I will ignore incidents against you by them.`);
      await interaction.message.delete();
      IncidentLog(
        incident,
        `**Victim <@${userSf}> pardoned offender <@${offenderSf}>.**`,
      );
    }
    if (isProsecute) {
      await prisma.probation.create({
        data: {
          originalIncidentId: incident.id,
          expiresAt: new Date(Date.now() + probationMs),
        },
      });
      await interaction.editReply(
        'Their behaviour will now be closely watched, thank you.',
      );
      await interaction.message.delete();
      IncidentLog(
        incident,
        `**Victim <@${userSf}> prosecuted offender <@${offenderSf}>.**`,
      );
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
