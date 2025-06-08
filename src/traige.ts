import { Incident } from '@prisma/client';
import OpenAI from 'openai';
import { ChatCompletionCreateParamsNonStreaming } from 'openai/resources';
import z, { ZodType } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';

const rules: [string, ...string[]] = [
  'Respect others: No hate speech, harassment, doxing, or shaming.',
  'Keep it clean: No threatening language, and no adult themes.',
  'No trolling or inciting drama: Keep interactions constructive.',
];

const preamble = `You are a Discord moderator, able to see the latest messages between Discord users in a channel.
There are both minors and adult in the chat.`;

type Settings = ChatCompletionCreateParamsNonStreaming;
type TriageResult =
  | { ignoreReason: string }
  | { victimId: string; rule: string; reason: string }
  | { delete: boolean; rule: string; reason: string };

export const TriageIncident = async (
  apiKey: string,
  incident: Incident,
): Promise<TriageResult> => {
  const openai = new OpenAI({ apiKey });
  const ruleBreak = await (async () => {
    const { offenderSf, categories, context } = incident;
    const schema = z.object({
      brokenRule: z.enum(rules).nullable(),
      reason: z.string(),
      victim: z
        .string()
        .regex(/^[0-9]+$/)
        .describe('the victim ID, if applicable')
        .or(z.literal('everybody')),
      'Should the message be deleted immediately?': z.boolean(),
    });
    const settings: Settings = {
      response_format: zodResponseFormat(schema, 'ruleBreak'),
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `${preamble}
The Discord server has these rules:
${rules.map(rule => `- ${rule}`).join('\n')}.

The very last message to come in has been flagged by an automatic system for these suspected issues:
${categories}

You are to determine if user ${offenderSf} is violating any of these rules.
You are also to determine if the message is directed at a specific user (a victim).`,
        },
        { role: 'user', content: context },
      ],
    };
    const ruleBreakResponse = await ai(openai, schema, settings);

    if (
      ruleBreakResponse.victim !== 'everybody' ||
      !ruleBreakResponse.brokenRule
    ) {
      return ruleBreakResponse;
    }

    const devilSchema = z.object({
      'your thoughts': z.string(),
      'continue with intervention?': z.boolean(),
    });
    const devilSettings: Settings = {
      response_format: zodResponseFormat(devilSchema, 'devilsAdvocate'),
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `${preamble}

Another moderator has flagged a message for breaking this rule:
${ruleBreakResponse.brokenRule}

Play devil's advocate and explain if the last message by ${offenderSf}, in context, is actually alright.
Especially in protection of free-speech, and the right to express oneself.`,
        },
        { role: 'user', content: context },
      ],
    };
    const devilsAdvocateResponse = await ai(openai, devilSchema, devilSettings);
    if (devilsAdvocateResponse['continue with intervention?']) {
      return {
        ...ruleBreakResponse,
        reason:
          ruleBreakResponse.reason +
          "\nDevil's advocate said: " +
          devilsAdvocateResponse['your thoughts'],
      };
    }
    return {
      brokenRule: null,
      reason:
        ruleBreakResponse.reason +
        "\nBut then the devil's advocate concluded: " +
        devilsAdvocateResponse['your thoughts'],
    };
  })();
  if (!ruleBreak.brokenRule) {
    return { ignoreReason: ruleBreak.reason };
  }
  if (ruleBreak.victim !== 'everybody') {
    const [victimId, rule] = [ruleBreak.victim, ruleBreak.brokenRule];
    return { victimId, rule, reason: ruleBreak.reason };
  }
  if (ruleBreak.victim === 'everybody') {
    return {
      delete: ruleBreak['Should the message be deleted immediately?'],
      rule: ruleBreak.brokenRule,
      reason: ruleBreak.reason,
    };
  }
  throw new Error(`Unexpected triage result: ${JSON.stringify(ruleBreak)}`);
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
