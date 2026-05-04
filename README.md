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

## Env vars (Render)

```
ANTHROPIC_API_KEY
NOCODB_URL=https://openclaude-nocodb.onrender.com
NOCODB_TOKEN
PEOPLE_TABLE_ID=mciuo6qr841ald4
COHORTS_TABLE_ID=m85b2wwms3wapa3
TOUCHPOINTS_TABLE_ID=m43ehtpo0gs8wi6
COHORTS_LINK_COLUMN_ID=cipdx8jx152p8fa
SLACK_BOT_TOKEN
AGENT_MODEL=claude-sonnet-4-5  # optional
```
