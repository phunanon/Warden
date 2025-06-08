# Warden

A Discord bot using AI to provide precise, fair, configurable server moderation.  
The goal is to replace human moderators almost entirely.

## Approach
- use the free OpenAI Moderation endpoint to dumbly detect problematic messages initially - these will be called *incidents*
- then use an advanced AI model to assess the incident in context of the conversation with the server rules in mind, and see if it needs to be escalated to *intervention*
  - prior one-on-one pardons will be taken into account
  - if they're already under probation for that particular rule then the incident is thrown out as the probation process will handle that
  - this will either be on the grounds of "offence against a member" or "offence against the group"
- **intervention: offence against a member** (*victim*)
  - a gentle reminder of the rules is sent in the chat, along with two buttons for the victim to press: "I forgive them", providing pardon for a day; or "I don't forgive them"
  - if "I don't forgive them" is pressed, the offender is put under *probation*
- **intervention: offence against the group**
  - initially decide if the message needs to be immediately deleted (e.g. obscene content) or whether a gentle reminder of the rule in the chat (e.g. be nice about people) would be more helpful
  - the offender is put under *probation*
- **probation**
  - the member would be privately informed that their behaviour is in breach of a specific rule, and they will be monitored for the next X minutes for that rule
  - if they're found to breach the rule again, a summary will be written and sent to them as to why they will be punished
  - if their probation ends without incident, they are informed
  - messages in breach of the rule will be deleted as necessary
- **punishment**:
  - a timeout configured per rule
  - (ideally, if there is a low rate of false-positives then bans can be issued)
- **parole**:
  - once their timeout expires, they are under probation (but called parole) again

## Hosting

Instructions for Node.js, in the terminal:

```bash
pnpm add -g pm2                      # Keeps the bot running even if it crashes
pnpm i                               # Installs exact dependencies
npx prisma migrate dev --name init   # Migrates the database and generates client
pm2 start out/index.js --name Warden # Starts up the bot
```
