import { Incident } from './generated/client';
import { client, prisma } from '.';

const flushMs = 10_000;

type LogAggregate = {
  incident: Incident;
  text: string;
  flushTimer: NodeJS.Timeout;
};
const aggregates: LogAggregate[] = [];

export const IncidentLog = (i: Incident, txt: string, quote = '') => {
  const quoteLines = quote
    .trim()
    .split('\n')
    .map(x => `> ${x}`)
    .join('\n');
  const text = txt + (quote ? `\n${quoteLines}` : '');
  const existing = aggregates.find(a => a.incident.id === i.id);
  if (existing) {
    clearTimeout(existing.flushTimer);
    existing.flushTimer = setTimeout(Flush(i.id), flushMs);
    existing.text += `\n${text}`;
    return;
  }

  aggregates.push({
    incident: i,
    text,
    flushTimer: setTimeout(Flush(i.id), flushMs),
  });
};

const Flush = (incidentId: number) => async () => {
  const index = aggregates.findIndex(a => a.incident.id === incidentId);
  if (index === -1) return;

  const aggregate = aggregates[index];
  aggregates.splice(index, 1);
  if (!aggregate) return;

  const config = await prisma.guild.findUnique({
    where: { sf: aggregate.incident.guildSf },
  });
  if (!config?.auditChannelSf) return;

  const guild = await client.guilds.fetch(`${config.sf}`);
  if (!guild) return;
  const channel = await guild.channels.fetch(`${config.auditChannelSf}`);
  if (!channel?.isTextBased()) return;

  const withSfs = aggregate.text.replace(
    /(?<=^|\s|\()(\d{9,})\b/g,
    match => `<@${match}>`,
  );
  const chunks = withSfs.match(/[\s\S]{1,1500}/g) || [];
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;
    await channel.send({
      content: `__Incident #${aggregate.incident.id}__${
        c > 0 ? ` (${c + 1}/${chunks.length})` : ''
      }
${chunk}`,
      allowedMentions: { parse: [] },
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
};
