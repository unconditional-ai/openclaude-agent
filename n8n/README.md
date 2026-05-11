# n8n workflows for Compass

Compass discovers tools from n8n at startup. The convention is small:

- Workflow name: `compass:<tool_name>` (lowercase, underscore-separated).
- Tagged `compass`.
- Active.
- First node: Webhook (POST), path = `<tool_name>`, Header Auth using credential `compass-webhook-auth`.
- Last node: Respond to Webhook returning JSON.
- Workflow description = what Claude reads to decide when to use the tool.

That's the whole contract. Anything that fits is callable from Compass after a `POST /reload`.

## Files in `workflows/`

Reference JSON for the workflows currently live in n8n. They're checked in so you can diff history and re-import if needed. **They're not the source of truth — the n8n instance is.** Edit there.

- [log_touchpoint.json](workflows/log_touchpoint.json)
- [toggle_stage.json](workflows/toggle_stage.json)

## Credentials (one-time, in n8n GUI)

| Name | Type | Header Name | Header Value |
|---|---|---|---|
| `compass-nocodb` | Header Auth | `xc-token` | NocoDB API token |
| `compass-webhook-auth` | Header Auth | `X-Webhook-Token` | matches the agent's `N8N_AUTH_TOKEN` |
| `compass-agent-auth` | Header Auth | `X-Run-Secret` | matches the agent's `RUN_SHARED_SECRET` — used by the Slack Events Receiver to authenticate `/run` calls |

## Adding a new tool

1. In n8n: **Workflows → New**. Build it. Set Settings → Description (this is what Claude sees). Tag it `compass`. Save. Activate.
2. `POST https://openclaude-agent.onrender.com/reload -H "X-Run-Secret: <secret>"` — Compass picks it up immediately.

That's it.

## Removing a tool

Deactivate or untag the workflow in n8n, then `POST /reload`. Compass forgets it.
