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
  | { victimId: string; rule: string }
  | { delete: boolean; rule: string };

export const TriageIncident = async (
  apiKey: string,
  incident: Incident,
): Promise<TriageResult> => {
  const openai = new OpenAI({ apiKey });
  const ruleBreak = await (async () => {
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
${incident.categories}

You are to determine if the user who sent the last message is violating any of these rules.
You are also to determine if the message is directed at a specific user (a victim).`,
        },
        { role: 'user', content: incident.context },
      ],
    };
    const ruleBreakResponse = await ai(openai, schema, settings);
    if (ruleBreakResponse.brokenRule) {
      const schema = z.object({
        'your thoughts': z.string(),
        'continue with intervention?': z.boolean(),
      });
      const settings: Settings = {
        response_format: zodResponseFormat(schema, 'devilsAdvocate'),
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `${preamble}

Another moderator has flagged a message for breaking this rule:
${ruleBreakResponse.brokenRule}

Play devil's advocate and explain if the message, in context, is actually alright.`,
          },
          { role: 'user', content: incident.context },
        ],
      };
      const devilsAdvocateResponse = await ai(openai, schema, settings);
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
    }
    return ruleBreakResponse;
  })();
  if (!ruleBreak.brokenRule) {
    return { ignoreReason: ruleBreak.reason };
  }
  if (ruleBreak.victim !== 'everybody') {
    return { victimId: ruleBreak.victim, rule: ruleBreak.brokenRule };
  }
  if (ruleBreak.victim === 'everybody') {
    return {
      delete: ruleBreak['Should the message be deleted immediately?'],
      rule: ruleBreak.brokenRule,
    };
  }
  throw new Error(`Unexpected triage result: ${JSON.stringify(ruleBreak)}`);
};

const ai = async <T>(
  openai: OpenAI,
  format: ZodType<T>,
  schema: ChatCompletionCreateParamsNonStreaming,
) => {
  const response = await openai.chat.completions.create(schema);
  const [victimChoice] = response.choices;
  if (!victimChoice || !victimChoice.message) {
    throw new Error('No victim response from OpenAI');
  }
  if (victimChoice.message.refusal) {
    throw new Error(
      `OpenAI refused to answer: ${victimChoice.message.refusal}`,
    );
  }
  return format.parse(JSON.parse(victimChoice.message.content || '{}'));
};
