import OpenAI from 'openai';
import { ChatCompletionCreateParamsNonStreaming } from 'openai/resources';
import z, { ZodType } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import { Incident } from './generated/client';

const preamble = `You are a Discord moderator called Warden, able to see the latest messages between Discord users in a channel.
There are both adults and minors in the chat, therefore there should be no sexual language.
We uphold the right to free speech and the right to express yourself, but also the right to not be harassed or bullied.
We allow discussions of sensitive topics, but not in a way that is harmful to others.
We do not allow the use of slurs, hate speech, or any other form of discrimination.
Joking is allowed, but not if others are evidently uncomfortable.
Disparaging comments about Warden is strictly allowed.

Examples of okay messages:
- "im going to marginalize you" - this is a joke, not a threat
- "you freak" - this is a joke, not harassment
- "cheese my beloved i will gladly push through the pain to eat you" - this would have triggered the system, but is actually a joke about cheese
- "I LOVE BREAD SOMEONE KILL ME" - this is a joke
- "I hate him he bites me for no reason [Attachment: IMG_0852.jpg]" - this is probably about a pet
- "just her english sucks so it takes her a while" - this is a joke about language proficiency
- "dating apps are better than asking people on discord for advice. you're already a peg lower than dating apps" - this is fine because you can't offend an app
- "know your place!!" - this is a joke
- "U a homophobic an a hater" - this is an accusation of somebody being homophobic, so it is fine because it is against a potential offender
- "i hate underage" - this is hyperbole about minors
- "i hate children" - same thing, this is hyperbole about minors
- "wouldnt expect anything better from a br*t" - this is a joke about a privileged group of people (British), so it is fine
- "Romanians are stereotypes as people who steal wallets" - this is explaining a stereotype, which is allowable
- "I can't get on your bad side you're gonna phlebotomise me in my sleep" - this is a surreal joke about a medical procedure, so it's fine
- "Why do ur nurses act like highschool bullies" - this is a comment on the behaviour of professionals
- "bee stings, bee dies, Kamikaze attack" - this is a joke about bees, so it's fine
- "Bro wtf some idiot just flashed his wee wee to me on chat, how do i report him?" - this is somebody asking how to report a potential offender, so it is fine

Examples of not okay messages:
- "ur only message on this server is a shitty pic of urself and u calling me a bot wth" - this is harassment
- "petite white boy gets tag teamed by redhead ukranian and Kon" - this is not only sexual but racial
- "Fuck the brits" - this is about a privileged group of people (British) but is too strongly worded`;

type Settings = ChatCompletionCreateParamsNonStreaming;
type TriageResult = { thoughts: string } & (
  | { kind: 'ignore' }
  | { kind: 'punish'; caution?: string; notification?: string }
);

export const TriageIncident = async (
  apiKey: string,
  incident: Incident,
): Promise<TriageResult> => {
  const openai = new OpenAI({ apiKey });
  const { offenderSf, categories } = incident;

  //Repeats the last message so simpler models are less confused
  const context = `${incident.context}

Latest message by ${offenderSf}:
${incident.msgContent}`;

  {
    const schema = z.object({
      thoughts: z.string(),
      'false alarm?': z.boolean(),
    });
    const settings: Settings = {
      response_format: zodResponseFormat(schema, 'response'),
      model: 'gpt-5-nano',
      reasoning_effort: 'minimal',
      verbosity: 'low',
      messages: [
        {
          role: 'system',
          content: `You're a Discord moderator and an automatic system has flagged the latest message by ${offenderSf} for these reasons: ${categories}.
If there's actually absolutely nothing wrong with the message (e.g. no sexual language, no sensitive topics), please say it's a false alarm.
Be aware of bad spelling due to text speech.`,
        },
        { role: 'user', content: context },
      ],
    };
    const response = await ai(openai, schema, settings);
    if (response['false alarm?']) {
      return {
        kind: 'ignore',
        thoughts: `False alarm: ${response.thoughts}`,
      };
    }
  }

  const schema = z.object({
    explanation: z.string(),
    'punish them?': z.boolean(),
    caution: z
      .string()
      .nullable()
      .describe('A private message sent to the offender if they are punished. E.g. Your message has been removed because [reasons]'),
    notification: z
      .string()
      .regex(/^\[offender\]/)
      .nullable()
      .describe(
        `If punished the latest message will be deleted, so this is one sentence that will replace it in the chat so members know vaguely what was said and that it was removed.
E.g. I removed [offender]'s message as it expressed hostility toward others.`,
      ),
  });

  const settings: Settings = {
    response_format: zodResponseFormat(schema, 'response'),
    model: 'gpt-5-nano',
    reasoning_effort: 'minimal',
    verbosity: 'low',
    messages: [
      {
        role: 'system',
        content: `${preamble}

A dumb automatic system has flagged the latest message by ${offenderSf} for these reasons: ${categories}

Play devil's advocate and explain if the latest message by ${offenderSf}, in context, is actually alright.`,
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
      notification: response.notification ?? undefined,
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
