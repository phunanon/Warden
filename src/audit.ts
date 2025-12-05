import { Incident } from './generated/client';
import { client, prisma } from '.';

const flushMs = 10_000;

type LogAggregate = {
  incident: Incident;
  text: string;
  flushTimer: NodeJS.Timeout;
  alertForUserSf?: bigint;
};
const aggregates: LogAggregate[] = [];

export const IncidentLog = (
  i: Incident,
  txt: string,
  quote = '',
  alertForUserSf?: bigint,
) => {
  const quoteLines = quote
    .trim()
    .split('\n')
    .map(x => `> ${x}`)
    .join('\n');
  const text = txt + (quote ? `\n${quoteLines}` : '');
  const existing = aggregates.find(a => a.incident.id === i.id);
  if (existing) {
    clearTimeout(existing.flushTimer);
    existing.flushTimer = setTimeout(AttemptFlush(i.id), flushMs);
    existing.text += `\n${text}`;
    existing.alertForUserSf ||= alertForUserSf;
    return;
  }

  aggregates.push({
    incident: i,
    text,
    flushTimer: setTimeout(AttemptFlush(i.id), flushMs),
    alertForUserSf,
  });
};

const AttemptFlush = (incidentId: number) => async () => {
  try {
    await Flush(incidentId);
  } catch (e) {
    console.error('Failed to flush audit log for incident', incidentId, e);
  }
};
const Flush = async (incidentId: number) => {
  const index = aggregates.findIndex(a => a.incident.id === incidentId);
  if (index === -1) return;

  const aggregate = aggregates[index];
  aggregates.splice(index, 1);
  if (!aggregate) return;
  const { incident, text, alertForUserSf } = aggregate;

  const config = await prisma.guild.findUnique({
    where: { sf: incident.guildSf },
  });
  if (!config?.auditChannelSf) return;

  const guild = await client.guilds.fetch(`${config.sf}`);
  if (!guild) return;
  const channel = await guild.channels.fetch(`${config.auditChannelSf}`);
  if (!channel?.isTextBased()) return;

  const withSfs = text.replace(
    /(?<=^|\s|\()(\d{9,})\b/g,
    match => `<@${match}>`,
  );
  const chunks = withSfs.match(/[\s\S]{1,1500}/g) || [];

  let firstChunkMessage = null;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;
    const message = await channel.send({
      content: `__Incident #${incident.id}__${
        c > 0 ? ` (${c + 1}/${chunks.length})` : ''
      }
${chunk}`,
      allowedMentions: { parse: [] },
    });
    firstChunkMessage ||= message;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (alertForUserSf && firstChunkMessage && config.alertChannelSf) {
    const alertChannel = await guild.channels.fetch(`${config.alertChannelSf}`);
    if (alertChannel?.isTextBased()) {
      await alertChannel.send({
        content: `:warning: <@${alertForUserSf}> probation ${firstChunkMessage.url}`,
        allowedMentions: { parse: [] },
      });
    }
  }
};
