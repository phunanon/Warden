import { Message } from 'discord.js';
import OpenAI from 'openai';

export async function DetectIncident(
  apiKey: string,
  content: string,
  attachments: Message['attachments'],
): Promise<false | string> {
  const openai = new OpenAI({ apiKey });
  const input: OpenAI.Moderations.ModerationMultiModalInput[] = [];
  input.push({ type: 'text' as const, text: content.normalize('NFKD') });

  //TODO: handle more attachments and filter out more attachment types
  const [attachment] = attachments.values();
  if (attachment && !/\.mp4/.test(attachment.name))
    input.push({
      type: 'image_url' as const,
      image_url: { url: attachment.url },
    });

  const { results } = await openai.moderations.create({
    input,
    model: 'omni-moderation-latest',
  });
  const [result] = results;
  if (!result) {
    console.warn('No results returned from OpenAI');
    return false;
  }

  const resultCategories = Object.entries(result.categories)
    .filter(([k, v]) => Boolean(v))
    .map(([k]) => k)
    .filter(k => !k.includes('self-harm'));

  if (!resultCategories.length) return false;
  return resultCategories.join(', ');
}
