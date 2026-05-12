"""
Replaces the current Slack-Interactions stub workflow (which just logs + acks
200) with a forwarder that:
  1. Acks Slack with 200 immediately (responseMode=onReceived → no wait).
  2. Parses the form-encoded `payload` field into JSON.
  3. POSTs { payload } to Compass /slack-interaction with the shared-secret auth.

Slack's interaction deadline is 3 sec — onReceived ack gets us under that
regardless of how long Compass takes to actually run the approved tool.

Usage:
  N8N_BASE_URL=... N8N_API_KEY=... RUN_SHARED_SECRET=... \
      python3 /tmp/build-interactions-forwarder.py

The script writes /tmp/interactions-forwarder-payload.json (the workflow JSON
ready to PUT to n8n) and prints the workflow id of the existing
Slack-Interactions Receiver workflow so the operator can apply the update via:
  curl -XPATCH "$N8N_BASE_URL/api/v1/workflows/<id>" \
       -H "X-N8N-API-KEY: $N8N_API_KEY" -H "content-type: application/json" \
       -d @/tmp/interactions-forwarder-payload.json
"""
import json
import os

# Compass /slack-interaction lives at the same Render service as /run.
# Adjust if the service URL ever moves.
COMPASS_URL = os.environ.get("COMPASS_URL", "https://openclaude-agent.onrender.com")

workflow = {
    "name": "Slack Interactions Receiver",
    "nodes": [
        {
            "id": "webhook",
            "name": "Webhook",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [240, 400],
            "parameters": {
                "httpMethod": "POST",
                "path": "slack-interactions",
                # onReceived returns 200 the moment the request hits — Slack
                # never has to wait for the rest of the workflow. Critical
                # because Compass /slack-interaction can take a couple of
                # seconds to run the approved tool.
                "responseMode": "onReceived",
                "responseCode": 200,
                "responseData": "noData",
                "options": {},
            },
            "webhookId": "slack-interactions",
        },
        {
            "id": "parse",
            "name": "Parse payload",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [460, 400],
            "parameters": {
                "mode": "runOnceForAllItems",
                "jsCode": (
                    "// Slack interactions arrive as application/x-www-form-urlencoded\n"
                    "// with a single field `payload` containing the JSON string.\n"
                    "// Parse it so the downstream HTTP node can forward structured JSON.\n"
                    "const body = $input.first().json.body || {};\n"
                    "let payload = null;\n"
                    "try { payload = body.payload ? JSON.parse(body.payload) : body; }\n"
                    "catch (e) {\n"
                    "  console.error('[slack-interactions] payload parse failed:', e.message);\n"
                    "  return [];\n"
                    "}\n"
                    "// Compact log so we can see what came in without dumping the whole blob.\n"
                    "console.log('[slack-interactions] forwarding:', JSON.stringify({\n"
                    "  type: payload?.type,\n"
                    "  user: payload?.user?.id,\n"
                    "  channel: payload?.channel?.id,\n"
                    "  action_count: (payload?.actions || []).length,\n"
                    "  action_ids: (payload?.actions || []).map(a => a.action_id || a.name),\n"
                    "}));\n"
                    "return [{ json: { payload } }];"
                ),
            },
        },
        {
            "id": "forward",
            "name": "Forward to Compass",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [680, 400],
            "parameters": {
                "method": "POST",
                "url": f"{COMPASS_URL}/slack-interaction",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        # X-Run-Secret matches the gate /slack-interaction
                        # checks (mirrors the /run convention).
                        {
                            "name": "X-Run-Secret",
                            "value": "={{ $env.RUN_SHARED_SECRET }}",
                        },
                        {
                            "name": "Content-Type",
                            "value": "application/json",
                        },
                    ],
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={{ JSON.stringify({ payload: $json.payload }) }}",
                "options": {
                    # Compass should be quick (< 1s for the ack it returns;
                    # the actual tool runs async after the ack). 5s ceiling
                    # is well within Slack's 3s deadline since we already
                    # acked Slack via responseMode=onReceived.
                    "timeout": 5000,
                },
            },
        },
    ],
    "connections": {
        "Webhook": {
            "main": [[{"node": "Parse payload", "type": "main", "index": 0}]]
        },
        "Parse payload": {
            "main": [[{"node": "Forward to Compass", "type": "main", "index": 0}]]
        },
    },
    "settings": {},
}

out_path = "/tmp/interactions-forwarder-payload.json"
with open(out_path, "w") as f:
    json.dump(workflow, f)
print(f"Wrote {out_path}")
print()
print("To apply (find the workflow id first with `curl -H 'X-N8N-API-KEY: $N8N_API_KEY' ")
print("  $N8N_BASE_URL/api/v1/workflows?tags=`):")
print()
print("  curl -XPUT \"$N8N_BASE_URL/api/v1/workflows/<workflow_id>\" \\")
print("       -H \"X-N8N-API-KEY: $N8N_API_KEY\" \\")
print("       -H 'content-type: application/json' \\")
print(f"       -d @{out_path}")
print()
print("Render env vars needed inside n8n: RUN_SHARED_SECRET (already set for /run).")
print(f"Compass URL: {COMPASS_URL}")
