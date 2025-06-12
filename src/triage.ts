import { Incident } from '@prisma/client';
import OpenAI from 'openai';
import { ChatCompletionCreateParamsNonStreaming } from 'openai/resources';
import z, { ZodType } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';

const model = 'gpt-4.1-nano';
const preamble = `You are a Discord moderator, able to see the latest messages between Discord users in a channel.
There are both adults and minors in the chat, therefore there should be no sexual language.
We uphold the right to free speech and the right to express yourself, but also the right to not be harassed or bullied.
We allow discussions of sensitive topics, but not in a way that is harmful to others.
We do not allow the use of slurs, hate speech, or any other form of discrimination.
Joking is allowed, but not if others are evidently uncomfortable.`;

type Settings = ChatCompletionCreateParamsNonStreaming;
type TriageResult = { thoughts: string } & (
  | { kind: 'ignore' }
  | { kind: 'punish'; caution?: string }
);

export const TriageIncident = async (
  apiKey: string,
  incident: Incident,
): Promise<TriageResult> => {
  const openai = new OpenAI({ apiKey });
  const { offenderSf, categories } = incident;

  const schema = z.object({
    explanation: z.string(),
    'punish them?': z.boolean(),
    caution: z
      .string()
      .nullable()
      .describe(
        'Compose a private message to send to the offender in the case of punishment.',
      ),
  });

  //Repeats the last message so simpler models are less confused
  const context = `${incident.context}

Latest message by ${offenderSf}:
${incident.msgContent}`;

  const settings: Settings = {
    response_format: zodResponseFormat(schema, 'response'),
    model,
    messages: [
      {
        role: 'system',
        content: `${preamble}
          
An automatic system has found the latest message by ${offenderSf} to be suspicious.
Play devil's advocate and, in a few sentences or fewer, explain if the latest message by ${offenderSf}, in context, is actually alright.`,
      },
      { role: 'user', content: context },
    ],
  };
  const response = await ai(openai, schema, settings);
  if (response['punish them?']) {
    return {
      kind: 'punish',
      thoughts: response.explanation,
      caution: response.caution ?? undefined,
    };
  }
  return { kind: 'ignore', thoughts: response.explanation };
};

const ai = async <T>(
  openai: OpenAI,
  schema: ZodType<T>,
  settings: Settings,
) => {
  const response = await openai.chat.completions.create(settings);
  const [victimChoice] = response.choices;
  if (!victimChoice || !victimChoice.message) {
    throw new Error('No victim response from OpenAI');
  }
  if (victimChoice.message.refusal) {
    throw new Error(
      `OpenAI refused to answer: ${victimChoice.message.refusal}`,
    );
  }
  return schema.parse(JSON.parse(victimChoice.message.content || '{}'));
};
