# Warden

A simple Discord bot using AI to provide dead-man server moderation.
The goal is to keep a server clean even in the event of all moderators being absent.

## Approach
- **detection**
  - use the free OpenAI Moderation endpoint to dumbly detect suspicious messages initially - these will be called *incidents*
- **incident**
  - use an advanced AI model to assess the incident in context of the conversation with the server rules in mind, and see if it needs to be escalated to *probation*
    - each message in breach of rules are deleted
- **probation**
  - the member is privately informed that their behaviour is in breach of a specific rule, and there will be *punishment* if they break another rule in the next half hour
  - messages in breach of the rule will be deleted as necessary
- **punishment**:
  - for an hour, all their suspicious messages are automatically deleted without further AI evaluation

## Hosting

Instructions for Node.js, in the terminal:

```bash
pnpm add -g pm2                      # Keeps the bot running even if it crashes
pnpm i                               # Installs exact dependencies
npx prisma migrate dev --name init   # Migrates the database and generates client
pm2 start out/index.js --name Warden # Starts up the bot
```
