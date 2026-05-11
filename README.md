# openclaude-agent

The Claude tool-use agent service for Unconditional Self ops.

Receives `{transcript, slack_context}` from n8n, runs a Claude tool-use loop against UST's NocoDB, posts the result back to Slack.

## Tools available to Claude

- `lookup_person` — search People by email or name
- `lookup_cohort` — find cohort by name
- `create_person` — new participant record + cohort link
- `update_person` — patch fields
- `toggle_stage` — set onboarding stage checkbox
- `add_note` — append to Notes
- `link_person_to_cohort` — add another cohort link
- `log_touchpoint` — audit log entry
- `ask_for_clarification` — terminates loop, asks user

## Endpoints

- `GET /healthz` — health check
- `POST /run` — run agent on `{transcript, slack_context: {channel, thread_ts}}`

## Local development + smoke tests

Run the agent locally:

```bash
cp .env.smoke.example .env.smoke   # fill in NC_TOKEN
npm install
npm start                          # listens on :10000
```

Run smoke tests against local agent:

```bash
./smoke-tests.sh
```

Run against production:

```bash
AGENT_URL=https://openclaude-agent.onrender.com ./smoke-tests.sh
```

The script self-cleans test records (filters by per-run suffix). Safe to run against production.

Recommended workflow before pushing to main:

1. Make changes locally
2. `node --check index.js` (syntax)
3. `./smoke-tests.sh` against local
4. Commit + push only if 15/15 pass

## Env vars (Render)

Required — boot fails loudly if any are missing:

```
ANTHROPIC_API_KEY
NOCODB_URL=https://openclaude-nocodb.onrender.com
NOCODB_TOKEN
PEOPLE_TABLE_ID=mciuo6qr841ald4
COHORTS_TABLE_ID=m85b2wwms3wapa3
TOUCHPOINTS_TABLE_ID=m43ehtpo0gs8wi6
COHORTS_LINK_COLUMN_ID=cipdx8jx152p8fa
TOUCHPOINTS_PERSON_LINK_COLUMN_ID
SLACK_BOT_TOKEN
RUN_SHARED_SECRET            # shared secret n8n sends as X-Run-Secret on POST /run
```

Optional:

```
AGENT_MODEL=claude-sonnet-4-5
ALLOW_TOOL_PROPOSALS         # set to "1" to enable propose_new_tool (off by default — RCE surface)
N8N_BASE_URL                 # e.g. https://your-n8n.example.com/webhook
N8N_API_KEY                  # from n8n → Settings → n8n API → Create API Key. Used to discover tools.
N8N_AUTH_TOKEN               # the value sent as X-Webhook-Token on every n8n call (matches the compass-webhook-auth credential in n8n)
```

## Auth

`POST /run` and `POST /reload` require a shared secret via either:

- `X-Run-Secret: <secret>` header (preferred), or
- `Authorization: Bearer <secret>`

Missing/wrong secret → 401. Same value on `RUN_SHARED_SECRET` env var here and on the n8n credential `compass-agent-auth`.

## Tools live in n8n

Compass discovers its writable tools from n8n at startup. Convention:

1. Workflow name: `compass:<tool_name>` (e.g. `compass:log_touchpoint`).
2. Tagged `compass` in n8n.
3. Active.
4. First node: Webhook with `path` = `<tool_name>`, Header Auth using the `compass-webhook-auth` credential.
5. Last node: Respond to Webhook returning JSON.
6. Workflow description (Settings → Description in the GUI) doubles as the tool description Claude reads — write it like a tool description (when to use, when not to use, expected input).

Adding a tool: create the workflow in n8n, tag it `compass`, activate it. Then `POST /reload` on the agent (with `X-Run-Secret`) — Compass picks it up immediately. No code change, no redeploy.

Input schema sent to Claude is permissive (`{type: "object"}`). The workflow's description guides Claude on the right input shape.
