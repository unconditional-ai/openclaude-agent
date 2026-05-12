// Compass agent service
// Receives a voice-note transcript + slack_context, runs a Claude tool-use loop
// against UST's NocoDB, and replies in Slack with what was done.

import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ANTHROPIC_API_KEY,
  NOCODB_URL,
  NOCODB_TOKEN,
  PEOPLE_TABLE_ID,
  COHORTS_TABLE_ID,
  TOUCHPOINTS_TABLE_ID,
  COHORTS_LINK_COLUMN_ID,
  TOUCHPOINTS_PERSON_LINK_COLUMN_ID,
  AGENT_ACTIONS_TABLE_ID = "mkifqf7pr88ytsp",
  KNOWLEDGE_TABLE_ID,
  COMPASS_PROMPT_TABLE_ID,

  SLACK_BOT_TOKEN,
  AGENT_MODEL = "claude-sonnet-4-6",
  PORT = 10000,
  RUN_SHARED_SECRET,
  N8N_BASE_URL,
  N8N_API_KEY,
  N8N_AUTH_TOKEN,
} = process.env;

const requiredEnv = {
  ANTHROPIC_API_KEY,
  NOCODB_URL,
  NOCODB_TOKEN,
  PEOPLE_TABLE_ID,
  COHORTS_TABLE_ID,
  TOUCHPOINTS_TABLE_ID,
  COHORTS_LINK_COLUMN_ID,
  TOUCHPOINTS_PERSON_LINK_COLUMN_ID,
  SLACK_BOT_TOKEN,
  RUN_SHARED_SECRET,
};
for (const [k, v] of Object.entries(requiredEnv)) {
  if (!v) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

// code_execution and the Files API both still need beta opt-in headers as of
// May 2026. Set once at the client so every messages.create inherits them.
const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  defaultHeaders: {
    "anthropic-beta": "code-execution-2025-08-25,files-api-2025-04-14",
  },
});

// ---------- NocoDB helpers ----------

const ncHeaders = {
  "xc-token": NOCODB_TOKEN,
  "content-type": "application/json",
};

async function ncGet(path) {
  const res = await fetch(`${NOCODB_URL}${path}`, { headers: ncHeaders });
  if (!res.ok) throw new Error(`NocoDB GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ncPost(path, body) {
  const res = await fetch(`${NOCODB_URL}${path}`, {
    method: "POST",
    headers: ncHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`NocoDB POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ncPatch(path, body) {
  const res = await fetch(`${NOCODB_URL}${path}`, {
    method: "PATCH",
    headers: ncHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`NocoDB PATCH ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ncDelete(path, body) {
  const res = await fetch(`${NOCODB_URL}${path}`, {
    method: "DELETE",
    headers: ncHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`NocoDB DELETE ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const STAGE_ORDER = [
  "onboarding_call_done",
  "deposit_paid",
  "welcome_email_sent",
  "form_submitted",
  "contract_sent",
  "contract_signed",
  "calendar_invites_sent",
  "calendar_invites_accepted",
  "payment_plan_active",
  "paid_in_full",
];

const STAGE_COLUMN_MAP = {
  onboarding_call_done: "1. Onboarding call done",
  deposit_paid: "2. Deposit paid",
  welcome_email_sent: "3. Welcome email sent",
  form_submitted: "4. Form submitted",
  contract_sent: "5. Contract sent",
  contract_signed: "6. Contract signed",
  calendar_invites_sent: "7. Calendar invites sent",
  calendar_invites_accepted: "8. Calendar invites accepted",
  payment_plan_active: "9. Payment plan active",
  paid_in_full: "10. Paid in full",
};

// Stage dependencies — only TRUE logical implications.
// UST onboarding is non-linear; most stages are independent. Only encode REAL prereqs.
const STAGE_PREREQUISITES = {
  welcome_email_sent: ["deposit_paid"],            // welcome email is sent on the call after deposit
  form_submitted: ["welcome_email_sent"],          // form link is inside the welcome email
  contract_signed: ["contract_sent"],              // can't sign what wasn't sent
  calendar_invites_accepted: ["calendar_invites_sent"], // can't accept invites that weren't sent
  paid_in_full: ["deposit_paid"],                  // deposit precedes full payment
};

// Inverse map: if stage X is false, these stages must also be false (they depend on X).
// Computed from STAGE_PREREQUISITES.
const STAGE_DEPENDENTS = {};
for (const [stage, prereqs] of Object.entries(STAGE_PREREQUISITES)) {
  for (const prereq of prereqs) {
    if (!STAGE_DEPENDENTS[prereq]) STAGE_DEPENDENTS[prereq] = [];
    STAGE_DEPENDENTS[prereq].push(stage);
  }
}

const VALID_SOURCES = ["Direct", "Referral", "Workshop", "Website", "Social", "Other"];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Redact PII before writing transcripts to logs. Render's logs are searchable
// and may be retained for weeks; we don't want emails, phone numbers, or full
// auth tokens floating around in there. The redaction is deliberately coarse —
// the goal is "scrubbed enough for ops debugging," not forensic privacy.
function redactPII(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone]")
    .replace(/\b(?:[A-Za-z0-9_-]{20,})\b/g, (m) => (m.length >= 32 ? "[token]" : m));
}

// ---------- ClickUp list discovery (lazy, cached) ----------
// Replaces hardcoded list IDs. At first use, walks ClickUp hierarchy and caches a flat
// list of {id, name, space, folder, path} records keyed by name. Cache TTL 1 hour.
// On TTL expiry or first cache miss for a name, the cache is rebuilt.

const CLICKUP_LIST_CACHE_TTL_MS = 60 * 60 * 1000;
let _clickupListCache = null;

async function clickupGet(url, token) {
  const res = await fetch(url, { headers: { authorization: token } });
  if (!res.ok) throw new Error(`ClickUp ${url}: HTTP ${res.status}`);
  return res.json();
}

async function discoverClickUpLists() {
  const token = process.env.CLICKUP_TOKEN;
  if (!token) throw new Error("CLICKUP_TOKEN not set");
  const teams = (await clickupGet("https://api.clickup.com/api/v2/team", token)).teams || [];
  const out = [];
  for (const team of teams) {
    const spaces = (await clickupGet(`https://api.clickup.com/api/v2/team/${team.id}/space?archived=false`, token)).spaces || [];
    for (const space of spaces) {
      const folderless = (await clickupGet(`https://api.clickup.com/api/v2/space/${space.id}/list?archived=false`, token)).lists || [];
      for (const l of folderless) {
        out.push({ id: l.id, name: l.name, space: space.name, folder: null, path: `${space.name} / ${l.name}` });
      }
      const folders = (await clickupGet(`https://api.clickup.com/api/v2/space/${space.id}/folder?archived=false`, token)).folders || [];
      for (const folder of folders) {
        for (const l of (folder.lists || [])) {
          out.push({ id: l.id, name: l.name, space: space.name, folder: folder.name, path: `${space.name} / ${folder.name} / ${l.name}` });
        }
      }
    }
  }
  return out;
}

async function getClickUpLists() {
  const now = Date.now();
  if (_clickupListCache && _clickupListCache.expires_at > now) return _clickupListCache.lists;
  const lists = await discoverClickUpLists();
  _clickupListCache = { lists, expires_at: now + CLICKUP_LIST_CACHE_TTL_MS };
  console.log(`[clickup] discovered ${lists.length} lists, cached for ${CLICKUP_LIST_CACHE_TTL_MS / 60000}min`);
  return lists;
}

function matchClickUpLists(lists, query) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const exact = lists.filter((l) => l.name.toLowerCase() === q);
  if (exact.length) return exact;
  const tokens = q.split(/\s+/).filter(Boolean);
  return lists.filter((l) => {
    const hay = `${l.name} ${l.path}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

// ---------- ClickUp user discovery (lazy, cached) ----------
// Used by create_clickup_task to resolve friendly names ("nathan", "yohan", "valerie")
// to ClickUp user IDs for the assignees parameter. Same TTL/refresh semantics as the
// list cache.

let _clickupUserCache = null;

async function getClickUpUsers() {
  const now = Date.now();
  if (_clickupUserCache && _clickupUserCache.expires_at > now) return _clickupUserCache.users;
  const token = process.env.CLICKUP_TOKEN;
  if (!token) throw new Error("CLICKUP_TOKEN not set");
  const teams = (await clickupGet("https://api.clickup.com/api/v2/team", token)).teams || [];
  const users = [];
  for (const team of teams) {
    for (const m of (team.members || [])) {
      const u = m.user;
      if (!u) continue;
      users.push({ id: String(u.id), username: u.username || "", email: u.email || "" });
    }
  }
  _clickupUserCache = { users, expires_at: now + CLICKUP_LIST_CACHE_TTL_MS };
  console.log(`[clickup] cached ${users.length} workspace members`);
  return users;
}

function resolveClickUpAssignee(users, name) {
  const q = String(name).toLowerCase().trim();
  // Try email exact match first (most reliable)
  let hit = users.find((u) => u.email.toLowerCase() === q);
  if (hit) return hit.id;
  // Then username contains
  hit = users.find((u) => u.username.toLowerCase() === q);
  if (hit) return hit.id;
  // Then fuzzy: any token of the username matches q
  hit = users.find((u) => u.username.toLowerCase().split(/\s+/).some((tok) => tok === q));
  if (hit) return hit.id;
  // Then partial substring
  hit = users.find((u) => u.username.toLowerCase().includes(q));
  if (hit) return hit.id;
  return null;
}

// ---------- Confirmation gating ----------
// High-stakes tools (calendar writes, payment changes, deletes) gate themselves
// behind a `confirmed: true` arg. First call returns a preview describing what
// WILL happen; the agent shows it to the user, waits for an explicit go-ahead,
// then re-calls the same tool with confirmed=true plus the originally proposed
// args. This is enforced per-tool (not loop-level) because each tool knows the
// shape of its own preview. Tradeoff: relies on the agent honoring the
// `to_proceed` instruction rather than holding state in the runtime — simpler,
// no infrastructure, but the agent must remember to flip confirmed on retry.
function pendingConfirmation(action_summary, replay_args) {
  // Strip undefined entries so the agent doesn't replay them as nulls — most of
  // these tools distinguish 'undefined' (don't touch) from 'null' (clear field).
  const cleaned = {};
  for (const [k, v] of Object.entries(replay_args)) {
    if (v !== undefined) cleaned[k] = v;
  }
  return {
    status: "confirmation_required",
    action_summary,
    replay_args: cleaned,
    to_proceed:
      "DO NOT execute yet. Reply to the user describing action_summary and ask them to confirm. " +
      "On their explicit go-ahead (e.g. 'yes', 'go ahead', thumbsup react), call this same tool again " +
      "with the args from replay_args (which already includes confirmed: true).",
  };
}

// ---------- n8n tool discovery ----------
//
// Compass's writable tools live in n8n as workflows tagged `compass`. At boot
// (and on POST /reload), the agent asks n8n's API for that list, then registers
// each workflow as a Claude tool whose impl is "POST to the webhook." Adding a
// tool is a workflow create+activate+tag in n8n; no agent code change needed.
//
// Convention per workflow:
//   • Workflow name: `compass:<tool_name>` (e.g. `compass:log_touchpoint`).
//   • Tagged `compass`.
//   • Active.
//   • First node is a Webhook with path = <tool_name> and Header Auth using
//     the `compass-webhook-auth` credential.
//   • Workflow.description (Settings → Description in the n8n GUI) doubles as
//     the tool description shown to Claude. Write it like a tool description:
//     when to use, when not to use, expected input shape.
//   • Final node is "Respond to Webhook" returning JSON.
//
// Input schema: workflows accept any JSON object. Claude reads the description
// to figure out the right shape; we don't enforce JSON Schema. Less safety,
// more flexibility — matches the "agent intelligence over rigid framework" goal.

async function discoverN8nTools() {
  if (!N8N_BASE_URL || !N8N_API_KEY) {
    console.log("[n8n] N8N_BASE_URL or N8N_API_KEY not set — skipping discovery.");
    return [];
  }
  const apiBase = N8N_BASE_URL.replace(/\/webhook\/?$/, "").replace(/\/$/, "");
  const listUrl = `${apiBase}/api/v1/workflows?tags=compass&active=true`;
  const headers = { "X-N8N-API-KEY": N8N_API_KEY };
  try {
    const listRes = await fetch(listUrl, { headers });
    if (!listRes.ok) {
      console.error(`[n8n] discovery list failed: HTTP ${listRes.status}`);
      return [];
    }
    const listJson = await listRes.json();
    const summaries = listJson.data || [];
    // n8n's list endpoint strips the description field, so fetch each
    // workflow individually to pick it up. Parallel — cheap for ~10 tools.
    const fulls = await Promise.all(
      summaries.map((s) =>
        fetch(`${apiBase}/api/v1/workflows/${s.id}`, { headers })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    );
    const tools = [];
    for (const wf of fulls) {
      if (!wf) continue;
      const webhookNode = (wf.nodes || []).find((n) => n.type === "n8n-nodes-base.webhook");
      const respondNode = (wf.nodes || []).find((n) => n.type === "n8n-nodes-base.respondToWebhook");
      const path = webhookNode?.parameters?.path;
      if (!path) {
        console.error(`[n8n] workflow ${wf.name} has no webhook path — skipping`);
        continue;
      }
      if (!respondNode) {
        console.error(`[n8n] workflow ${wf.name} has no Respond to Webhook node — skipping`);
        continue;
      }
      if (!wf.description) {
        console.error(`[n8n] workflow ${wf.name} has no description — Claude won't know when to use it. Set one in n8n → Settings → Description.`);
      }
      tools.push({
        name: path,
        description: wf.description || wf.name,
        workflow_id: wf.id,
        workflow_name: wf.name,
      });
    }
    return tools;
  } catch (e) {
    console.error(`[n8n] discovery error: ${e.message}`);
    return [];
  }
}

async function callN8nWebhook(toolName, input, slack_context) {
  const base = N8N_BASE_URL.replace(/\/$/, "");
  const url = base.endsWith("/webhook") ? `${base}/${toolName}` : `${base}/webhook/${toolName}`;
  const headers = { "content-type": "application/json" };
  if (N8N_AUTH_TOKEN) headers["X-Webhook-Token"] = N8N_AUTH_TOKEN;
  const body = JSON.stringify({
    tool: toolName,
    input,
    slack_context: slack_context || null,
    request_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      return { error: `n8n ${toolName} → HTTP ${res.status}: ${text.slice(0, 500)}` };
    }
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, text };
    }
  } catch (e) {
    return { error: `n8n ${toolName} call failed: ${e.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

// Discovered n8n tools — keyed by tool name. Populated at startup and refreshed
// on POST /reload. Each entry is { description, workflow_id, workflow_name }.
const n8nTools = new Map();

// Mutable so /reload can rebuild it. Holds the final tool definitions sent to
// Claude (built-in JS tools + discovered n8n tools).
let claudeToolDefs = null;

async function refreshN8nTools() {
  const discovered = await discoverN8nTools();
  // Sweep previously-registered n8n tools out of `tools` and `toolImpls` so
  // /reload reflects deletions/renames in n8n, not just additions.
  for (const name of n8nTools.keys()) {
    const idx = tools.findIndex((t) => t.name === name);
    if (idx !== -1) tools.splice(idx, 1);
    delete toolImpls[name];
  }
  n8nTools.clear();
  for (const t of discovered) {
    // n8n version wins over any same-named built-in or stale entry. Matches
    // the dispatch path (via === "n8n" overrides JS impl). Without this,
    // collisions in `tools` cause Anthropic to reject with "Tool names must
    // be unique." Note: removing a shadowed workflow at /reload doesn't
    // restore the JS built-in — restart the service for that.
    const existingIdx = tools.findIndex((x) => x.name === t.name);
    if (existingIdx !== -1) {
      tools.splice(existingIdx, 1);
      console.log(`[n8n] '${t.name}' shadows existing tool of the same name.`);
    }
    n8nTools.set(t.name, { description: t.description, workflow_id: t.workflow_id, workflow_name: t.workflow_name });
    // Tell Claude about the tool. Schema is intentionally permissive —
    // descriptions guide Claude on shape, not JSON Schema validation.
    tools.push({
      name: t.name,
      description: t.description,
      defer_loading: true,
      input_schema: { type: "object", additionalProperties: true },
    });
    // Dispatch is handled specially in the agent loop (see `via === "n8n"`)
    // so this registration is just to make the dispatcher's "is impl present"
    // check pass. The actual webhook call happens in the loop.
    toolImpls[t.name] = async function () {
      return { error: "n8n tool dispatched through loop's webhook path; this stub should never run." };
    };
  }
  if (discovered.length > 0) {
    console.log(`[n8n] discovered ${discovered.length} tool${discovered.length === 1 ? "" : "s"}: ${discovered.map((t) => t.name).join(", ")}`);
  } else {
    console.log("[n8n] no compass-tagged active workflows found.");
  }
  return discovered;
}

// ---------- Tool implementations ----------

const toolImpls = {
  async lookup_person({ query, type }) {
    // Email lookup is case-insensitive in intent, but NocoDB's `eq` operator
    // is case-sensitive against the stored value. Legacy People rows may have
    // mixed-case emails ("Joseph.Wise@gmail.com") while new rows are
    // normalised lowercase. So: try strict eq first (cheap, indexed), and if
    // it returns 0 fall back to a `like` filter against the normalised
    // address — `like` evaluates case-insensitively in NocoDB's filter layer
    // and catches the legacy rows.
    let where;
    let data;
    if (type === "email") {
      const normalized = String(query || "").trim().toLowerCase();
      where = `(Primary email,eq,${normalized})`;
      data = await ncGet(
        `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(where)}&limit=10`
      );
      if (data.list.length === 0) {
        // Strict-eq missed. Retry case-insensitively. We escape % and _ in the
        // query so an email containing those literally doesn't become a
        // wildcard. Then we double-check the match in code (defensive: if
        // NocoDB ever surprises us with a too-wide match, we filter to exact-
        // string-equality on the lowercased value).
        const escaped = normalized.replace(/[%_]/g, "");
        where = `(Primary email,like,%${escaped}%)`;
        const fallback = await ncGet(
          `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(where)}&limit=10`
        );
        const exact = (fallback.list || []).filter(
          (p) => String(p["Primary email"] || "").trim().toLowerCase() === normalized
        );
        if (exact.length > 0) data = { list: exact };
      }
    } else {
      where = `(Name,like,%${query}%)`;
      data = await ncGet(
        `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(where)}&limit=10`
      );
    }
    return {
      count: data.list.length,
      matches: data.list.map((p) => ({
        id: p.Id,
        name: p.Name,
        primary_email: p["Primary email"],
        primary_phone: p["Primary phone"],
        status: p.Status,
        owner: p.Owner,
        room: p.Room,
        cohort_count: p.Cohorts || 0,
        notes: p.Notes,
        next_action: p["Next action"],
        payment: {
          status: p["Payment status"],
          risk: p["Payment risk"],
          amount_total: p["Amount total"],
          amount_paid: p["Amount paid"],
          amount_owing: p["Amount owing"],
        },
        stages: Object.fromEntries(
          STAGE_ORDER.map((s) => [s, p[STAGE_COLUMN_MAP[s]] || false])
        ),
      })),
    };
  },

  async lookup_cohort({ name }) {
    const data = await ncGet(
      `/api/v2/tables/${COHORTS_TABLE_ID}/records?where=${encodeURIComponent(
        `(Name,eq,${name})`
      )}&limit=1`
    );
    if (data.list.length === 0) return { found: false };
    const c = data.list[0];
    return {
      found: true,
      id: c.Id,
      name: c.Name,
      start_date: c["Start date"],
      status: c.Status,
    };
  },

  async create_person({
    name,
    primary_email = null,
    primary_phone = null,
    cohort_name = null,
    source = "Other",
    notes = "",
    room = null,
    payment_status = null,
    payment_risk = null,
    amount_total = null,
    amount_paid = null,
    next_action = null,
  }) {
    // Idempotency by code (not by prompt discipline). The May 2026 credit-
    // exhaustion incident left ambiguous state because resume runs trusted the
    // prompt to "lookup before write". Now create_person ALWAYS does the email
    // lookup itself. Resume after partial failure = re-run, dupes are skipped.
    if (primary_email) {
      const normalizedEmail = String(primary_email).trim().toLowerCase();
      const existing = await this.lookup_person({ query: normalizedEmail, type: "email" });
      if (existing.count > 0) {
        const match = existing.matches[0];
        // Best-effort: link to cohort if requested and not already linked.
        let cohortLinked = null;
        if (cohort_name) {
          const cohort = await this.lookup_cohort({ name: cohort_name });
          if (cohort.found) {
            try {
              await ncPost(
                `/api/v2/tables/${PEOPLE_TABLE_ID}/links/${COHORTS_LINK_COLUMN_ID}/records/${match.id}`,
                [{ Id: cohort.id }]
              );
              cohortLinked = cohort.name;
            } catch (e) {
              // Link may already exist; not worth blowing up the import for.
              console.log(`[create_person] cohort link skipped for existing ${match.id}: ${e.message}`);
            }
          }
        }
        return {
          id: match.id,
          name: match.name,
          primary_email: match.primary_email,
          cohort_linked: cohortLinked,
          already_existed: true,
          note: "Person already in system — no duplicate created. Use update_person to modify their fields, or add_note to append to Notes.",
        };
      }
    }

    let normalizedSource = "Other";
    if (source && typeof source === "string") {
      const cap = source.charAt(0).toUpperCase() + source.slice(1).toLowerCase();
      if (VALID_SOURCES.includes(cap)) normalizedSource = cap;
    }

    const record = {
      Name: name,
      "Primary email": primary_email ? String(primary_email).trim().toLowerCase() : null,
      "Primary phone": primary_phone,
      Status: "Onboarding",
      Owner: "Valerie",
      Source: normalizedSource,
      Notes: notes,
      "Last touch": todayISO(),
    };
    if (room) record["Room"] = room;
    if (payment_status) record["Payment status"] = payment_status;
    if (payment_risk) record["Payment risk"] = payment_risk;
    if (amount_total != null) record["Amount total"] = amount_total;
    if (amount_paid != null) {
      record["Amount paid"] = amount_paid;
      if (amount_total != null) record["Amount owing"] = amount_total - amount_paid;
    }
    if (next_action) record["Next action"] = next_action;

    const created = await ncPost(`/api/v2/tables/${PEOPLE_TABLE_ID}/records`, [record]);
    const personId = Array.isArray(created) ? created[0].Id : created.Id;

    let cohortLinked = null;
    if (cohort_name) {
      const cohort = await this.lookup_cohort({ name: cohort_name });
      if (cohort.found) {
        await ncPost(
          `/api/v2/tables/${PEOPLE_TABLE_ID}/links/${COHORTS_LINK_COLUMN_ID}/records/${personId}`,
          [{ Id: cohort.id }]
        );
        cohortLinked = cohort.name;
      }
    }

    return {
      id: personId,
      name,
      primary_email,
      cohort_linked: cohortLinked,
      created: true,
    };
  },

  // Bulk version of create_person. Takes one array, loops server-side, returns
  // aggregate results. Use this for any import of more than ~3 people — it
  // saves significant output tokens vs N individual create_person tool calls
  // (each create_person arg block is ~50-100 tokens; bulking dedupes shared
  // fields like cohort_name and owner). Idempotency from create_person carries
  // through: existing emails return already_existed=true and don't double-write.
  //
  // Per-person field shape: same as create_person args, minus duplication of
  // shared fields (cohort_name, owner, source) which can be set at top level
  // and overridden per row.
  async bulk_import_people({
    people,
    default_cohort_name = null,
    default_source = "Other",
    default_owner = null,
    default_status = null,
    default_room = null,
    confirmed = false,
  }) {
    if (!Array.isArray(people) || people.length === 0) {
      return { error: "people[] is required (non-empty array of {name, primary_email, ...} objects)" };
    }
    if (people.length > 100) {
      return { error: `bulk_import_people accepts up to 100 people per call (got ${people.length}). Split into smaller batches.` };
    }
    if (!confirmed) {
      const preview = people.slice(0, 5).map((p) => `${p.name || "(unnamed)"} <${p.primary_email || "no email"}>`).join(", ");
      const more = people.length > 5 ? ` … and ${people.length - 5} more` : "";
      return pendingConfirmation(
        `Bulk import ${people.length} people into cohort "${default_cohort_name || "(none specified)"}". Preview: ${preview}${more}.`,
        {
          people,
          default_cohort_name,
          default_source,
          default_owner,
          default_status,
          default_room,
          confirmed: true,
        }
      );
    }
    const results = [];
    for (const p of people) {
      try {
        const res = await this.create_person({
          name: p.name,
          primary_email: p.primary_email || null,
          primary_phone: p.primary_phone || null,
          cohort_name: p.cohort_name || default_cohort_name,
          source: p.source || default_source,
          notes: p.notes || "",
          room: p.room || default_room,
          payment_status: p.payment_status || default_status,
          payment_risk: p.payment_risk,
          amount_total: p.amount_total,
          amount_paid: p.amount_paid,
          next_action: p.next_action,
        });
        results.push({
          name: p.name,
          email: p.primary_email,
          person_id: res.id,
          status: res.already_existed ? "already_existed" : (res.created ? "created" : "unknown"),
          cohort_linked: res.cohort_linked || null,
        });
      } catch (e) {
        results.push({ name: p.name, email: p.primary_email, status: "error", error: e.message });
      }
    }
    const created = results.filter((r) => r.status === "created").length;
    const existed = results.filter((r) => r.status === "already_existed").length;
    const errors = results.filter((r) => r.status === "error").length;
    return {
      total: people.length,
      created,
      already_existed: existed,
      errors,
      results,
      summary: `Bulk import done: ${created} created, ${existed} already existed, ${errors} errors.`,
    };
  },

  async update_payment({ person_id, payment_status, amount_total, amount_paid, payment_risk, confirmed = false }) {
    if (!confirmed) {
      const proposed = [];
      if (payment_status !== undefined) proposed.push(`Payment status → ${payment_status}`);
      if (amount_total !== undefined) proposed.push(`Amount total → ${amount_total}`);
      if (amount_paid !== undefined) proposed.push(`Amount paid → ${amount_paid}`);
      if (payment_risk !== undefined) proposed.push(`Payment risk → ${payment_risk}`);
      return pendingConfirmation(
        `Update payment for person_id=${person_id}: ${proposed.join("; ") || "(no fields)"}`,
        { person_id, payment_status, amount_total, amount_paid, payment_risk, confirmed: true }
      );
    }
    const updates = { Id: person_id, "Last touch": todayISO() };
    if (payment_status !== undefined) updates["Payment status"] = payment_status;
    if (amount_total !== undefined) updates["Amount total"] = amount_total;
    if (amount_paid !== undefined) updates["Amount paid"] = amount_paid;
    if (payment_risk !== undefined) updates["Payment risk"] = payment_risk;
    // If both totals are present (either via this update or previously known), recompute owing
    if (amount_total !== undefined && amount_paid !== undefined) {
      updates["Amount owing"] = amount_total - amount_paid;
    } else if (amount_paid !== undefined || amount_total !== undefined) {
      // Need to fetch current values to compute owing accurately
      const data = await ncGet(
        `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(`(Id,eq,${person_id})`)}&limit=1`
      );
      if (!data.list[0]) return { error: `Person ${person_id} not found` };
      const tot = amount_total !== undefined ? amount_total : data.list[0]["Amount total"];
      const paid = amount_paid !== undefined ? amount_paid : data.list[0]["Amount paid"];
      if (tot != null && paid != null) updates["Amount owing"] = tot - paid;
    }
    await ncPatch(`/api/v2/tables/${PEOPLE_TABLE_ID}/records`, [updates]);
    return { id: person_id, updated_fields: Object.keys(updates).filter((k) => k !== "Id" && k !== "Last touch") };
  },

  async draft_welcome_email({ person_id }) {
    // Look up person to get name + email
    const data = await ncGet(
      `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(`(Id,eq,${person_id})`)}&limit=1`
    );
    if (data.list.length === 0) return { error: `Person ${person_id} not found` };
    const p = data.list[0];
    const recipientName = p.Name || "there";
    const recipientEmail = p["Primary email"];
    if (!recipientEmail) return { error: `Person ${person_id} has no Primary email` };

    let accessToken;
    try {
      accessToken = await getGmailAccessToken();
    } catch (e) {
      return { error: e.message };
    }
    const fromAddress = await getGmailFromAddress(accessToken);
    const html = renderTemplate("welcome_9week", { name: recipientName });
    const subject = `Welcome to the UST 9-Week Training, ${recipientName} 🌱`;

    const raw = buildMimeMessage({
      from: `Yohan Dante <${fromAddress}>`,
      to: `${recipientName} <${recipientEmail}>`,
      subject,
      html,
    });

    const draftRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    });
    const draftData = await draftRes.json();
    if (!draftRes.ok) return { error: `Gmail draft failed: ${JSON.stringify(draftData)}` };

    return {
      person_id,
      draft_id: draftData.id,
      message_id: draftData.message?.id,
      to: recipientEmail,
      subject,
      gmail_url: `https://mail.google.com/mail/u/0/#drafts/${draftData.id}`,
    };
  },

  async draft_email({ to_email, to_name = null, subject, body_html = null, body_text = null }) {
    let accessToken;
    try {
      accessToken = await getGmailAccessToken();
    } catch (e) {
      return { error: e.message };
    }
    const fromAddress = await getGmailFromAddress(accessToken);

    let html = body_html;
    if (!html && body_text) {
      // Wrap plain text in basic HTML so the draft has a sensible HTML body too
      html = `<div style="font-family:system-ui,arial;font-size:15px;line-height:1.5;color:#222;white-space:pre-wrap">${body_text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>`;
    }
    if (!html) return { error: "Provide body_html or body_text" };

    const toHeader = to_name ? `${to_name} <${to_email}>` : to_email;
    const raw = buildMimeMessage({
      from: `<${fromAddress}>`,
      to: toHeader,
      subject,
      html,
    });

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    });
    const data = await res.json();
    if (!res.ok) return { error: `Gmail draft failed: ${JSON.stringify(data)}` };
    return {
      draft_id: data.id,
      to: to_email,
      subject,
      gmail_url: `https://mail.google.com/mail/u/0/#drafts/${data.id}`,
    };
  },

  async list_people({ status = null, cohort_name = null, payment_status = null, has_pending_stage = null, owner = null, limit = 25 }) {
    const filters = [];
    if (status) filters.push(`(Status,eq,${status})`);
    if (cohort_name) filters.push(`(Cohort name,eq,${cohort_name})`);
    if (payment_status) filters.push(`(Payment status,eq,${payment_status})`);
    if (owner) filters.push(`(Owner,eq,${owner})`);
    // has_pending_stage=true → at least one of stages 1-8 unchecked (real onboarding work)
    if (has_pending_stage === true) {
      const stageCols = STAGE_ORDER.slice(0, 8).map((s) => STAGE_COLUMN_MAP[s]);
      const stageFilter = stageCols.map((c) => `(${c},notchecked)`).join("~or");
      filters.push(`(${stageFilter})`);
    }
    if (has_pending_stage === false) {
      const stageCols = STAGE_ORDER.slice(0, 8).map((s) => STAGE_COLUMN_MAP[s]);
      stageCols.forEach((c) => filters.push(`(${c},checked)`));
    }
    const where = filters.length ? `&where=${encodeURIComponent(filters.join("~and"))}` : "";
    const url = `/api/v2/tables/${PEOPLE_TABLE_ID}/records?limit=${Math.min(limit, 100)}&sort=Name${where}`;
    const data = await ncGet(url);
    return {
      count: data.list.length,
      total: data.pageInfo?.totalRows ?? data.list.length,
      people: data.list.map((p) => ({
        id: p.Id,
        name: p.Name,
        primary_email: p["Primary email"],
        status: p.Status,
        owner: p.Owner,
        cohort_name: p["Cohort name"],
        payment_status: p["Payment status"],
        amount_owing: p["Amount owing"],
        next_action: p["Next action"],
        completed_stages: STAGE_ORDER.filter((s) => p[STAGE_COLUMN_MAP[s]] === true),
        pending_stages: STAGE_ORDER.slice(0, 8).filter((s) => p[STAGE_COLUMN_MAP[s]] !== true),
      })),
    };
  },

  async list_clickup_tasks({ list_id = null, list_ids = null, cohort = null, search = null, statuses = null, include_closed = false, limit = 25 }) {
    const token = process.env.CLICKUP_TOKEN;
    if (!token) return { error: "CLICKUP_TOKEN not configured" };
    const teamRes = await fetch("https://api.clickup.com/api/v2/team", { headers: { authorization: token } });
    const teams = (await teamRes.json()).teams || [];
    if (teams.length === 0) return { error: "No ClickUp teams accessible" };
    const teamId = teams[0].id;

    // ClickUp's team-task endpoint returns empty without list/space/folder filters.
    // Resolve scope: explicit list_ids > list_id > cohort name (via discovery) > Daily Task Board fallback.
    let scopedListIds = list_ids;
    if (!scopedListIds && list_id) scopedListIds = [list_id];
    if (!scopedListIds && cohort) {
      try {
        const lists = await getClickUpLists();
        const matches = matchClickUpLists(lists, cohort);
        if (matches.length === 0) {
          return { error: `No ClickUp lists matched cohort "${cohort}". Use find_clickup_list to discover available lists.` };
        }
        scopedListIds = matches.map((l) => l.id);
      } catch (e) {
        return { error: `Failed to resolve cohort lists: ${e.message}` };
      }
    }
    if (!scopedListIds) {
      const dailyId = process.env.CLICKUP_DAILY_TASK_LIST_ID;
      if (!dailyId) return { error: "No list_id/list_ids/cohort given and CLICKUP_DAILY_TASK_LIST_ID not set" };
      scopedListIds = [dailyId];
    }

    const params = new URLSearchParams();
    params.set("order_by", "created");
    params.set("reverse", "true");
    params.set("subtasks", "true");
    params.set("include_closed", String(include_closed));
    scopedListIds.forEach((id) => params.append("list_ids[]", id));
    if (Array.isArray(statuses)) statuses.forEach((s) => params.append("statuses[]", s));

    const res = await fetch(`https://api.clickup.com/api/v2/team/${teamId}/task?${params.toString()}`, {
      headers: { authorization: token },
    });
    const data = await res.json();
    if (!res.ok) return { error: `ClickUp ${res.status}: ${data.err || JSON.stringify(data)}` };

    let tasks = data.tasks || [];
    if (search) {
      const q = search.toLowerCase();
      tasks = tasks.filter((t) => (t.name || "").toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q));
    }
    tasks = tasks.slice(0, Math.min(limit, 50));
    return {
      count: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status?.status,
        priority: t.priority?.priority,
        url: t.url,
        list: t.list?.name,
        list_id: t.list?.id,
        assignees: (t.assignees || []).map((a) => a.username),
        due_date: t.due_date ? new Date(parseInt(t.due_date)).toISOString().slice(0, 10) : null,
        date_created: t.date_created ? new Date(parseInt(t.date_created)).toISOString().slice(0, 10) : null,
      })),
    };
  },

  async list_skills() {
    const skills = Object.values(SKILLS).map((s) => ({ name: s.name, description: s.description }));
    return { count: skills.length, skills };
  },

  async load_skill({ name }) {
    const skill = SKILLS[name];
    if (!skill) return { error: `Skill not found: ${name}. Available: ${Object.keys(SKILLS).join(", ") || "(none)"}` };
    return { name: skill.name, description: skill.description, content: skill.body };
  },

  async list_recent_actions({ limit = 10, since_hours = null, source = null, success_only = null }) {
    if (!AGENT_ACTIONS_TABLE_ID) return { error: "AGENT_ACTIONS_TABLE_ID not configured" };
    const filters = [];
    if (since_hours != null) {
      const cutoff = new Date(Date.now() - since_hours * 3600 * 1000).toISOString();
      filters.push(`(CreatedAt,gte,exactDate,${cutoff})`);
    }
    if (source) filters.push(`(Source,eq,${source})`);
    if (success_only === true) filters.push(`(Success,eq,1)`);
    if (success_only === false) filters.push(`(Success,eq,0)`);
    const where = filters.length ? `&where=${encodeURIComponent(filters.join("~and"))}` : "";
    const url = `/api/v2/tables/${AGENT_ACTIONS_TABLE_ID}/records?limit=${Math.min(limit, 50)}&sort=-CreatedAt${where}`;
    const data = await ncGet(url);
    return {
      count: data.list.length,
      actions: data.list.map((a) => ({
        id: a.Id,
        when: a.CreatedAt,
        summary: a.Summary,
        transcript: a.Transcript,
        tools_used: (() => { try { return JSON.parse(a["Tools used"] || "[]"); } catch { return []; } })(),
        iterations: a.Iterations,
        elapsed_ms: a["Elapsed ms"],
        success: a.Success,
        needed_clarification: a["Needed clarification"],
        source: a.Source,
      })),
    };
  },

  async delete_clickup_task({ task_id, confirmed = false }) {
    if (!confirmed) {
      return pendingConfirmation(
        `Delete ClickUp task ${task_id} (irreversible).`,
        { task_id, confirmed: true }
      );
    }
    const token = process.env.CLICKUP_TOKEN;
    if (!token) return { error: "CLICKUP_TOKEN not configured" };
    const res = await fetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
      method: "DELETE",
      headers: { authorization: token },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { error: `ClickUp ${res.status}: ${data.err || data.error || JSON.stringify(data)}` };
    }
    return { task_id, deleted: true };
  },

  async find_clickup_list({ query }) {
    let lists;
    try {
      lists = await getClickUpLists();
    } catch (e) {
      return { error: `Failed to discover ClickUp lists: ${e.message}` };
    }
    const matches = matchClickUpLists(lists, query);
    return {
      matches: matches.map((l) => ({ id: l.id, name: l.name, path: l.path })),
      total_lists_in_workspace: lists.length,
    };
  },

  async create_clickup_task({ name, description = "", priority = null, due_date = null, list_id = null, assignees = null }) {
    const token = process.env.CLICKUP_TOKEN;
    const targetList = list_id || process.env.CLICKUP_DEFAULT_LIST_ID;
    if (!token) return { error: "CLICKUP_TOKEN not configured on server" };
    if (!targetList) return { error: "No list_id provided and CLICKUP_DEFAULT_LIST_ID not set" };

    // Resolve friendly names to ClickUp user IDs.
    let assigneeIds = null;
    const unresolved = [];
    if (Array.isArray(assignees) && assignees.length > 0) {
      try {
        const users = await getClickUpUsers();
        assigneeIds = [];
        for (const a of assignees) {
          // Allow numeric IDs to pass through unchanged
          if (typeof a === "number" || /^\d+$/.test(String(a))) {
            assigneeIds.push(Number(a));
            continue;
          }
          const id = resolveClickUpAssignee(users, a);
          if (id) assigneeIds.push(Number(id));
          else unresolved.push(a);
        }
      } catch (e) {
        return { error: `Failed to resolve assignees: ${e.message}` };
      }
    }

    // Defensive: tool inputs occasionally arrive with the literal characters
    // backslash + n (or t/r) instead of real newlines. Normalize so users don't see
    // literal escape codes in ClickUp.
    const normalized = (description || "")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");

    // ClickUp's `description` field is plain text. To render markdown (bold, lists,
    // headings) the API needs `markdown_content` instead. Send both — ClickUp prefers
    // markdown_content when present.
    const body = { name, description: normalized, markdown_content: normalized };
    if (priority) body.priority = priority; // 1=urgent, 2=high, 3=normal, 4=low
    if (due_date) body.due_date = new Date(due_date).getTime();
    if (assigneeIds && assigneeIds.length > 0) body.assignees = assigneeIds;

    const res = await fetch(`https://api.clickup.com/api/v2/list/${targetList}/task`, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { error: `ClickUp ${res.status}: ${data.err || data.error || JSON.stringify(data)}` };
    const result = { id: data.id, url: data.url, name: data.name };
    if (assigneeIds) result.assignees_set = assigneeIds;
    if (unresolved.length > 0) result.unresolved_assignees = unresolved;
    return result;
  },

  async update_clickup_task({ task_id, name = null, description = null, priority = null, due_date = null, status = null, add_assignees = null, remove_assignees = null }) {
    const token = process.env.CLICKUP_TOKEN;
    if (!token) return { error: "CLICKUP_TOKEN not configured on server" };

    const body = {};
    if (name != null) body.name = name;
    if (description != null) {
      const normalized = description
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t");
      body.description = normalized;
      body.markdown_content = normalized;
    }
    if (priority != null) body.priority = priority;
    if (due_date != null) body.due_date = new Date(due_date).getTime();
    if (status != null) body.status = status;

    // ClickUp's PUT /task accepts assignees as { add: [...], rem: [...] }, NOT a flat array.
    const unresolved = [];
    if ((Array.isArray(add_assignees) && add_assignees.length) ||
        (Array.isArray(remove_assignees) && remove_assignees.length)) {
      let users;
      try {
        users = await getClickUpUsers();
      } catch (e) {
        return { error: `Failed to resolve assignees: ${e.message}` };
      }
      const resolveList = (arr) => {
        const ids = [];
        for (const a of arr || []) {
          if (typeof a === "number" || /^\d+$/.test(String(a))) {
            ids.push(Number(a));
            continue;
          }
          const id = resolveClickUpAssignee(users, a);
          if (id) ids.push(Number(id));
          else unresolved.push(a);
        }
        return ids;
      };
      const add = resolveList(add_assignees);
      const rem = resolveList(remove_assignees);
      if (add.length || rem.length) body.assignees = { add, rem };
    }

    if (Object.keys(body).length === 0) {
      return { error: "Provide at least one field to update (name, description, priority, due_date, status, add_assignees, remove_assignees)" };
    }

    const res = await fetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
      method: "PUT",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { error: `ClickUp ${res.status}: ${data.err || data.error || JSON.stringify(data)}` };
    const result = { id: data.id, url: data.url, name: data.name, updated_fields: Object.keys(body) };
    if (unresolved.length > 0) result.unresolved_assignees = unresolved;
    return result;
  },

  async update_person({ person_id, fields }) {
    const payload = { Id: person_id, ...fields, "Last touch": todayISO() };
    const updated = await ncPatch(`/api/v2/tables/${PEOPLE_TABLE_ID}/records`, [payload]);
    return { id: person_id, updated_fields: Object.keys(fields), result: updated };
  },

  async toggle_stage({ person_id, stage, value }) {
    if (!STAGE_COLUMN_MAP[stage]) {
      return {
        error: `Invalid stage: ${stage}. Valid: ${STAGE_ORDER.join(", ")}`,
      };
    }
    // Reject string-coerced booleans — the cascade logic uses `value === true` strict equality,
    // so "true"/"false" strings would silently flip the cascade direction.
    if (typeof value !== "boolean") {
      return {
        error: `toggle_stage value must be a boolean (true or false). Got ${typeof value}: ${JSON.stringify(value)}`,
      };
    }
    // Cascade only TRUE dependencies, not all earlier/later stages.
    //   value=true  → also mark prerequisites true (e.g. agreement_signed → agreement_sent)
    //   value=false → also mark dependents false (e.g. agreement_sent=false → agreement_signed=false)
    const updates = { Id: person_id, "Last touch": todayISO() };
    const affected = new Set([stage]);
    updates[STAGE_COLUMN_MAP[stage]] = value;

    if (value === true) {
      for (const prereq of STAGE_PREREQUISITES[stage] || []) {
        if (!affected.has(prereq)) {
          updates[STAGE_COLUMN_MAP[prereq]] = true;
          affected.add(prereq);
        }
      }
    } else {
      for (const dep of STAGE_DEPENDENTS[stage] || []) {
        if (!affected.has(dep)) {
          updates[STAGE_COLUMN_MAP[dep]] = false;
          affected.add(dep);
        }
      }
    }

    await ncPatch(`/api/v2/tables/${PEOPLE_TABLE_ID}/records`, [updates]);
    const cascaded = [...affected].filter((s) => s !== stage);
    return {
      id: person_id,
      stage,
      value,
      column: STAGE_COLUMN_MAP[stage],
      cascaded_stages: cascaded,
      cascade_reason: cascaded.length === 0 ? null : (value ? "prerequisites" : "dependents"),
    };
  },

  async add_note({ person_id, note }) {
    const data = await ncGet(
      `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(
        `(Id,eq,${person_id})`
      )}&limit=1`
    );
    if (data.list.length === 0) return { error: "Person not found" };
    const existingNotes = data.list[0].Notes || "";
    const stamp = todayISO();
    const newNotes = (existingNotes ? existingNotes + "\n\n" : "") + `[${stamp}] ${note}`;
    await ncPatch(`/api/v2/tables/${PEOPLE_TABLE_ID}/records`, [
      { Id: person_id, Notes: newNotes, "Last touch": todayISO() },
    ]);
    return { id: person_id, appended: note };
  },

  async link_person_to_cohort({ person_id, cohort_name }) {
    const cohort = await this.lookup_cohort({ name: cohort_name });
    if (!cohort.found) return { error: `Cohort not found: ${cohort_name}` };
    await ncPost(
      `/api/v2/tables/${PEOPLE_TABLE_ID}/links/${COHORTS_LINK_COLUMN_ID}/records/${person_id}`,
      [{ Id: cohort.id }]
    );
    return { person_id, cohort_id: cohort.id, cohort_name: cohort.name };
  },

  async log_touchpoint({ summary, content = "", channel = "Slack", direction = "Inbound", person_id = null }) {
    const payload = {
      Summary: summary,
      Channel: channel,
      Direction: direction,
      Source: "Compass agent",
      Timestamp: new Date().toISOString(),
      Content: content,
      "Handled by": "Compass",
    };
    const created = await ncPost(`/api/v2/tables/${TOUCHPOINTS_TABLE_ID}/records`, [payload]);
    const touchpointId = Array.isArray(created) ? created[0].Id : created.Id;

    // For bt-type links, NocoDB v2 doesn't accept the link inline at create time.
    // Use the link endpoint after creating the record.
    if (person_id) {
      try {
        await ncPost(
          `/api/v2/tables/${TOUCHPOINTS_TABLE_ID}/links/${TOUCHPOINTS_PERSON_LINK_COLUMN_ID}/records/${touchpointId}`,
          [{ Id: person_id }]
        );
      } catch (e) {
        return {
          ok: false,
          error: `Touchpoint ${touchpointId} created but failed to link to person ${person_id}: ${e.message}`,
          partial: { touchpoint_id: touchpointId, link_failed: true },
        };
      }
    }
    return { id: touchpointId, person_id: person_id || null };
  },

  // ---------- Generic NocoDB CRUD (use sparingly — these can change schema!) ----------

  async list_tables() {
    // Discover the base ID from a known table (PEOPLE_TABLE_ID), then list siblings.
    const peopleMeta = await ncGet(`/api/v2/meta/tables/${PEOPLE_TABLE_ID}`);
    const baseId = peopleMeta.base_id || peopleMeta.source_id || peopleMeta.fk_base_id;
    if (!baseId) return { error: "Could not determine base ID from People table metadata" };
    const data = await ncGet(`/api/v2/meta/bases/${baseId}/tables`);
    // Filter out Compass-internal infrastructure tables. The thread-state
    // table is the agent's own scratch memory; surfacing it to the model
    // invites confused reads/writes ("let me update the row count column…").
    const tables = (data.list || data.tables || data || [])
      .filter((t) => t.title !== THREAD_STATE_TABLE_TITLE)
      .map((t) => ({
        id: t.id,
        title: t.title,
        table_name: t.table_name,
        description: t.description || null,
      }));
    return { base_id: baseId, tables };
  },

  async add_table_column({ table_id, name, type = "SingleLineText", options = null }) {
    // type must be a NocoDB UI data type (uidt). Common: SingleLineText, LongText,
    // Number, Decimal, Checkbox, Date, DateTime, Email, PhoneNumber, URL, JSON,
    // SingleSelect, MultiSelect.
    //
    // SingleSelect / MultiSelect REQUIRE options[] — refuse to create them
    // without one. Silent fallback to a free-text column was the bug behind the
    // May 2026 "we agreed on a dropdown but got SingleLineText" incident.
    if (type === "SingleSelect" || type === "MultiSelect") {
      if (!Array.isArray(options) || options.length === 0) {
        return {
          error: `${type} columns require options[]. Pass an array of value strings, e.g. options: ["Foundations", "Mastery"]. Refusing to silently degrade to SingleLineText.`,
        };
      }
    } else if (options) {
      return { error: `options[] is only valid for SingleSelect or MultiSelect (got type=${type}).` };
    }
    const body = { column_name: name, title: name, uidt: type };
    if (options) body.colOptions = { options: options.map((v) => ({ title: String(v) })) };
    const created = await ncPost(`/api/v2/meta/tables/${table_id}/columns`, body);
    return { table_id, column_id: created.id || null, name, type, options: options || null };
  },

  // Append values to an existing SingleSelect / MultiSelect column. Use this
  // when a CSV import surfaces a value that's not in the current option list
  // (e.g. CSV has Source="Podcast" and the column only allows Direct/Referral
  // /Workshop/Website/Social/Other). Confirmation gated — schema-affecting
  // change.
  async add_select_options({ table_id, column_id, new_options, confirmed = false }) {
    if (!table_id || !column_id) {
      return { error: "table_id and column_id are required (use list_tables + get_table_meta to discover)" };
    }
    if (!Array.isArray(new_options) || new_options.length === 0) {
      return { error: "new_options must be a non-empty array of value strings" };
    }
    if (!confirmed) {
      return pendingConfirmation(
        `Add ${new_options.length} new option${new_options.length === 1 ? "" : "s"} to column ${column_id}: ${new_options.join(", ")}.`,
        { table_id, column_id, new_options, confirmed: true }
      );
    }
    // NocoDB requires the FULL options list on update — fetch existing first,
    // then append, then PATCH the column. Include column_name + title in the
    // body because NocoDB's column-update endpoint validates against the full
    // identifying tuple, not just the fields you're changing (an early version
    // of this tool 400'd because it omitted them).
    const meta = await ncGet(`/api/v2/meta/columns/${column_id}`);
    const uidt = meta?.uidt;
    if (uidt !== "SingleSelect" && uidt !== "MultiSelect") {
      return {
        error: `Column ${column_id} is type ${uidt || "unknown"}, not SingleSelect/MultiSelect — refusing to add options to it.`,
      };
    }
    const existing = (meta?.colOptions?.options || []).map((o) => o.title);
    const dedupNew = new_options.map((v) => String(v)).filter((v) => !existing.includes(v));
    if (dedupNew.length === 0) {
      return {
        table_id,
        column_id,
        added: 0,
        note: "All requested options already present.",
        existing,
      };
    }
    // Preserve the existing option metadata (color, order) — NocoDB strips it
    // if you only send `{title}`. Pass through the original objects and append
    // the new ones with just title.
    const mergedOptions = [
      ...(meta?.colOptions?.options || []),
      ...dedupNew.map((title) => ({ title })),
    ];
    await ncPatch(`/api/v2/meta/columns/${column_id}`, {
      column_name: meta.column_name,
      title: meta.title,
      uidt,
      colOptions: { options: mergedOptions },
    });
    return {
      table_id,
      column_id,
      added: dedupNew.length,
      new_total: mergedOptions.length,
      added_values: dedupNew,
    };
  },

  async create_table({ name, columns }) {
    if (!Array.isArray(columns) || columns.length === 0) {
      return { error: "columns must be a non-empty array of {name, type} objects" };
    }
    const peopleMeta = await ncGet(`/api/v2/meta/tables/${PEOPLE_TABLE_ID}`);
    const baseId = peopleMeta.base_id || peopleMeta.source_id || peopleMeta.fk_base_id;
    if (!baseId) return { error: "Could not determine base ID" };
    const created = await ncPost(`/api/v2/meta/bases/${baseId}/tables`, {
      table_name: name,
      title: name,
      columns: columns.map((c) => ({
        column_name: c.name,
        title: c.name,
        uidt: c.type || "SingleLineText",
      })),
    });
    return { table_id: created.id, title: created.title, columns_created: columns.length };
  },

  async bulk_create_records({ table_id, records }) {
    if (!Array.isArray(records) || records.length === 0) {
      return { error: "records must be a non-empty array of objects" };
    }
    if (records.length > 100) {
      return { error: `bulk_create_records accepts up to 100 records per call (got ${records.length}). Split into smaller batches.` };
    }
    const created = await ncPost(`/api/v2/tables/${table_id}/records`, records);
    const ids = (Array.isArray(created) ? created : [created]).map((r) => r.Id ?? r.id);
    return { table_id, count: ids.length, ids };
  },

  // Generic NocoDB read for any table. Supports filter (where), sort, fields,
  // limit, offset. Use list_tables first to discover table IDs. Read-only —
  // no confirmation gate. For specialized People queries prefer list_people /
  // lookup_person which already understand the People schema.
  async query_table({ table_id, where = null, fields = null, sort = null, limit = 25, offset = 0 }) {
    if (!table_id) return { error: "table_id required (use list_tables to discover)" };
    if (limit > 200) return { error: "limit cannot exceed 200" };
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (where) params.set("where", where);
    if (Array.isArray(fields) && fields.length > 0) params.set("fields", fields.join(","));
    if (sort) params.set("sort", sort);
    const data = await ncGet(`/api/v2/tables/${table_id}/records?${params.toString()}`);
    return {
      table_id,
      count: data.list?.length || 0,
      total_in_table: data.pageInfo?.totalRows ?? null,
      has_more: !!data.pageInfo?.isLastPage === false,
      records: data.list || [],
    };
  },

  // Generic NocoDB bulk update by Id. Each record must include 'Id' plus the
  // fields to set. CONFIRMATION GATED — touches multiple rows at once.
  async bulk_update_records({ table_id, records, confirmed = false }) {
    if (!table_id) return { error: "table_id required" };
    if (!Array.isArray(records) || records.length === 0) {
      return { error: "records must be a non-empty array of objects, each with 'Id'" };
    }
    if (records.length > 100) {
      return { error: `bulk_update_records accepts up to 100 records per call (got ${records.length}).` };
    }
    const missingId = records.findIndex((r) => r?.Id == null);
    if (missingId !== -1) {
      return { error: `record at index ${missingId} is missing 'Id' (required for update)` };
    }
    if (!confirmed) {
      return pendingConfirmation(
        `Update ${records.length} row${records.length === 1 ? "" : "s"} in table ${table_id}. Affected Ids: ${records.map((r) => r.Id).join(", ")}.`,
        { table_id, records, confirmed: true }
      );
    }
    const updated = await ncPatch(`/api/v2/tables/${table_id}/records`, records);
    return { table_id, count: Array.isArray(updated) ? updated.length : 1 };
  },

  // Generic NocoDB delete by Id. CONFIRMATION GATED — irreversible.
  async delete_records({ table_id, record_ids, confirmed = false }) {
    if (!table_id) return { error: "table_id required" };
    if (!Array.isArray(record_ids) || record_ids.length === 0) {
      return { error: "record_ids must be a non-empty array" };
    }
    if (record_ids.length > 100) {
      return { error: `delete_records accepts up to 100 ids per call (got ${record_ids.length}).` };
    }
    if (!confirmed) {
      return pendingConfirmation(
        `Delete ${record_ids.length} row${record_ids.length === 1 ? "" : "s"} from table ${table_id} (irreversible). Ids: ${record_ids.join(", ")}.`,
        { table_id, record_ids, confirmed: true }
      );
    }
    const body = record_ids.map((id) => ({ Id: id }));
    const result = await ncDelete(`/api/v2/tables/${table_id}/records`, body);
    return { table_id, deleted: record_ids.length, result };
  },

  // Phone numbers are stored in varied formats ("+61 400 555 090", "0400555090",
  // "+61400555090"). NocoDB's "like" filter is exact substring against stored bytes,
  // so we try a few variants of the query against the Phone column. Returns matching
  // people in the same shape as lookup_person.
  async find_person_by_phone({ query }) {
    const raw = String(query || "").trim();
    if (!raw) return { error: "query required" };
    const stripped = raw.replace(/\D/g, "");
    const variants = new Set();
    if (raw) variants.add(raw);
    if (stripped && stripped.length >= 6) variants.add(stripped);
    // Australian numbers: try with and without +61 country prefix
    if (stripped.startsWith("0") && stripped.length === 10) variants.add("61" + stripped.slice(1));
    if (stripped.startsWith("61") && stripped.length === 11) variants.add("0" + stripped.slice(2));
    // Last 7 digits as a final fallback (works only if stored value has no spaces)
    if (stripped.length >= 7) variants.add(stripped.slice(-7));

    const tried = [];
    for (const v of variants) {
      tried.push(v);
      const where = `(Phone,like,%${v}%)`;
      const data = await ncGet(
        `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(where)}&limit=10`
      );
      if (data.list && data.list.length > 0) {
        return {
          found: true,
          count: data.list.length,
          matched_variant: v,
          matches: data.list.map((p) => ({
            id: p.Id,
            name: p.Name,
            email: p["Primary email"],
            phone: p.Phone,
            status: p.Status,
            cohort: p["Cohort name"] || null,
          })),
        };
      }
    }
    return { found: false, query: raw, variants_tried: tried };
  },

  // Returns a single person's full state — fields, payment, stages, cohort, notes.
  // Saves the agent from chaining lookup_person + a follow-up record fetch.
  async get_person_full({ person_id }) {
    const data = await ncGet(
      `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(`(Id,eq,${person_id})`)}&limit=1`
    );
    if (!data.list || !data.list[0]) return { error: `Person ${person_id} not found` };
    const p = data.list[0];
    const stages = STAGE_ORDER.reduce((acc, s) => {
      acc[s] = !!p[STAGE_COLUMN_MAP[s]];
      return acc;
    }, {});
    return {
      id: p.Id,
      name: p.Name,
      email: p["Primary email"],
      phone: p.Phone,
      status: p.Status,
      owner: p.Owner,
      source: p.Source,
      cohort: p["Cohort name"] || null,
      timezone: p.Timezone,
      payment: {
        status: p["Payment status"] || null,
        total: p["Amount total"] ?? null,
        paid: p["Amount paid"] ?? null,
        owing: p["Amount owing"] ?? null,
        risk: p["Payment risk"] || null,
      },
      stages,
      next_action: p["Next action"] || null,
      room: p.Room || null,
      notes: p.Notes || null,
      last_touch: p["Last touch"] || null,
      created_at: p.CreatedAt || null,
    };
  },

  // Drafts a Gmail with an .ics calendar attachment for an onboarding (or other) call.
  // Reuses the existing gmail.compose OAuth scope — no Calendar API needed. Yohan
  // reviews + sends from his Gmail like any other draft.
  // Native Google Calendar event creation. Requires calendar.events OAuth scope.
  // The event lands on Yohan's calendar; attendees see the event but DO NOT receive
  // a Google notification email by default — Yohan reviews and explicitly opts in
  // to send invites by passing send_invites=true (which triggers Google Calendar's
  // own notification path). This preserves the "human reviews before send" model.
  async create_calendar_event({ person_id, datetime, duration_minutes = 45, title = null, description = null, location = null, send_invites = false, confirmed = false }) {
    if (!datetime) return { error: "datetime required (ISO 8601)" };
    const startUTC = new Date(datetime);
    if (isNaN(startUTC.getTime())) return { error: `Invalid datetime: ${datetime}` };
    if (!Number.isFinite(duration_minutes) || duration_minutes <= 0 || duration_minutes > 480) {
      return { error: "duration_minutes must be between 1 and 480" };
    }
    const endUTC = new Date(startUTC.getTime() + duration_minutes * 60000);
    if (!confirmed) {
      return pendingConfirmation(
        `Create calendar event for person_id=${person_id}: ${title || "UST Onboarding Call"} — ${startUTC.toISOString()} for ${duration_minutes}min${location ? ` at ${location}` : ""}${send_invites ? " (invite email WILL be sent to attendee)" : " (no invite email — attendee not notified)"}`,
        { person_id, datetime, duration_minutes, title, description, location, send_invites, confirmed: true }
      );
    }

    const data = await ncGet(
      `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(`(Id,eq,${person_id})`)}&limit=1`
    );
    if (!data.list || !data.list[0]) return { error: `Person ${person_id} not found` };
    const p = data.list[0];
    const recipientName = p.Name || "Attendee";
    const recipientEmail = p["Primary email"];
    if (!recipientEmail) return { error: `Person ${person_id} has no Primary email` };

    let accessToken;
    try {
      accessToken = await getGmailAccessToken();
    } catch (e) {
      return { error: e.message };
    }

    const eventBody = {
      summary: title || `UST Onboarding Call with ${recipientName}`,
      description: description || `${duration_minutes}-minute onboarding call to kick off your UST 9-week training.`,
      start: { dateTime: startUTC.toISOString() },
      end: { dateTime: endUTC.toISOString() },
      attendees: [{ email: recipientEmail, displayName: recipientName }],
    };
    if (location) eventBody.location = location;

    const sendUpdates = send_invites ? "all" : "none";
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${sendUpdates}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(eventBody),
    });
    const evt = await res.json();
    if (!res.ok) return { error: `Calendar API ${res.status}: ${evt.error?.message || JSON.stringify(evt)}` };
    return {
      person_id,
      event_id: evt.id,
      html_link: evt.htmlLink,
      start_utc: evt.start?.dateTime,
      end_utc: evt.end?.dateTime,
      attendees: (evt.attendees || []).map((a) => ({ email: a.email, status: a.responseStatus })),
      invites_sent: send_invites,
      hint: send_invites
        ? "Google sent a Calendar invite email to the attendee."
        : "Event created on Yohan's calendar — attendee was NOT notified. Either tell user to send invites manually from Calendar, or call again with send_invites=true if user confirms.",
    };
  },

  // Read free/busy from Yohan's primary Calendar. Use before suggesting a time slot.
  async check_calendar_availability({ start, end, calendar_id = "primary" }) {
    if (!start || !end) return { error: "start and end required (ISO 8601)" };
    const startUTC = new Date(start);
    const endUTC = new Date(end);
    if (isNaN(startUTC.getTime()) || isNaN(endUTC.getTime())) {
      return { error: "Invalid start or end datetime" };
    }
    if (endUTC <= startUTC) return { error: "end must be after start" };

    let accessToken;
    try {
      accessToken = await getGmailAccessToken();
    } catch (e) {
      return { error: e.message };
    }

    // Use Google's freeBusy API — returns just busy ranges, no event content.
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        timeMin: startUTC.toISOString(),
        timeMax: endUTC.toISOString(),
        items: [{ id: calendar_id }],
      }),
    });
    const data = await res.json();
    if (!res.ok) return { error: `Calendar API ${res.status}: ${data.error?.message || JSON.stringify(data)}` };
    const busy = data.calendars?.[calendar_id]?.busy || [];
    return {
      window_start: startUTC.toISOString(),
      window_end: endUTC.toISOString(),
      calendar_id,
      busy_count: busy.length,
      busy,
      free: busy.length === 0,
    };
  },

  // Patch an existing calendar event. Lets Compass reschedule or amend an
  // event it (or a human) created earlier without recreating it. All fields
  // optional except event_id — only the supplied fields are changed.
  async update_calendar_event({ event_id, datetime = null, duration_minutes = null, title = null, description = null, location = null, send_updates = false, confirmed = false }) {
    if (!event_id) return { error: "event_id required (from create_calendar_event response)" };
    if (!confirmed) {
      const changes = [];
      if (datetime) changes.push(`start → ${datetime}`);
      if (duration_minutes) changes.push(`duration → ${duration_minutes}min`);
      if (title) changes.push(`title → "${title}"`);
      if (description) changes.push(`description (replaced)`);
      if (location) changes.push(`location → "${location}"`);
      if (!changes.length) return { error: "Nothing to update — pass at least one of datetime, duration_minutes, title, description, location" };
      return pendingConfirmation(
        `Update calendar event ${event_id}: ${changes.join(", ")}${send_updates ? " (attendees WILL be emailed)" : " (no email to attendees)"}`,
        { event_id, datetime, duration_minutes, title, description, location, send_updates, confirmed: true }
      );
    }
    let accessToken;
    try {
      accessToken = await getGmailAccessToken();
    } catch (e) {
      return { error: e.message };
    }
    const patch = {};
    if (title) patch.summary = title;
    if (description) patch.description = description;
    if (location) patch.location = location;
    if (datetime) {
      const startUTC = new Date(datetime);
      if (isNaN(startUTC.getTime())) return { error: `Invalid datetime: ${datetime}` };
      patch.start = { dateTime: startUTC.toISOString() };
      // If duration provided alongside datetime, compute end from start+duration.
      // Otherwise fetch the existing event to preserve original duration.
      if (duration_minutes) {
        const endUTC = new Date(startUTC.getTime() + duration_minutes * 60000);
        patch.end = { dateTime: endUTC.toISOString() };
      } else {
        const getRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${event_id}`,
          { headers: { authorization: `Bearer ${accessToken}` } }
        );
        const existing = await getRes.json();
        if (!getRes.ok) return { error: `Calendar API ${getRes.status}: ${existing.error?.message || JSON.stringify(existing)}` };
        const origStart = new Date(existing.start?.dateTime || existing.start?.date);
        const origEnd = new Date(existing.end?.dateTime || existing.end?.date);
        const origDurationMs = origEnd.getTime() - origStart.getTime();
        patch.end = { dateTime: new Date(startUTC.getTime() + origDurationMs).toISOString() };
      }
    } else if (duration_minutes) {
      // Duration changed but start unchanged — fetch start to compute new end.
      const getRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${event_id}`,
        { headers: { authorization: `Bearer ${accessToken}` } }
      );
      const existing = await getRes.json();
      if (!getRes.ok) return { error: `Calendar API ${getRes.status}: ${existing.error?.message || JSON.stringify(existing)}` };
      const startUTC = new Date(existing.start?.dateTime || existing.start?.date);
      patch.end = { dateTime: new Date(startUTC.getTime() + duration_minutes * 60000).toISOString() };
    }
    const sendUpdates = send_updates ? "all" : "none";
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${event_id}?sendUpdates=${sendUpdates}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(patch),
      }
    );
    const evt = await res.json();
    if (!res.ok) return { error: `Calendar API ${res.status}: ${evt.error?.message || JSON.stringify(evt)}` };
    return {
      event_id: evt.id,
      html_link: evt.htmlLink,
      start_utc: evt.start?.dateTime,
      end_utc: evt.end?.dateTime,
      updates_emailed: send_updates,
    };
  },

  // Cancel a calendar event. send_cancellations controls whether attendees
  // get a Google-generated cancellation email.
  async delete_calendar_event({ event_id, send_cancellations = false, confirmed = false }) {
    if (!event_id) return { error: "event_id required" };
    if (!confirmed) {
      return pendingConfirmation(
        `Delete calendar event ${event_id}${send_cancellations ? " (attendees WILL be emailed a cancellation)" : " (no email to attendees)"}`,
        { event_id, send_cancellations, confirmed: true }
      );
    }
    let accessToken;
    try {
      accessToken = await getGmailAccessToken();
    } catch (e) {
      return { error: e.message };
    }
    const sendUpdates = send_cancellations ? "all" : "none";
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${event_id}?sendUpdates=${sendUpdates}`,
      { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } }
    );
    if (res.status === 204 || res.status === 200) {
      return { ok: true, event_id, cancellations_emailed: send_cancellations };
    }
    const data = await res.json().catch(() => ({}));
    return { error: `Calendar API ${res.status}: ${data.error?.message || JSON.stringify(data)}` };
  },

  // Read values from a Google Sheet. Read-only — uses the spreadsheets.readonly
  // scope. Accepts a bare spreadsheet ID or a full sheets.google.com URL (we
  // extract the ID from the /d/<ID>/ segment). `range` is A1 notation
  // ('Sheet1!A1:D', 'A:F', or just 'Sheet1' for the whole tab).
  async read_google_sheet({ sheet_id, range = null, max_rows = 500 }) {
    if (!sheet_id) return { error: "sheet_id required (the spreadsheet ID or full Sheets URL)" };
    let id = String(sheet_id).trim();
    const urlMatch = id.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) id = urlMatch[1];
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return { error: `Could not extract a valid spreadsheet ID from: ${sheet_id}` };
    }
    let accessToken;
    try {
      accessToken = await getGmailAccessToken();
    } catch (e) {
      return { error: e.message };
    }
    // If no range given, fetch sheet metadata to discover the first tab name.
    let resolvedRange = range;
    if (!resolvedRange) {
      const metaRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`,
        { headers: { authorization: `Bearer ${accessToken}` } }
      );
      const meta = await metaRes.json();
      if (!metaRes.ok) {
        return { error: `Sheets API ${metaRes.status}: ${meta.error?.message || JSON.stringify(meta)}` };
      }
      const firstTab = meta.sheets?.[0]?.properties?.title;
      if (!firstTab) return { error: "Spreadsheet has no sheets" };
      resolvedRange = firstTab;
    }
    const valRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(resolvedRange)}`,
      { headers: { authorization: `Bearer ${accessToken}` } }
    );
    const val = await valRes.json();
    if (!valRes.ok) {
      return { error: `Sheets API ${valRes.status}: ${val.error?.message || JSON.stringify(val)}` };
    }
    const rows = val.values || [];
    const truncated = rows.length > max_rows;
    return {
      sheet_id: id,
      range: val.range || resolvedRange,
      row_count: rows.length,
      truncated,
      rows: truncated ? rows.slice(0, max_rows) : rows,
    };
  },

  async draft_calendar_invite_email({ person_id, datetime, duration_minutes = 45, title = null, description = null, location = null }) {
    if (!datetime) return { error: "datetime required (ISO 8601)" };
    const startUTC = new Date(datetime);
    if (isNaN(startUTC.getTime())) return { error: `Invalid datetime: ${datetime}` };
    if (!Number.isFinite(duration_minutes) || duration_minutes <= 0 || duration_minutes > 480) {
      return { error: "duration_minutes must be between 1 and 480" };
    }
    const endUTC = new Date(startUTC.getTime() + duration_minutes * 60000);

    const data = await ncGet(
      `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(`(Id,eq,${person_id})`)}&limit=1`
    );
    if (!data.list || !data.list[0]) return { error: `Person ${person_id} not found` };
    const p = data.list[0];
    const recipientName = p.Name || "there";
    const recipientEmail = p["Primary email"];
    if (!recipientEmail) return { error: `Person ${person_id} has no Primary email` };

    let accessToken;
    try {
      accessToken = await getGmailAccessToken();
    } catch (e) {
      return { error: e.message };
    }
    const fromAddress = await getGmailFromAddress(accessToken);

    const finalTitle = title || `UST Onboarding Call with ${recipientName}`;
    const finalDescription =
      description ||
      `${duration_minutes}-minute onboarding call to kick off your UST 9-week training. Looking forward to it.`;
    const uid = `compass-${Date.now()}-${Math.random().toString(36).slice(2)}@unconditional.earth`;
    const ics = buildICS({
      uid,
      startUTC,
      endUTC,
      title: finalTitle,
      description: finalDescription,
      organizerName: "Yohan Dante",
      organizerEmail: fromAddress,
      attendeeName: recipientName,
      attendeeEmail: recipientEmail,
      location,
    });

    // Format the time for the email body in AU-friendly form (Brisbane TZ).
    const formattedTime = startUTC.toLocaleString("en-AU", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "Australia/Brisbane",
    });
    const html = `<div style="font-family:system-ui,arial;font-size:15px;line-height:1.6;color:#222">
<p>Hi ${recipientName},</p>
<p>Confirming our ${duration_minutes}-minute onboarding call:</p>
<p><strong>${formattedTime}</strong> (Brisbane time)</p>
${location ? `<p>Location: ${location}</p>` : ""}
<p>I've attached a calendar invite — clicking it will add the event to your calendar.</p>
<p>Looking forward to it.</p>
<p>— Yohan</p>
</div>`;

    const raw = buildCalendarInviteMime({
      from: `Yohan Dante <${fromAddress}>`,
      to: `${recipientName} <${recipientEmail}>`,
      subject: finalTitle,
      html,
      ics,
    });

    const draftRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    });
    const draftData = await draftRes.json();
    if (!draftRes.ok) return { error: `Gmail draft failed: ${JSON.stringify(draftData)}` };
    return {
      person_id,
      draft_id: draftData.id,
      to: recipientEmail,
      subject: finalTitle,
      start_utc: startUTC.toISOString(),
      end_utc: endUTC.toISOString(),
      duration_minutes,
      gmail_url: `https://mail.google.com/mail/u/0/#drafts/${draftData.id}`,
    };
  },

  // ---------- Compass knowledge (long-term memory) ----------
  // pin_knowledge writes a fact to a NocoDB table. recall_knowledge searches it.
  // Use case: Valerie says "this is the Drive folder for curriculum" — Compass pins
  // the fact, then later when Yohan asks "where's the cohort 12 curriculum?",
  // Compass calls recall_knowledge('curriculum') and finds the pinned URL.

  async pin_knowledge({ topic, content, tags = null, added_by = null, source = null }) {
    if (!KNOWLEDGE_TABLE_ID) return { error: "KNOWLEDGE_TABLE_ID not configured" };
    if (!topic || !content) return { error: "topic and content are both required" };
    const payload = {
      Topic: topic,
      Content: content,
      Tags: tags || null,
      "Added by": added_by || null,
      Source: source || null,
    };
    const created = await ncPost(`/api/v2/tables/${KNOWLEDGE_TABLE_ID}/records`, [payload]);
    const id = Array.isArray(created) ? created[0].Id : created.Id;
    return { id, topic, content_preview: String(content).slice(0, 120) };
  },

  async recall_knowledge({ query = null, tag = null, limit = 5 }) {
    if (!KNOWLEDGE_TABLE_ID) return { error: "KNOWLEDGE_TABLE_ID not configured" };
    // Build a NocoDB filter: substring match on Topic OR Content if query given,
    // and exact tag match if tag given.
    const conditions = [];
    if (query) {
      const q = String(query).trim();
      // Use NocoDB's "or" combinator with two like clauses.
      conditions.push(`((Topic,like,%${q}%)~or(Content,like,%${q}%))`);
    }
    if (tag) {
      conditions.push(`(Tags,like,%${String(tag).trim()}%)`);
    }
    const where = conditions.length > 0 ? `&where=${encodeURIComponent(conditions.join("~and"))}` : "";
    const url = `/api/v2/tables/${KNOWLEDGE_TABLE_ID}/records?limit=${Math.min(limit, 25)}&sort=-CreatedAt${where}`;
    const data = await ncGet(url);
    const items = (data.list || []).map((r) => ({
      id: r.Id,
      topic: r.Topic,
      content: r.Content,
      tags: r.Tags || null,
      added_by: r["Added by"] || null,
      added_at: r.CreatedAt,
    }));
    return { count: items.length, items };
  },

  // Send a direct message to a teammate. Different from /run's reply path —
  // this initiates a NEW message to a specific user, not a reply to the
  // triggering channel/thread. Resolves friendly names via env vars.
  // Add an emoji reaction to a Slack message. Lighter-touch than replying for
  // brief acknowledgements ("thanks", "got it", "great"). Channel and message_ts
  // default to the triggering message when not supplied — most common case.
  async react_to_message({ emoji, channel = null, message_ts = null }) {
    if (!emoji) return { error: "emoji required (name without colons, e.g. 'thumbsup')" };
    // Strip leading/trailing colons if the model included them
    const name = String(emoji).trim().replace(/^:|:$/g, "");
    // Defaults to the most recent slack_context — runAgent's caller (the /run
    // handler) attaches this onto a global-ish scope. We pull from the closure
    // via process.env... actually we don't have it here. The agent must pass
    // channel + message_ts explicitly when these aren't the triggering message.
    if (!channel || !message_ts) {
      return { error: "channel and message_ts required (no implicit triggering-message context inside tool impl). Use the values you can read from the slack_context block in the transcript." };
    }
    const res = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel, timestamp: message_ts, name }),
    });
    const data = await res.json();
    if (!data.ok) {
      // already_reacted is a benign "we tried to add a reaction we'd already added"
      if (data.error === "already_reacted") return { ok: true, already: true, name };
      return { error: `Slack reactions.add failed: ${data.error || JSON.stringify(data)}` };
    }
    return { ok: true, channel, message_ts, name };
  },

  async send_channel_message({ channel, message, thread_ts = null }) {
    if (!channel || !message) return { error: "channel and message are both required" };
    // Accept Slack IDs (C..., G...) or friendly names like 'project-get-proactive'
    // or '#project-get-proactive'. chat.postMessage accepts both, but the # form
    // is deprecated; we still pass it through and let Slack resolve.
    const target = /^[CG][A-Z0-9]+$/.test(channel)
      ? channel
      : `#${String(channel).replace(/^#/, "")}`;
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: target,
        text: toSlackMrkdwn(message),
        ...(thread_ts ? { thread_ts } : {}),
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      const err = data.error || JSON.stringify(data);
      if (err === "not_in_channel" || err === "channel_not_found") {
        return {
          error: `Slack chat.postMessage failed: ${err}. The bot needs to be invited to the channel first — ask the user to '/invite @Compass' in that channel.`,
        };
      }
      return { error: `Slack chat.postMessage failed: ${err}` };
    }
    return { ok: true, channel: data.channel, ts: data.ts };
  },

  async send_slack_dm({ to, message, thread_link = null }) {
    if (!to || !message) return { error: "to and message are both required" };
    let userId = null;
    if (typeof to === "string" && /^U[A-Z0-9]+$/.test(to)) {
      userId = to;
    } else {
      const map = {
        yohan: process.env.YOHAN_SLACK_ID,
        valerie: process.env.VALERIE_SLACK_ID,
        nathan: process.env.NATHAN_SLACK_ID,
      };
      userId = map[String(to).toLowerCase().trim()];
      if (!userId) {
        return { error: `Unknown recipient: ${to}. Known names: yohan, valerie, nathan. Or pass a Slack user_id starting with U.` };
      }
    }
    const body = thread_link ? `${message}\n\nContext: ${thread_link}` : message;
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      // Slack accepts a user_id as `channel` — auto-opens the DM if needed.
      body: JSON.stringify({ channel: userId, text: toSlackMrkdwn(body) }),
    });
    const data = await res.json();
    if (!data.ok) {
      return { error: `Slack chat.postMessage failed: ${data.error || JSON.stringify(data)}` };
    }
    return { ok: true, recipient: userId, ts: data.ts, channel: data.channel };
  },

  // ---------- Slack reminders ----------
  // Wraps Slack's reminders.add / reminders.list. Time accepts Unix epoch seconds
  // OR natural language like "in 30 minutes", "tomorrow at 3pm", "next Monday".
  // Slack parses natural language server-side and is forgiving.

  async create_slack_reminder({ text, time, user = null }) {
    if (!text || !time) return { error: "text and time are both required" };
    let userId = null;
    let friendlyName = null;
    if (user) {
      if (typeof user === "string" && /^U[A-Z0-9]+$/.test(user)) {
        userId = user;
        const reverse = {
          [process.env.YOHAN_SLACK_ID]: "yohan",
          [process.env.VALERIE_SLACK_ID]: "valerie",
          [process.env.NATHAN_SLACK_ID]: "nathan",
        };
        friendlyName = reverse[userId] || null;
      } else {
        const map = {
          yohan: process.env.YOHAN_SLACK_ID,
          valerie: process.env.VALERIE_SLACK_ID,
          nathan: process.env.NATHAN_SLACK_ID,
        };
        const key = String(user).toLowerCase().trim();
        userId = map[key];
        if (!userId) {
          return { error: `Unknown user: ${user}. Use 'yohan' / 'valerie' / 'nathan' or a Slack user_id.` };
        }
        friendlyName = key;
      }
    } else {
      return {
        error:
          "user required. Pass the from_user_id from the '## Slack message reference' block at the top of the transcript for 'remind me' requests, or 'yohan' / 'valerie' / 'nathan' / a Slack user_id for someone else.",
      };
    }
    const postAt = /^\d+$/.test(String(time)) ? Number(time) : null;
    if (postAt === null) {
      return {
        error:
          "time must be Unix epoch seconds. Compute from the current date in your context plus the requested offset (e.g. now + 300 for 'in 5 minutes'). Slack natural-language strings are not accepted by chat.scheduleMessage.",
      };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (postAt <= nowSec) {
      return { error: `time must be in the future (got post_at=${postAt}, now=${nowSec})` };
    }
    if (postAt > nowSec + 120 * 86400) {
      return { error: "time cannot be more than 120 days in the future (Slack chat.scheduleMessage limit)" };
    }
    // chat.scheduleMessage works with bot tokens for any user the bot can DM —
    // unlike reminders.add which silently no-ops the `user` param on bot tokens.
    // The bot will DM the target user at post_at with the reminder text.
    const res = await fetch("https://slack.com/api/chat.scheduleMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: userId,
        text: `:bell: Reminder: ${text}`,
        post_at: postAt,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      // Hard failure (channel can't open, user_not_found, etc) — fall back to a
      // ClickUp task assigned to the intended recipient. Same intent, different
      // surface.
      const slackErr = data.error || JSON.stringify(data);
      const dueMs = postAt * 1000;
      const fallback = await this.create_clickup_task({
        name: `Reminder: ${text}`,
        description: `Auto-created because Slack rejected chat.scheduleMessage (${slackErr}).\n\n**When:** ${new Date(dueMs).toISOString()}`,
        due_date: dueMs,
        assignees: friendlyName ? [friendlyName] : null,
      });
      if (fallback?.error) {
        return { error: `Slack chat.scheduleMessage failed (${slackErr}); ClickUp fallback also failed: ${fallback.error}` };
      }
      return {
        ok: true,
        fallback: "clickup_task",
        reason: `Slack rejected chat.scheduleMessage with '${slackErr}'. Created a ClickUp task instead.`,
        task_id: fallback.id,
        task_url: fallback.url,
        assignee: friendlyName || userId,
      };
    }
    return {
      ok: true,
      scheduled_message_id: data.scheduled_message_id,
      channel: data.channel,
      post_at: data.post_at,
      user: userId,
      friendly_name: friendlyName,
    };
  },

  async list_slack_reminders() {
    const res = await fetch("https://slack.com/api/chat.scheduledMessages.list", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const data = await res.json();
    if (!data.ok) {
      return { error: `Slack chat.scheduledMessages.list failed: ${data.error || JSON.stringify(data)}` };
    }
    return {
      count: (data.scheduled_messages || []).length,
      reminders: (data.scheduled_messages || []).map((r) => ({
        id: r.id,
        channel: r.channel_id,
        text: r.text,
        post_at: r.post_at,
      })),
    };
  },

  async delete_slack_reminder({ scheduled_message_id, channel }) {
    if (!scheduled_message_id || !channel) {
      return { error: "scheduled_message_id and channel are both required (read both from list_slack_reminders output)" };
    }
    const res = await fetch("https://slack.com/api/chat.deleteScheduledMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, scheduled_message_id }),
    });
    const data = await res.json();
    if (!data.ok) {
      return { error: `Slack chat.deleteScheduledMessage failed: ${data.error || JSON.stringify(data)}` };
    }
    return { ok: true, scheduled_message_id, channel };
  },

  // Read recent messages from a Slack channel. Use when the user wants context
  // from elsewhere — "what did Valerie say about deposits in #ops", "scan
  // #intake for unanswered questions". Bot must be a member of the channel.
  async read_channel_history({ channel, limit = 20, oldest = null, latest = null }) {
    if (!channel) return { error: "channel required (ID like C0B2W2U5MQ9 or G... — channel names not accepted here, look up the ID first)" };
    const params = { channel, limit: Math.min(Math.max(Number(limit) || 20, 1), 100) };
    if (oldest) params.oldest = oldest;
    if (latest) params.latest = latest;
    let data;
    try {
      data = await slackApi("conversations.history", params);
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("not_in_channel") || msg.includes("channel_not_found")) {
        return { error: `${msg}. Ask the user to /invite @Compass to the channel.` };
      }
      if (msg.includes("missing_scope")) {
        return { error: `${msg}. The bot needs channels:history (public) / groups:history (private) scopes added.` };
      }
      return { error: msg };
    }
    const messages = await Promise.all(
      (data.messages || []).map(async (m) => ({
        ts: m.ts,
        user_id: m.user || m.bot_id || null,
        user_name: m.user ? await getUserName(m.user) : (m.username || "bot"),
        text: m.text || "",
        thread_ts: m.thread_ts || null,
        reply_count: m.reply_count || 0,
        subtype: m.subtype || null,
      }))
    );
    return {
      channel,
      count: messages.length,
      has_more: !!data.has_more,
      messages,
    };
  },

  // Look up a Slack user by email, user_id, or friendly name. Use when the
  // user asks Compass to message someone whose ID isn't in the env-var map.
  async lookup_slack_user({ email = null, user_id = null, name = null }) {
    if (!email && !user_id && !name) {
      return { error: "Pass one of: email, user_id, or name ('yohan'/'valerie'/'nathan')" };
    }
    let resolvedId = user_id;
    if (!resolvedId && name) {
      const map = {
        yohan: process.env.YOHAN_SLACK_ID,
        valerie: process.env.VALERIE_SLACK_ID,
        nathan: process.env.NATHAN_SLACK_ID,
      };
      resolvedId = map[String(name).toLowerCase().trim()] || null;
      if (!resolvedId) return { error: `No mapping for name '${name}'. Try email instead.` };
    }
    if (!resolvedId && email) {
      try {
        const data = await slackApi("users.lookupByEmail", { email });
        resolvedId = data.user?.id;
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes("users_not_found")) return { error: `No Slack user found for email ${email}` };
        if (msg.includes("missing_scope")) return { error: `${msg}. Bot needs users:read.email scope.` };
        return { error: msg };
      }
    }
    if (!resolvedId) return { error: "Could not resolve a user_id" };
    let info;
    try {
      info = await slackApi("users.info", { user: resolvedId });
    } catch (e) {
      return { error: String(e.message || e) };
    }
    const u = info.user || {};
    return {
      user_id: u.id,
      real_name: u.real_name || u.profile?.real_name || null,
      display_name: u.profile?.display_name || null,
      email: u.profile?.email || null,
      is_bot: !!u.is_bot,
      tz: u.tz || null,
    };
  },

  // Edit a message Compass previously posted. Slack restricts chat.update to
  // messages sent by the bot itself.
  async update_message({ channel, ts, message }) {
    if (!channel || !ts || !message) return { error: "channel, ts, and message are all required" };
    const res = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: { authorization: `Bearer ${SLACK_BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, ts, text: toSlackMrkdwn(message) }),
    });
    const data = await res.json();
    if (!data.ok) {
      const err = data.error || JSON.stringify(data);
      if (err === "cant_update_message" || err === "message_not_found") {
        return { error: `Slack chat.update failed: ${err}. Compass can only edit its own messages.` };
      }
      return { error: `Slack chat.update failed: ${err}` };
    }
    return { ok: true, channel: data.channel, ts: data.ts };
  },

  // Delete a message Compass previously posted. Same restriction as update.
  async delete_message({ channel, ts }) {
    if (!channel || !ts) return { error: "channel and ts are both required" };
    const res = await fetch("https://slack.com/api/chat.delete", {
      method: "POST",
      headers: { authorization: `Bearer ${SLACK_BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, ts }),
    });
    const data = await res.json();
    if (!data.ok) {
      const err = data.error || JSON.stringify(data);
      if (err === "cant_delete_message" || err === "message_not_found") {
        return { error: `Slack chat.delete failed: ${err}. Compass can only delete its own messages.` };
      }
      return { error: `Slack chat.delete failed: ${err}` };
    }
    return { ok: true, channel, ts };
  },

  // Get a permanent link to a Slack message. Useful for cross-linking — DM
  // someone with a permalink back to a channel thread.
  async get_message_permalink({ channel, message_ts }) {
    if (!channel || !message_ts) return { error: "channel and message_ts are both required" };
    try {
      const data = await slackApi("chat.getPermalink", { channel, message_ts });
      return { ok: true, permalink: data.permalink };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  },

  // Upload a text/CSV file to Slack and share it into a channel or DM. Uses
  // the modern external-upload flow (files.upload v1 was deprecated May 2025).
  // Best for artifacts Compass generates inline: CSV exports, import diffs,
  // text summaries. Not for binary files — `content` is a UTF-8 string.
  async upload_file({ filename, content, channel = null, thread_ts = null, comment = null, title = null }) {
    if (!filename || content == null) return { error: "filename and content are both required" };
    const bytes = Buffer.from(String(content), "utf8");
    // Step 1: get an upload URL.
    const urlRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ filename, length: String(bytes.length) }).toString(),
    });
    const urlData = await urlRes.json();
    if (!urlData.ok) {
      const err = urlData.error || JSON.stringify(urlData);
      if (err === "missing_scope") {
        return { error: `${err}. Bot needs files:write scope.` };
      }
      return { error: `Slack files.getUploadURLExternal failed: ${err}` };
    }
    // Step 2: PUT the bytes to the returned URL.
    const putRes = await fetch(urlData.upload_url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!putRes.ok) {
      return { error: `File upload failed (${putRes.status}): ${await putRes.text()}` };
    }
    // Step 3: complete the upload, optionally sharing into a channel.
    const completeBody = {
      files: [{ id: urlData.file_id, ...(title ? { title } : {}) }],
      ...(channel ? { channel_id: channel } : {}),
      ...(thread_ts ? { thread_ts } : {}),
      ...(comment ? { initial_comment: comment } : {}),
    };
    const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: { authorization: `Bearer ${SLACK_BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(completeBody),
    });
    const completeData = await completeRes.json();
    if (!completeData.ok) {
      const err = completeData.error || JSON.stringify(completeData);
      if (err === "not_in_channel") {
        return { error: `${err}. Bot needs to be invited to the channel before sharing files there.` };
      }
      return { error: `Slack files.completeUploadExternal failed: ${err}` };
    }
    const file = completeData.files?.[0] || {};
    return {
      ok: true,
      file_id: file.id,
      title: file.title,
      permalink: file.permalink,
      channel_shared: channel || null,
    };
  },

  // ---------- Introspection ----------
  // Lets the agent answer questions about itself (scopes, tool inventory,
  // deploy version, integration wiring) instead of guessing or stalling.
  async inspect_slack_config() {
    // auth.test directly (not via slackApi) so we can read the
    // x-oauth-scopes response header — slackApi() discards headers.
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const data = await res.json();
    if (!data.ok) {
      return { error: `Slack auth.test failed: ${data.error || JSON.stringify(data)}` };
    }
    const scopes = (res.headers.get("x-oauth-scopes") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      team: data.team,
      team_id: data.team_id,
      bot_user: data.user,
      bot_user_id: data.user_id,
      url: data.url,
      scopes,
    };
  },

  async inspect_self() {
    const allNamed = tools.filter((t) => t.name);
    const deferred = allNamed.filter((t) => t.defer_loading).map((t) => t.name);
    const alwaysLoaded = allNamed.filter((t) => !t.defer_loading).map((t) => t.name);
    return {
      model: AGENT_MODEL,
      version: {
        commit: process.env.RENDER_GIT_COMMIT || readLocalGitSha() || "unknown",
        branch: process.env.RENDER_GIT_BRANCH || null,
        service: process.env.RENDER_SERVICE_NAME || null,
        booted_at: BOOT_TIME,
      },
      tools: {
        always_loaded: alwaysLoaded,
        deferred,
        total: alwaysLoaded.length + deferred.length,
      },
      // Presence only — never values. Keeps secrets out of agent context
      // while still letting the agent reason about which integrations are wired.
      integration_env: {
        anthropic: { ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY },
        nocodb: {
          NOCODB_URL: !!process.env.NOCODB_URL,
          NOCODB_TOKEN: !!process.env.NOCODB_TOKEN,
        },
        slack: { SLACK_BOT_TOKEN: !!process.env.SLACK_BOT_TOKEN },
        google: {
          GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
          GOOGLE_REFRESH_TOKEN: !!process.env.GOOGLE_REFRESH_TOKEN,
        },
        clickup: {
          CLICKUP_TOKEN: !!process.env.CLICKUP_TOKEN,
          CLICKUP_DEFAULT_LIST_ID: !!process.env.CLICKUP_DEFAULT_LIST_ID,
        },
        jotform: {
          JOTFORM_API_KEY: !!process.env.JOTFORM_API_KEY,
          JOTFORM_INTAKE_FORM_ID: !!process.env.JOTFORM_INTAKE_FORM_ID,
        },
        docuseal: {
          DOCUSEAL_API_KEY: !!process.env.DOCUSEAL_API_KEY,
          DOCUSEAL_DEFAULT_TEMPLATE_ID: !!process.env.DOCUSEAL_DEFAULT_TEMPLATE_ID,
        },
      },
    };
  },

  // ---------- JotForm read access ----------
  // Lets Compass auto-populate People records from intake form submissions
  // and flag anomalies, instead of someone copy-pasting form data manually.
  // Auth via JOTFORM_API_KEY env var (https://www.jotform.com/myaccount/api).

  async list_jotform_submissions({ form_id = null, limit = 25, offset = 0, since = null }) {
    const apiKey = process.env.JOTFORM_API_KEY;
    if (!apiKey) return { error: "JOTFORM_API_KEY not configured" };
    const targetForm = form_id || process.env.JOTFORM_INTAKE_FORM_ID;
    if (!targetForm) {
      return { error: "form_id required (or set JOTFORM_INTAKE_FORM_ID env var for default)" };
    }
    const params = new URLSearchParams({
      apiKey,
      limit: String(Math.min(limit, 100)),
      offset: String(offset),
      orderby: "created_at",
    });
    // since: ISO 8601 — JotForm wants YYYY-MM-DD HH:MM:SS in UTC
    if (since) {
      const d = new Date(since);
      if (!isNaN(d)) {
        const stamp = d.toISOString().replace("T", " ").slice(0, 19);
        params.set("filter", JSON.stringify({ "created_at:gt": stamp }));
      }
    }
    const res = await fetch(`https://api.jotform.com/form/${targetForm}/submissions?${params}`);
    const data = await res.json();
    if (data.responseCode !== 200) {
      return { error: `JotForm ${data.responseCode}: ${data.message || JSON.stringify(data)}` };
    }
    // Each submission has: id, created_at, status, answers (object keyed by question id)
    return {
      form_id: targetForm,
      count: (data.content || []).length,
      submissions: (data.content || []).map((s) => ({
        id: s.id,
        created_at: s.created_at,
        status: s.status,
        // Flatten answers: { "1": { name, answer, type, ... }, ... }
        // We extract just { question_text: answer_value } for the agent's convenience.
        answers: Object.fromEntries(
          Object.values(s.answers || {})
            .filter((a) => a.answer != null && a.answer !== "")
            .map((a) => [a.text || a.name || a.qid, a.prettyFormat || a.answer]),
        ),
      })),
    };
  },

  async get_jotform_submission({ submission_id }) {
    const apiKey = process.env.JOTFORM_API_KEY;
    if (!apiKey) return { error: "JOTFORM_API_KEY not configured" };
    if (!submission_id) return { error: "submission_id required" };
    const res = await fetch(`https://api.jotform.com/submission/${submission_id}?apiKey=${apiKey}`);
    const data = await res.json();
    if (data.responseCode !== 200) {
      return { error: `JotForm ${data.responseCode}: ${data.message || JSON.stringify(data)}` };
    }
    const s = data.content || {};
    return {
      id: s.id,
      form_id: s.form_id,
      created_at: s.created_at,
      status: s.status,
      answers: Object.fromEntries(
        Object.values(s.answers || {})
          .filter((a) => a.answer != null && a.answer !== "")
          .map((a) => [a.text || a.name || a.qid, a.prettyFormat || a.answer]),
      ),
    };
  },

  // ---------- DocuSeal ----------
  // Send contracts and check signature status. Auth via DOCUSEAL_API_KEY env
  // var. The bot uses one configured template (DOCUSEAL_DEFAULT_TEMPLATE_ID)
  // by default — pass template_id to override.

  async create_docuseal_submission({ person_id, template_id = null, send_email = true, confirmed = false }) {
    const apiKey = process.env.DOCUSEAL_API_KEY;
    if (!apiKey) return { error: "DOCUSEAL_API_KEY not configured" };
    const tmplId = template_id || process.env.DOCUSEAL_DEFAULT_TEMPLATE_ID;
    if (!tmplId) return { error: "template_id required (or set DOCUSEAL_DEFAULT_TEMPLATE_ID env var)" };
    if (!person_id) return { error: "person_id required" };

    const personRes = await ncGet(
      `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(`(Id,eq,${person_id})`)}&limit=1`
    );
    if (!personRes.list || !personRes.list[0]) return { error: `Person ${person_id} not found` };
    const p = personRes.list[0];
    const name = p.Name;
    const email = p["Primary email"];
    if (!email) return { error: `Person ${person_id} has no Primary email` };

    if (!confirmed) {
      return pendingConfirmation(
        `Send DocuSeal contract (template ${tmplId}) to ${name} <${email}>${send_email ? " — DocuSeal WILL email them the signing link" : " — no email, returned link must be sent manually"}`,
        { person_id, template_id: tmplId, send_email, confirmed: true }
      );
    }

    const res = await fetch("https://api.docuseal.com/submissions", {
      method: "POST",
      headers: { "X-Auth-Token": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        template_id: Number(tmplId),
        send_email,
        submitters: [{ email, name, role: "Signer" }],
      }),
    });
    const data = await res.json();
    if (!res.ok) return { error: `DocuSeal ${res.status}: ${data.error || JSON.stringify(data)}` };
    // DocuSeal returns an array of submitters when a submission is created.
    const first = Array.isArray(data) ? data[0] : data;
    return {
      ok: true,
      submission_id: first.submission_id || first.id,
      submitter_id: first.id,
      email,
      name,
      signing_url: first.embed_src || first.slug || null,
      status: first.status || "pending",
      email_sent: send_email,
    };
  },

  async get_docuseal_submission({ submission_id }) {
    const apiKey = process.env.DOCUSEAL_API_KEY;
    if (!apiKey) return { error: "DOCUSEAL_API_KEY not configured" };
    if (!submission_id) return { error: "submission_id required" };
    const res = await fetch(`https://api.docuseal.com/submissions/${submission_id}`, {
      headers: { "X-Auth-Token": apiKey },
    });
    const data = await res.json();
    if (!res.ok) return { error: `DocuSeal ${res.status}: ${data.error || JSON.stringify(data)}` };
    return {
      submission_id: data.id,
      template_id: data.template?.id,
      status: data.status,
      audit_log_url: data.audit_log_url,
      submitters: (data.submitters || []).map((s) => ({
        id: s.id,
        email: s.email,
        name: s.name,
        status: s.status,
        sent_at: s.sent_at,
        opened_at: s.opened_at,
        completed_at: s.completed_at,
      })),
    };
  },

  // ---------- Prompt-body editing (NocoDB-backed) ----------
  // The substantive part of Compass's own system prompt lives in NocoDB so
  // Yohan/Valerie can edit it from Slack ("stop using emojis", "always log
  // touchpoints in past tense", etc.) without a code change. See KERNEL_BOTTOM
  // "PROMPT EDITING" section. Append-only: every edit writes a new versioned
  // row to compass_prompt; nothing is overwritten, so history doubles as the
  // audit trail and the revert path.

  async view_prompt_body() {
    return {
      version: cachedPromptVersion,
      updated_by: cachedPromptUpdatedBy,
      updated_at: cachedPromptUpdatedAt,
      length: (cachedPromptBody || "").length,
      body: cachedPromptBody || SEED_PROMPT_BODY,
      persistent: !!PROMPT_TABLE.tableId,
      note: PROMPT_TABLE.tableId
        ? "Operator-managed body. Edit via edit_prompt_body or replace_prompt_body."
        : "compass_prompt table not available — showing the in-code SEED fallback. Edits cannot be persisted in this environment.",
    };
  },

  async edit_prompt_body({ old_string, new_string, reason, updated_by, confirmed = false }) {
    if (typeof old_string !== "string" || old_string.length === 0) {
      return { error: "old_string is required and must be non-empty" };
    }
    if (typeof new_string !== "string") {
      return { error: "new_string is required (use empty string to delete the matched section)" };
    }
    const current = cachedPromptBody || SEED_PROMPT_BODY;
    const idx = current.indexOf(old_string);
    if (idx === -1) {
      return { error: "old_string not found in current prompt body. Use view_prompt_body to see exact text. Whitespace and punctuation must match exactly." };
    }
    if (current.indexOf(old_string, idx + old_string.length) !== -1) {
      return { error: "old_string is not unique in the prompt body — found multiple matches. Provide a longer surrounding context to disambiguate." };
    }
    const proposed = current.slice(0, idx) + new_string + current.slice(idx + old_string.length);
    if (!confirmed) {
      return pendingConfirmation(
        `Edit operator-managed prompt body (v${cachedPromptVersion} → v${cachedPromptVersion + 1}). Reason: ${reason || "(none given)"}. Diff:\n${diffPreview(old_string, new_string)}`,
        { old_string, new_string, reason, updated_by, confirmed: true }
      );
    }
    const { version } = await savePromptBody({ newBody: proposed, reason, updatedBy: updated_by });
    return {
      ok: true,
      version,
      length: proposed.length,
      note: "Prompt body updated. The new version is live for subsequent /run calls.",
    };
  },

  async replace_prompt_body({ new_body, reason, updated_by, confirmed = false }) {
    if (typeof new_body !== "string" || new_body.length === 0) {
      return { error: "new_body is required and must be non-empty" };
    }
    const current = cachedPromptBody || SEED_PROMPT_BODY;
    if (!confirmed) {
      const sizeChange = new_body.length - current.length;
      return pendingConfirmation(
        `FULL REWRITE of operator-managed prompt body (v${cachedPromptVersion} → v${cachedPromptVersion + 1}). Old: ${current.length} chars. New: ${new_body.length} chars (${sizeChange >= 0 ? "+" : ""}${sizeChange}). Reason: ${reason || "(none given)"}. First 400 chars of new body:\n${new_body.slice(0, 400)}${new_body.length > 400 ? "\n…[truncated]" : ""}`,
        { new_body, reason, updated_by, confirmed: true }
      );
    }
    const { version } = await savePromptBody({ newBody: new_body, reason, updatedBy: updated_by });
    return {
      ok: true,
      version,
      length: new_body.length,
      note: "Prompt body fully replaced. The new version is live for subsequent /run calls.",
    };
  },

  async view_prompt_history({ limit = 10 } = {}) {
    if (!PROMPT_TABLE.tableId) {
      return { error: "compass_prompt table not available — no history in this environment" };
    }
    const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
    const data = await ncGet(`/api/v2/tables/${PROMPT_TABLE.tableId}/records?limit=${cap}&sort=-Version&fields=Id,Version,UpdatedBy,Reason,CreatedAt,UpdatedAt`);
    return {
      count: data.list?.length || 0,
      current_version: cachedPromptVersion,
      versions: (data.list || []).map((r) => ({
        version: r.Version,
        updated_by: r.UpdatedBy,
        updated_at: r.UpdatedAt || r.CreatedAt,
        reason: r.Reason,
      })),
      note: "To restore a specific version, call revert_prompt_body with that version number.",
    };
  },

  async revert_prompt_body({ version, reason, updated_by, confirmed = false }) {
    if (!PROMPT_TABLE.tableId) {
      return { error: "compass_prompt table not available — cannot revert in this environment" };
    }
    const target = parseInt(version, 10);
    if (!Number.isFinite(target) || target < 1) {
      return { error: "version must be a positive integer (use view_prompt_history to find one)" };
    }
    if (target === cachedPromptVersion) {
      return { error: `version ${target} is already the current version — no revert needed` };
    }
    const data = await ncGet(`/api/v2/tables/${PROMPT_TABLE.tableId}/records?where=${encodeURIComponent(`(Version,eq,${target})`)}&limit=1`);
    if (!data.list?.length) {
      return { error: `version ${target} not found in compass_prompt history` };
    }
    const targetBody = data.list[0].Body || "";
    if (!targetBody) {
      return { error: `version ${target} has empty Body — cannot revert to it` };
    }
    if (!confirmed) {
      return pendingConfirmation(
        `Revert operator-managed prompt body to v${target} (currently v${cachedPromptVersion}). Reason: ${reason || "(none given)"}. This will write a new row v${cachedPromptVersion + 1} whose body matches v${target}; v${cachedPromptVersion} stays in history.`,
        { version: target, reason, updated_by, confirmed: true }
      );
    }
    const fullReason = `revert to v${target}${reason ? ` — ${reason}` : ""}`;
    const { version: newVersion } = await savePromptBody({ newBody: targetBody, reason: fullReason, updatedBy: updated_by });
    return {
      ok: true,
      version: newVersion,
      reverted_to: target,
      length: targetBody.length,
      note: `Prompt body reverted. v${newVersion} is now live and matches v${target}.`,
    };
  },

  // ---------- Self-extension (RETIRED) ----------
  // propose_new_tool / delete_generated_tool / loadGeneratedTools used to live
  // here. They were retired May 2026 after the CSV-import chaos. Reasons:
  //   1. Generated tools lived on Render's ephemeral disk and died on every
  //      deploy, so each "Compass built itself a tool!" moment was a leaky
  //      bucket — the next deploy started over.
  //   2. The agent reached for it as a first resort instead of asking, accreting
  //      bespoke JS that nobody reviewed.
  //   3. The legitimate "I need to handle a new file format / one-off data
  //      shape" cases are now covered by the code_execution tool (Python
  //      sandbox), which is reviewed by Anthropic and doesn't litter our disk.
  // If a *durable* new capability is genuinely needed, add a normal tool to
  // this file via PR — same as every other tool here.
};

// ---------- Tool definitions for Claude ----------

const tools = [
  // Server-side tool search: lets Claude discover deferred tools via natural-language search.
  // Keeps the always-loaded set small (~5 tools) and surfaces specialized tools on-demand.
  // See https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
  {
    type: "tool_search_tool_bm25_20251119",
    name: "tool_search_tool_bm25",
  },
  // Server-side Python sandbox. When a user uploads a CSV / Excel / PDF / JSON,
  // or any time the agent needs to slice/aggregate data ad-hoc, run Python here
  // instead of asking for a new bespoke JS tool. Files referenced via
  // container_upload blocks (Files API) land in /mnt/user-data/uploads/.
  // See https://docs.claude.com/en/docs/agents-and-tools/tool-use/code-execution-tool
  {
    type: "code_execution_20250825",
    name: "code_execution",
  },
  {
    name: "lookup_person",
    description:
      "Search the People table for a person. Use type='email' for exact email match (preferred when an email is in the transcript), or type='name' for fuzzy name match. Returns up to 10 candidates with their stages and identifying info. ALWAYS lookup before create to avoid duplicates.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Email address or name fragment" },
        type: { type: "string", enum: ["email", "name"] },
      },
      required: ["query", "type"],
    },
  },
  {
    name: "lookup_cohort",
    description:
      "Find a cohort by exact name (e.g. 'May 9 2026', 'May 10 2026'). When to use: ONLY when you need to verify a cohort exists before referencing it elsewhere. When NOT to use: don't call this before create_person — that tool already does cohort lookup internally.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "create_person",
    description:
      "Create a new person record and optionally link to a cohort. Default Status='Onboarding', Owner='Valerie'. Source one of: Direct, Referral, Workshop, Website, Social, Other (case-insensitive). Use ONLY after lookup_person confirms no existing match.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        primary_email: { type: "string", description: "lowercase preferred" },
        primary_phone: { type: "string", description: "E.164 if possible" },
        cohort_name: { type: "string", description: "Exact cohort name e.g. 'May 9 2026'. Null if unspecified." },
        source: { type: "string", enum: ["Direct", "Referral", "Workshop", "Website", "Social", "Other"] },
        notes: { type: "string" },
        room: { type: "string", description: "Sub-cohort/room name if mentioned" },
        payment_status: {
          type: "string",
          enum: ["Unpaid", "Deposit paid", "On payment plan", "Paid in full", "Scholarship", "Refunded"],
        },
        payment_risk: { type: "string", enum: ["Low", "Medium", "High"] },
        amount_total: { type: "number", description: "Total program fee in dollars" },
        amount_paid: { type: "number", description: "Amount paid so far in dollars" },
        next_action: { type: "string", description: "Short note on what's needed next" },
      },
      required: ["name"],
    },
  },
  {
    name: "bulk_import_people",
    description:
      "Create or update many People records in ONE tool call. Strongly preferred over calling create_person individually for any import of more than ~3 people — saves tokens (one big arg block dedupes shared fields like cohort_name and owner) and reduces iteration count. Idempotency carries through from create_person: existing emails are detected and returned with status='already_existed' rather than duplicated. CONFIRMATION GATED: first call returns a preview; second call with confirmed:true executes. Caps at 100 people per call — split larger imports into batches.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        people: {
          type: "array",
          description: "Array of person objects. Each accepts the same fields as create_person (name, primary_email, primary_phone, cohort_name, source, notes, room, payment_status, payment_risk, amount_total, amount_paid, next_action). Per-row fields override the default_* values.",
          items: { type: "object" },
        },
        default_cohort_name: { type: "string", description: "Cohort to link all people to (each row can override with its own cohort_name)." },
        default_source: { type: "string", enum: ["Direct", "Referral", "Workshop", "Website", "Social", "Other"], description: "Source value applied to people who don't have one set explicitly. Default: Other." },
        default_owner: { type: "string", enum: ["Yohan", "Valerie", "Nathan"], description: "Owner applied to all rows lacking one. If null, create_person's default (Valerie) applies." },
        default_status: { type: "string", enum: ["Unpaid", "Deposit paid", "On payment plan", "Paid in full", "Scholarship", "Refunded"], description: "Payment status applied to people who don't have one explicitly." },
        default_room: { type: "string", description: "Room/pod applied to people who don't have one explicitly." },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has explicitly approved the previewed import." },
      },
      required: ["people"],
    },
  },
  {
    name: "update_payment",
    description:
      "Update payment-related fields for a person in one call. When to use: user mentions payment activity (deposit received, paid in full, on monthly plan, refund, scholarship). 'Amount owing' is auto-computed. When NOT to use: for stage checkboxes related to payment (use toggle_stage with deposit_paid/payment_plan_active/paid_in_full instead) — though both can be needed together. CONFIRMATION GATED: first call with proposed values returns a preview; show it to the user, get explicit go-ahead, then re-call with confirmed: true.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number" },
        payment_status: {
          type: "string",
          enum: ["Unpaid", "Deposit paid", "On payment plan", "Paid in full", "Scholarship", "Refunded"],
        },
        payment_risk: { type: "string", enum: ["Low", "Medium", "High"] },
        amount_total: { type: "number" },
        amount_paid: { type: "number" },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has confirmed the previewed change." },
      },
      required: ["person_id"],
    },
  },
  {
    name: "draft_welcome_email",
    description:
      "Create a Gmail draft using the standard 9-week training welcome email template (with cohort prep instructions, JotForm link, support info). When to use: user says 'send the welcome email' or 'draft the welcome email' for a 9-week participant. Drafts go to Gmail for the sender to review. When NOT to use: for one-off / non-template emails (use draft_email).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number", description: "NocoDB Person record Id" },
      },
      required: ["person_id"],
    },
  },
  {
    name: "draft_email",
    description:
      "Create a Gmail draft of an arbitrary one-off email. When to use: follow-ups, replies, intros, anything that doesn't match the welcome-email template. Provide body_html for rich content or body_text for plain. The sender reviews the draft and clicks send. When NOT to use: for the standard 9-week welcome email (use draft_welcome_email — preserves Valerie's branded design).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        to_email: { type: "string" },
        to_name: { type: "string", description: "Recipient's name for friendly To: header" },
        subject: { type: "string" },
        body_html: { type: "string", description: "HTML body. Mutually exclusive with body_text." },
        body_text: { type: "string", description: "Plain text body. Mutually exclusive with body_html." },
      },
      required: ["to_email", "subject"],
    },
  },
  {
    name: "list_people",
    description:
      "List/filter People records. Use this for 'who's onboarding right now', 'show me May 9 cohort', 'who has incomplete onboarding', 'all of Valerie's people', etc. All filters are optional and combine with AND. Returns up to 100 people with their key fields and which stages are completed/pending.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["Lead", "Prospect", "Onboarding", "Active", "Completed", "Alumni", "Paused"] },
        cohort_name: { type: "string", description: "Exact cohort name e.g. 'May 9 2026'" },
        payment_status: { type: "string", enum: ["Unpaid", "Deposit paid", "On payment plan", "Paid in full", "Scholarship", "Refunded"] },
        owner: { type: "string", enum: ["Yohan", "Valerie", "Nathan"] },
        has_pending_stage: { type: "boolean", description: "true = anyone with at least one of stages 1-8 incomplete; false = anyone fully onboarded" },
        limit: { type: "number", description: "Max rows (default 25, max 100)" },
      },
      required: [],
    },
  },
  {
    name: "list_clickup_tasks",
    description:
      "List ClickUp tasks, optionally filtered by list, cohort, status, or text search. When to use: 'show me recent tasks', 'what's outstanding', 'find tasks about Sarah', 'any open follow-ups'. Pass cohort='May 9 2026' (or any cohort/program name fragment) to scope to that cohort's lists — discovered dynamically, no hardcoded IDs. With no list_id/list_ids/cohort, defaults to the Daily Task Board only. When NOT to use: for People/participant queries (use list_people), for agent activity (use list_recent_actions).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "Specific ClickUp list ID. Use when you already know the exact list." },
        list_ids: { type: "array", items: { type: "string" }, description: "Multiple ClickUp list IDs to search at once." },
        cohort: { type: "string", description: "Cohort/program name fragment (e.g. 'May 9 2026', 'July 35-day', 'Daily Task Board'). Resolves to list IDs via discovery — preferred over hardcoded list_id when the user names a cohort." },
        search: { type: "string", description: "Case-insensitive substring match on task name/description" },
        statuses: { type: "array", items: { type: "string" }, description: "ClickUp status names like 'to do', 'in progress'" },
        include_closed: { type: "boolean", description: "Include closed tasks (default false)" },
        limit: { type: "number", description: "Max tasks (default 25, max 50)" },
      },
      required: [],
    },
  },
  {
    name: "find_clickup_list",
    description:
      "Find ClickUp list IDs by name fragment via dynamic discovery (no hardcoded IDs). When to use: you need a specific list's ID and don't have it (e.g. 'is there a list for the July cohort?', 'find the Pre-Program list', 'what enrolment lists exist?'). Returns matches with id + name + full hierarchy path. Cached 1 hour. When NOT to use: list_clickup_tasks's `cohort` param can resolve names internally — only call find_clickup_list separately if you want to inspect what's available before searching.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name fragment to match (e.g. 'May 9 People', '35-day onboarded'). Case-insensitive, fuzzy multi-word — every token must appear in name or path." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent_actions",
    description:
      "Query the Agent actions audit log — what the AGENT has been doing. When to use: 'what did you do today', 'show me recent runs', 'what was your last action for Sarah', 'any failed runs lately'. When NOT to use: for participants/people queries (use list_people — different table). The audit log records agent runs, not participants.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max rows to return (default 10, max 50)" },
        since_hours: { type: "number", description: "Only show actions from the last N hours (e.g. 24 for today)" },
        source: { type: "string", enum: ["Slack voice", "Slack text", "API call", "Other"] },
        success_only: { type: "boolean", description: "true = only successful runs, false = only failures" },
      },
      required: [],
    },
  },
  {
    name: "delete_clickup_task",
    description: "Delete a ClickUp task by its ID. When to use: a task is no longer relevant, was created in error, or the user explicitly asks to delete it. When NOT to use: to mark a task complete (let the user close it in ClickUp). CONFIRMATION GATED: first call returns a preview; show it to the user, get explicit go-ahead, then re-call with confirmed: true.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The ClickUp task ID (visible in the task URL after /t/)" },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has confirmed the deletion." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "create_clickup_task",
    description:
      "Create a task in ClickUp. When to use: tracking a follow-up action ('remind me to follow up with X'), a project step, a question for the team (prefix title with ❓), or a human task. Default list is the May 9-week 👥People list; override with list_id for general tasks. Priority: 1=urgent, 2=high, 3=normal, 4=low. Description is rendered as markdown — use **bold**, bullet lists, and real newlines (the actual newline character, not the two-character escape \\n).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task title (concise)" },
        description: { type: "string", description: "Markdown rendered (bold, lists, headings). Use real newlines for paragraph breaks; the server normalizes literal \\n escape sequences but real newlines render reliably." },
        priority: { type: "number", enum: [1, 2, 3, 4] },
        due_date: { type: "string", description: "ISO 8601 date or datetime, e.g. '2026-05-12' or '2026-05-12T15:00:00+10:00'" },
        list_id: { type: "string", description: "Specific ClickUp list ID. Omit to use default." },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "Who the task is FOR. Pass friendly names (e.g. ['nathan'], ['yohan'], ['valerie']) or numeric ClickUp user IDs. Names resolve to ClickUp users at runtime via the workspace member list. Omit if no specific owner. The unresolved_assignees field in the result tells you if any name didn't match.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_clickup_task",
    description:
      "Update an existing ClickUp task. When to use: change assignees ('reassign to me'), edit name/description/priority/due date/status, or add/remove people. When NOT to use: to mark complete (let the user close it), to delete (use delete_clickup_task). Pass only the fields you want to change. Assignees use friendly names ('nathan', 'yohan', 'valerie') or numeric IDs. Use add_assignees + remove_assignees rather than replacing — ClickUp's API requires the add/remove pattern for assignee changes.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "ClickUp task ID (after /t/ in the URL)" },
        name: { type: "string", description: "New task title" },
        description: { type: "string", description: "New markdown body. Use real newlines." },
        priority: { type: "number", enum: [1, 2, 3, 4], description: "1=urgent, 2=high, 3=normal, 4=low" },
        due_date: { type: "string", description: "ISO 8601 date or datetime" },
        status: { type: "string", description: "ClickUp status name (e.g. 'in progress', 'complete')" },
        add_assignees: {
          type: "array",
          items: { type: "string" },
          description: "Names or numeric IDs to ADD as assignees.",
        },
        remove_assignees: {
          type: "array",
          items: { type: "string" },
          description: "Names or numeric IDs to REMOVE.",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "update_person",
    description:
      "Update arbitrary fields on an existing person record using NocoDB column titles as keys. When to use: changing name, email, phone, status, owner, source, tags, timezone, or notes on an existing record. When NOT to use: for payment fields (use update_payment instead), for stage checkboxes (use toggle_stage), for cohort linking (use link_person_to_cohort).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number" },
        fields: {
          type: "object",
          description:
            "Object mapping NocoDB column titles to new values. Allowed: Name, 'Primary email', 'Primary phone', Status, Owner, Source, Tags, Timezone, Notes",
        },
      },
      required: ["person_id", "fields"],
    },
  },
  {
    name: "toggle_stage",
    description:
      "Set an onboarding stage checkbox for a person. The 10 stages don't all happen linearly — most are independent, so changing one stage usually doesn't affect others. " +
      "NARROW CASCADE: only TRUE logical dependencies are cascaded automatically: " +
      "  • welcome_email_sent=true → also marks deposit_paid=true (welcome email is sent right after deposit on the call) " +
      "  • form_submitted=true → also marks welcome_email_sent=true (form link lives inside the welcome email) " +
      "  • contract_signed=true → also marks contract_sent=true (can't sign what wasn't sent) " +
      "  • calendar_invites_accepted=true → also marks calendar_invites_sent=true " +
      "  • paid_in_full=true → also marks deposit_paid=true " +
      "  • inverses (e.g. deposit_paid=false → unmarks welcome_email_sent and everything that depends on it) " +
      "All other stages are independent — marking calendar_invites_sent does NOT mark onboarding_call_done. The tool returns 'cascaded_stages' showing what (if anything) was also affected.",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number" },
        stage: {
          type: "string",
          enum: [
            "onboarding_call_done",
            "deposit_paid",
            "welcome_email_sent",
            "form_submitted",
            "contract_sent",
            "contract_signed",
            "calendar_invites_sent",
            "calendar_invites_accepted",
            "payment_plan_active",
            "paid_in_full",
          ],
        },
        value: { type: "boolean", description: "true = mark done; false = unmark" },
      },
      required: ["person_id", "stage", "value"],
    },
  },
  {
    name: "add_note",
    description:
      "Append a timestamped note to a person's Notes field. When to use: freeform observations about a person ('mentioned travelling next week', 'has back injury', 'asked about scheduling'). When NOT to use: for communications/touchpoints (use log_touchpoint), for payment changes (use update_payment), for stage progress (use toggle_stage).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number" },
        note: { type: "string" },
      },
      required: ["person_id", "note"],
    },
  },
  {
    name: "link_person_to_cohort",
    description: "Link an existing person to an additional cohort. When to use: a returning participant joining a second cohort, or correcting a cohort assignment. When NOT to use: for new participants (create_person already handles cohort linking via cohort_name parameter).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number" },
        cohort_name: { type: "string" },
      },
      required: ["person_id", "cohort_name"],
    },
  },
  {
    name: "log_touchpoint",
    description:
      "Log a Touchpoint record (audit trail of communications). When to use: user describes a real communication event with a participant — they emailed you, you called them, WhatsApp message arrived, etc. When NOT to use: for general agent activity (that's auto-logged separately), for freeform notes about a person (use add_note). Touchpoints represent communications, not observations.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short summary line" },
        content: { type: "string", description: "Full content if relevant" },
        channel: {
          type: "string",
          enum: ["Email", "WhatsApp", "Slack", "Phone", "SMS", "In-person", "Calendar", "Other"],
        },
        direction: { type: "string", enum: ["Inbound", "Outbound", "Internal"] },
        person_id: { type: "number" },
      },
      required: ["summary"],
    },
  },
  {
    name: "ask_for_clarification",
    description:
      "Terminate the agent loop and ask the user a question. When to use: ONLY when intent is genuinely ambiguous and you cannot proceed without an answer (e.g. 'reach out to Daniel' but multiple Daniels exist with no disambiguator). When NOT to use: when you can act with reasonable confidence, or when the question is a non-blocking decision worth tracking (use create_clickup_task with ❓ prefix instead).",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "stay_silent",
    description: "Terminate the agent loop WITHOUT posting any reply to Slack. When to use: the triggering message contains 'compass' but clearly isn't addressed to you ('we need a moral compass', 'lost my compass app on phone', 'compass directional reading'), OR you have nothing genuinely useful to add to a conversation you've been pulled into. The user gets no notification, no message — Compass simply observes and stays out. When NOT to use: when the user is asking you something, even if you can't fully complete the task. Always prefer ask_for_clarification or a brief reply over staying silent if the user is asking you anything. Pass `reason` for the audit trail.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why you're staying silent. Captured in the audit log only — never sent to the user." },
      },
      required: ["reason"],
    },
  },
  {
    name: "list_skills",
    description:
      "List available Skills (workflow playbooks, voice/style guides, process docs). When to use: at the start of complex multi-step work to discover relevant guidance, or when the user references an established process. Skills hold knowledge that doesn't fit in the system prompt and loads on-demand. Returns each skill's name + one-sentence description.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "load_skill",
    description:
      "Load the full content of a named Skill. When to use: after list_skills surfaced a relevant skill and you want the full playbook/guide to inform your next steps. Skill content is markdown — read it and follow its guidance.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Exact skill name from list_skills" } },
      required: ["name"],
    },
  },

  // Generic NocoDB CRUD — schema-altering tools require explicit user confirmation.
  {
    name: "list_tables",
    description: "List all tables in the NocoDB base. When to use: user asks 'what tables do we have?' or you need to find a table_id before adding a column or bulk-creating records. Returns id, title, table_name, description for each.",
    defer_loading: true,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_table",
    description: "Create a new NocoDB table in the base. When to use: ONLY after explicit user confirmation (use ask_for_clarification first if unsure). Common type values: SingleLineText, LongText, Number, Decimal, Checkbox, Date, DateTime, Email, PhoneNumber, URL, JSON. Includes Title and Id columns automatically. When NOT to use: speculatively, or when an existing table could fit.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Table name (e.g. 'Invoices', 'Vendors')." },
        columns: {
          type: "array",
          description: "Array of {name, type} objects. type is a NocoDB UI data type — defaults to SingleLineText.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string", description: "SingleLineText, LongText, Number, Decimal, Checkbox, Date, DateTime, Email, PhoneNumber, URL, JSON" },
            },
            required: ["name"],
          },
        },
      },
      required: ["name", "columns"],
    },
  },
  {
    name: "add_table_column",
    description: "Add a column to an existing NocoDB table. When to use: ONLY after explicit user confirmation. Use list_tables to find the table_id. For SingleSelect / MultiSelect you MUST pass options[] — silent degradation to free text is refused.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        table_id: { type: "string" },
        name: { type: "string", description: "Column name (will also be the title)." },
        type: {
          type: "string",
          description: "NocoDB UI data type. Common: SingleLineText, LongText, Number, Decimal, Checkbox, Date, DateTime, Email, PhoneNumber, URL, JSON, SingleSelect, MultiSelect.",
        },
        options: {
          type: "array",
          description: "REQUIRED when type is SingleSelect or MultiSelect. Array of value strings, e.g. [\"Foundations\", \"Mastery\"]. Omit for other types.",
          items: { type: "string" },
        },
      },
      required: ["table_id", "name", "type"],
    },
  },
  {
    name: "add_select_options",
    description: "Append new values to an existing SingleSelect or MultiSelect column. When to use: a CSV import surfaces a value that isn't in the current option list (e.g. Source=\"Podcast\" when the column only allows Direct/Referral/etc.). CONFIRMATION GATED — first call returns a preview, second call with confirmed:true commits. Use get_table_meta or query the column metadata to find column_id.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        table_id: { type: "string" },
        column_id: { type: "string", description: "NocoDB column id (not the title)." },
        new_options: { type: "array", items: { type: "string" } },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has explicitly approved the new values." },
      },
      required: ["table_id", "column_id", "new_options"],
    },
  },
  {
    name: "bulk_create_records",
    description: "Bulk-insert records into a NocoDB table. When to use: importing CSV-like data, batch-creating from a list of items the user dictated. Up to 100 records per call. Field keys must match the table's column titles exactly. When NOT to use: for People records — use create_person which has stage cascade + cohort linking; for single-record creates of any kind, use the specific tool if one exists.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        table_id: { type: "string" },
        records: {
          type: "array",
          description: "Array of {column_title: value, ...} objects. Max 100 per call.",
          items: { type: "object" },
        },
      },
      required: ["table_id", "records"],
    },
  },
  {
    name: "query_table",
    description: "Read records from any NocoDB table with filter / sort / fields / pagination. When to use: ad-hoc questions across data the agent doesn't have a specialized lookup for ('show me touchpoints from this week', 'list agent actions where success was false', 'find rows in the Invoices table for May'). Read-only. Use list_tables first to discover table_id. PREFER list_people / lookup_person / list_clickup_tasks when those fit — they understand their schemas. 'where' is NocoDB filter syntax: '(Name,like,Joseph%)', '(Status,eq,Open)~and(Amount,gt,500)'. 'sort' is column name or '-column' for descending.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        table_id: { type: "string", description: "NocoDB table ID (use list_tables to discover)." },
        where: { type: "string", description: "NocoDB filter syntax. Examples: '(Name,like,Joseph%)', '(Stage,eq,Onboarding)~and(Amount,gt,500)'." },
        fields: { type: "array", items: { type: "string" }, description: "Subset of column names to return. Omit for all." },
        sort: { type: "string", description: "Column name (asc) or '-column' (desc)." },
        limit: { type: "number", description: "Max rows. Default 25, hard cap 200." },
        offset: { type: "number", description: "Skip this many rows. For pagination." },
      },
      required: ["table_id"],
    },
  },
  {
    name: "bulk_update_records",
    description: "Bulk-update records in any NocoDB table by Id. When to use: applying a change across many rows at once ('mark these 5 people as paid', 'set status to Archived for these tasks'). Each record must include 'Id' plus the fields to set. PREFER specialized tools (update_person, update_payment, etc.) when one fits. CONFIRMATION GATED: first call returns a preview, second call with confirmed: true executes.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        table_id: { type: "string" },
        records: {
          type: "array",
          description: "Array of {Id, column_title: value, ...} objects. 'Id' required on every record. Max 100 per call.",
          items: { type: "object" },
        },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has confirmed the previewed update." },
      },
      required: ["table_id", "records"],
    },
  },
  {
    name: "delete_records",
    description: "Delete records from any NocoDB table by Id. Irreversible. PREFER soft-delete approaches (set a status field) where possible. CONFIRMATION GATED: first call returns a preview listing the affected Ids, second call with confirmed: true executes.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        table_id: { type: "string" },
        record_ids: { type: "array", items: { type: "number" }, description: "List of NocoDB record Ids to delete. Max 100 per call." },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has confirmed the previewed deletion." },
      },
      required: ["table_id", "record_ids"],
    },
  },
  {
    name: "find_person_by_phone",
    description: "Find People records matching a phone number. When to use: voice transcript mentions a phone number (e.g. 'plus six one four hundred...' becomes '+61 400...'). Tries the query as-given, with non-digits stripped, with/without +61 country code, and last-7-digits as a fallback. When NOT to use: use lookup_person for email/name searches.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Phone number in any format. Will try several normalisations." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_person_full",
    description: "Fetch one person's full state in a single call: identity, payment, all 10 onboarding stages as booleans, cohort, owner, notes, last touch. When to use: you need the complete picture of a person (e.g. 'where is Sarah at?'). Saves chaining lookup_person + a follow-up record fetch. When NOT to use: for searching across multiple people (use list_people / lookup_person).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: { person_id: { type: "number" } },
      required: ["person_id"],
    },
  },
  {
    name: "create_calendar_event",
    description: "Create a native Google Calendar event on Yohan's calendar with the participant as an attendee. PREFERRED over draft_calendar_invite_email when scheduling — the event lands on Yohan's calendar so he can see it alongside other commitments. By DEFAULT does NOT send an invite email (send_invites=false) — just creates the event silently. Yohan can then review the calendar entry and either send invites manually from Calendar UI, or you can call again with send_invites=true if user explicitly says 'send the invite'. Use check_calendar_availability first if there's any chance of conflict. CONFIRMATION GATED: first call returns a preview of the event; show it to the user, get explicit go-ahead, then re-call with confirmed: true.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number", description: "NocoDB People record ID. Looked up to get name + email for the attendee." },
        datetime: { type: "string", description: "ISO 8601 datetime for the call start. Include timezone (e.g. '2026-05-13T15:00:00+10:00')." },
        duration_minutes: { type: "number", description: "Default 45." },
        title: { type: "string", description: "Default: 'UST Onboarding Call with [Name]'." },
        description: { type: "string", description: "Default: short onboarding description." },
        location: { type: "string", description: "Optional. URL (Zoom/Meet link) or physical address." },
        send_invites: { type: "boolean", description: "Default false. Set true ONLY when the user explicitly confirms they want Google to email the invite to the attendee. Otherwise the event sits on Yohan's calendar quietly, ready for him to send manually." },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has confirmed the previewed event." },
      },
      required: ["person_id", "datetime"],
    },
  },
  {
    name: "check_calendar_availability",
    description: "Check Yohan's primary calendar for busy ranges in a window. When to use: before suggesting a time slot for an onboarding call ('is Tuesday 3pm free?'). Returns busy=[] if free, otherwise a list of busy intervals. Uses Google's freeBusy API — only returns busy ranges, not event titles, so it doesn't expose private details.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        start: { type: "string", description: "ISO 8601 window start. Include timezone." },
        end: { type: "string", description: "ISO 8601 window end. Include timezone." },
        calendar_id: { type: "string", description: "Default 'primary' (Yohan's main calendar). Override only if asked." },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "update_calendar_event",
    description: "Patch an existing calendar event. Use when the user wants to reschedule ('move Joseph's call to Thursday 4pm') or amend ('add the Zoom link to Lydia's invite'). Only the fields you pass get changed — others are preserved. If datetime changes without duration, the original duration is preserved. send_updates defaults to false; set true ONLY when the user wants Google to email attendees about the change. CONFIRMATION GATED.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Google Calendar event ID — from a prior create_calendar_event response or the user." },
        datetime: { type: "string", description: "New ISO 8601 start (with timezone). Omit to keep current start." },
        duration_minutes: { type: "number", description: "New duration. Omit to preserve original." },
        title: { type: "string", description: "New title." },
        description: { type: "string", description: "Replace the description." },
        location: { type: "string", description: "New location (URL or address)." },
        send_updates: { type: "boolean", description: "Default false. Set true to email attendees about the change." },
        confirmed: { type: "boolean", description: "Set true ONLY after the user confirms the previewed change." },
      },
      required: ["event_id"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "Cancel a calendar event. Use when the user wants to drop a scheduled call ('cancel Joseph's onboarding', 'Yohan can't make Thursday — kill that one'). send_cancellations defaults to false; set true ONLY when the user wants Google to email attendees a cancellation notice. CONFIRMATION GATED.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Google Calendar event ID." },
        send_cancellations: { type: "boolean", description: "Default false. Set true to email attendees a cancellation notice." },
        confirmed: { type: "boolean", description: "Set true ONLY after the user confirms." },
      },
      required: ["event_id"],
    },
  },
  {
    name: "draft_calendar_invite_email",
    description: "Fallback when create_calendar_event isn't appropriate: draft a Gmail with an .ics attachment. PREFER create_calendar_event when scheduling on Yohan's calendar (which is most of the time). Use this only when: user wants the invite to flow through Yohan's email-review process exactly like any other draft, or the recipient explicitly asked for an .ics file by email. Yohan reviews + sends from Gmail like any other draft.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number", description: "NocoDB People record ID. Looked up to get name + email." },
        datetime: { type: "string", description: "ISO 8601 datetime for the call start (e.g. '2026-05-13T14:00:00+10:00' or '2026-05-13T04:00:00Z'). Include timezone." },
        duration_minutes: { type: "number", description: "Default 45." },
        title: { type: "string", description: "Default: 'UST Onboarding Call with [Name]'." },
        description: { type: "string", description: "Default: short onboarding-call description." },
        location: { type: "string", description: "Optional. URL (Zoom/Meet link) or physical address." },
      },
      required: ["person_id", "datetime"],
    },
  },
  {
    name: "read_google_sheet",
    description: "Read values from a Google Sheet. When to use: user references / pastes / uploads a Google Sheet and wants you to act on its contents ('here's the spreadsheet of new participants — add them', 'check this sheet for who's missing a phone number'). Read-only. Accepts a bare spreadsheet ID or a full sheets.google.com URL — the tool extracts the ID. Range is A1 notation ('Sheet1!A1:D', 'A:F', or just a tab name 'Sheet1'). Omit range to default to the first tab. Returns rows as array-of-arrays; row 0 is typically the header row. Use bulk_create_records / create_person follow-ups to act on the data.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        sheet_id: { type: "string", description: "Spreadsheet ID (e.g. '1abc...') or full sheets.google.com URL." },
        range: { type: "string", description: "A1 notation ('Sheet1!A1:D', 'A:F', or 'Sheet1'). Omit for the first tab." },
        max_rows: { type: "number", description: "Truncate to this many rows. Default 500." },
      },
      required: ["sheet_id"],
    },
  },
  {
    name: "pin_knowledge",
    description: "Save a piece of long-term knowledge so future Compass sessions can find it. When to use: user shares a fact, link, process, or 'remember this' — e.g. 'this is where curriculum lives: <URL>', 'use this Zoom link for onboarding calls', 'cohort May 9 prep doc is here'. Pin both the topic (a short label) and the full content. Use tags for cross-cutting categories like 'curriculum', 'links', 'pricing'. When NOT to use: for People-record updates (use update_person), for tasks (use create_clickup_task), for personal voice/style (those are skills, edited in code).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Short label, 2-8 words. e.g. 'UST curriculum Drive folder', 'Default Zoom link for onboarding'." },
        content: { type: "string", description: "Full content / fact / URL / instructions. Markdown allowed." },
        tags: { type: "string", description: "Optional comma-separated tags for grouping (e.g. 'curriculum, links')." },
        added_by: { type: "string", description: "Slack display name of the person who shared the fact, if known. Optional." },
        source: { type: "string", description: "Optional context: where the user said it (Slack channel, thread link)." },
      },
      required: ["topic", "content"],
    },
  },
  {
    name: "recall_knowledge",
    description: "Search Compass's long-term knowledge for previously-pinned facts. When to use: user references something general that's not a person/cohort/task and might have been pinned earlier — 'where's the curriculum?', 'what was that Drive folder Valerie shared?', 'what Zoom link do we use?'. Searches both Topic and Content fields with a substring match. Pass a tag to narrow by category. Returns most-recently-pinned matches first.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against Topic and Content. Optional if tag provided." },
        tag: { type: "string", description: "Optional category filter (e.g. 'curriculum')." },
        limit: { type: "number", description: "Max results (default 5, max 25)." },
      },
      required: [],
    },
  },
  {
    name: "react_to_message",
    description: "Add an emoji reaction to a Slack message. Lighter-touch than replying — use for brief acknowledgements where a written reply would be noise ('thanks', 'got it', 'ok'). The triggering message's channel and message_ts are visible at the top of the transcript under '## Slack message reference' — pass those values. Common emoji names: thumbsup, eyes, white_check_mark, raised_hands, pray, sparkles, heart. Use the emoji name without colons.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        emoji: { type: "string", description: "Slack emoji name without colons, e.g. 'thumbsup', 'eyes', 'white_check_mark'." },
        channel: { type: "string", description: "Slack channel ID — read from '## Slack message reference' in the transcript." },
        message_ts: { type: "string", description: "Slack message timestamp — read from '## Slack message reference'." },
      },
      required: ["emoji", "channel", "message_ts"],
    },
  },
  {
    name: "send_channel_message",
    description: "Post a NEW message into a Slack channel. Use this when the user asks you to drop something into a specific channel ('post the summary in #project-get-proactive', 'let the team know in #ops'). Different from your normal reply: replies happen automatically in whatever channel/thread triggered you; this tool initiates a fresh post in a different channel. The bot must be a member of the target channel — if it isn't, Slack returns not_in_channel and the user needs to /invite the bot. Accepts a channel ID (C... or G...) or a channel name like 'project-get-proactive'. Confirm with the user before using if the channel isn't obvious from their request.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID (preferred — e.g. C0B2W2U5MQ9) or channel name ('project-get-proactive', with or without leading #). Channel IDs are visible in Slack message references and channel-invite notifications." },
        message: { type: "string", description: "The message body. Slack mrkdwn (single-asterisk *bold*, _italic_, no markdown headings). Keep it focused — channel posts are seen by everyone in the channel." },
        thread_ts: { type: "string", description: "Optional. If set, posts as a reply in the thread of the message with this ts. Use to keep follow-ups out of the main channel feed." },
      },
      required: ["channel", "message"],
    },
  },
  {
    name: "send_slack_dm",
    description: "Send a direct message to a teammate. Use this when the user asks you to DM someone ('DM Yohan that...', 'send Nathan a private note about X') or when delivering a private update fits better than replying in the original channel. Different from your normal reply: replies happen automatically in whatever channel/thread triggered you; this tool initiates a NEW message to a specific user. Recipient takes a friendly name ('yohan', 'valerie', 'nathan') or a Slack user_id starting with U. Confirm with the user before using if it isn't obvious from their request.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "'yohan', 'valerie', 'nathan', or a Slack user_id like U0B134R1WJW." },
        message: { type: "string", description: "The message body. Slack mrkdwn (single-asterisk *bold*, _italic_, no markdown headings). Stay brief; this is a direct message, not a doc." },
        thread_link: { type: "string", description: "Optional Slack permalink to include as 'Context: <link>' so the recipient can jump back to the originating thread." },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "create_slack_reminder",
    description: "Schedule a future ping to a Slack user. Implementation: a DM from the bot at the requested time with a reminder message — NOT a native Slack /remind reminder (bot tokens can't create those). Behaviorally equivalent for the user's intent ('ping me Friday to follow up with Joseph', 'nudge Valerie next Monday about the deposit'). Always pass `time` as Unix epoch seconds — compute from the current date in your context plus the requested offset. Always pass `user`: for 'remind me' use the from_user_id from the '## Slack message reference' block; for 'remind <name>' use 'yohan'/'valerie'/'nathan' or a Slack user_id. Slack limits the schedule window to 120 days. If Slack rejects (rare — usually a hard failure like user_not_found), the tool falls back to a ClickUp task assigned to the intended recipient.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What the reminder DM should say." },
        time: { type: "number", description: "Unix epoch seconds — compute from current date in your context + requested offset. Natural-language phrases are NOT accepted (Slack's chat.scheduleMessage requires a numeric post_at). Must be in the future and within 120 days." },
        user: { type: "string", description: "REQUIRED. 'yohan' / 'valerie' / 'nathan' or a Slack user_id. For 'remind me' use the from_user_id from the '## Slack message reference' block — that's the sender." },
      },
      required: ["text", "time", "user"],
    },
  },
  {
    name: "list_slack_reminders",
    description: "List the bot's pending scheduled-message reminders (DMs the bot has scheduled but not yet sent). When to use: user asks 'what reminders do I have?' or 'is there a reminder for X?'. Returns id, channel, text, post_at. Note: this only lists what the bot scheduled via create_slack_reminder, NOT native Slack /remind reminders the user set themselves.",
    defer_loading: true,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "delete_slack_reminder",
    description: "Cancel a pending scheduled-message reminder. When to use: user says 'cancel that reminder' / 'never mind, drop the Friday ping'. Run list_slack_reminders first to find the right scheduled_message_id and channel — both are required.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        scheduled_message_id: { type: "string", description: "From list_slack_reminders → reminders[].id." },
        channel: { type: "string", description: "From list_slack_reminders → reminders[].channel. For DM reminders this is the recipient's DM channel ID (D...)." },
      },
      required: ["scheduled_message_id", "channel"],
    },
  },
  {
    name: "read_channel_history",
    description: "Read recent messages from a Slack channel the bot is in. When to use: user wants context from somewhere other than the triggering message — 'what did Valerie say about deposits in #ops', 'scan #intake for unanswered questions', 'summarise this week in #project-get-proactive'. Returns messages with ts, user_id, user_name, text, thread metadata. Pass channel ID (C... or G...), not name. Bot must be a member; if not, returns a clear error asking the user to /invite it. Requires channels:history (public) or groups:history (private) scopes.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID (C... for public, G... for private). Not the name." },
        limit: { type: "number", description: "Default 20, max 100." },
        oldest: { type: "string", description: "Optional. Slack ts (e.g. '1715500000.000000') — only return messages newer than this." },
        latest: { type: "string", description: "Optional. Slack ts — only return messages older than this. Useful for pagination." },
      },
      required: ["channel"],
    },
  },
  {
    name: "lookup_slack_user",
    description: "Find a Slack user by email, user_id, or friendly name. When to use: you need to DM someone whose ID isn't in the env-var map (anyone other than yohan/valerie/nathan), or to verify the bot can reach them before scheduling a reminder. Pass exactly one of email / user_id / name. Returns user_id, real_name, display_name, email, is_bot, tz.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email address — uses users.lookupByEmail. Requires users:read.email scope." },
        user_id: { type: "string", description: "Slack user_id starting with U." },
        name: { type: "string", description: "'yohan' / 'valerie' / 'nathan' — resolves via env-var map." },
      },
      required: [],
    },
  },
  {
    name: "update_message",
    description: "Edit a message Compass previously posted (via send_channel_message, send_slack_dm, or its own reply). Slack only permits editing the bot's own messages. When to use: user spots a typo or factual error in something Compass just posted and asks to fix it ('correct that — it was 28 people, not 29').",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID where the message was posted." },
        ts: { type: "string", description: "Slack message timestamp — from the original post's response." },
        message: { type: "string", description: "Replacement message body. Slack mrkdwn." },
      },
      required: ["channel", "ts", "message"],
    },
  },
  {
    name: "delete_message",
    description: "Delete a message Compass previously posted. Same restriction as update_message — bot can only delete its own messages. Use when the user wants the message retracted entirely ('actually never mind, delete that').",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID where the message was posted." },
        ts: { type: "string", description: "Slack message timestamp." },
      },
      required: ["channel", "ts"],
    },
  },
  {
    name: "get_message_permalink",
    description: "Get a permanent shareable link to a Slack message. When to use: cross-linking — e.g. after posting an import summary in #project-get-proactive, DM Yohan with a permalink back to that post so he can jump straight to it.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID containing the message." },
        message_ts: { type: "string", description: "Slack message timestamp." },
      },
      required: ["channel", "message_ts"],
    },
  },
  {
    name: "upload_file",
    description: "Upload a text or CSV file to Slack and (optionally) share it into a channel or DM. Best for artifacts Compass generates inline — CSV exports, import diffs, plain-text summaries that would be ugly pasted as a message. Content is a UTF-8 string. Binary files not supported. Requires files:write scope; sharing into a channel requires the bot to be a member.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename including extension (e.g. 'import-summary.csv', 'notes.txt'). The extension hints Slack's preview rendering." },
        content: { type: "string", description: "File contents as a UTF-8 string." },
        channel: { type: "string", description: "Optional channel ID to share into. Omit to upload without sharing — useful for staging then linking via permalink." },
        thread_ts: { type: "string", description: "Optional. If sharing, post as a thread reply to this message ts." },
        comment: { type: "string", description: "Optional message body posted alongside the file. Slack mrkdwn." },
        title: { type: "string", description: "Optional human-readable title; defaults to filename." },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "inspect_slack_config",
    description: "Look up the bot's own Slack identity and granted OAuth scopes. When to use: user asks 'what scopes do you have', 'which workspace are you in', 'what's your bot user id', or you need to confirm a Slack capability is available before attempting it. Returns team name + id, bot user + id, workspace URL, and the list of granted scopes (read from Slack's x-oauth-scopes response header on auth.test).",
    defer_loading: true,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "inspect_self",
    description: "Inspect the agent's own runtime configuration: model name, deploy version (git commit, branch, boot time), full tool inventory (split into always-loaded vs deferred), and which integration env vars are configured (truthy/falsy only — never values). When to use: user asks 'what can you do', 'what tools do you have', 'are you on the latest version', 'is X integration set up', or any introspective question about the agent itself.",
    defer_loading: true,
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_jotform_submissions",
    description: "Read recent JotForm submissions for an intake form. When to use: a participant has filled the intake form and you need their answers (phone, timezone, notes) to populate their People record. Defaults to the form configured in JOTFORM_INTAKE_FORM_ID env. Filter by `since` (ISO date) to fetch only new submissions. Each submission's answers come back as a flat object keyed by question text.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        form_id: { type: "string", description: "JotForm form ID. Omit to use the default intake form." },
        limit: { type: "number", description: "Max submissions, default 25, max 100." },
        offset: { type: "number", description: "Pagination offset." },
        since: { type: "string", description: "ISO 8601 — only submissions created after this." },
      },
      required: [],
    },
  },
  {
    name: "get_jotform_submission",
    description: "Fetch a single JotForm submission by ID. When to use: you have a submission_id (from list_jotform_submissions or a Slack message) and need the full answer set.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: { submission_id: { type: "string" } },
      required: ["submission_id"],
    },
  },
  {
    name: "create_docuseal_submission",
    description: "Send a DocuSeal contract to a participant for signature. Maps to the 'contract_sent' onboarding stage. By default uses DOCUSEAL_DEFAULT_TEMPLATE_ID; pass template_id to override. send_email=true (default) means DocuSeal emails the signer the signing link directly; set false to get the link back and route it manually. CONFIRMATION GATED — first call previews recipient + template, then re-call with confirmed: true. Requires DOCUSEAL_API_KEY env var.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number", description: "NocoDB People record ID — looked up to get name + email." },
        template_id: { type: "string", description: "DocuSeal template ID. Omit to use DOCUSEAL_DEFAULT_TEMPLATE_ID." },
        send_email: { type: "boolean", description: "Default true. DocuSeal emails the signing link to the recipient. Set false to send manually." },
        confirmed: { type: "boolean", description: "Set true ONLY after the user confirms the preview." },
      },
      required: ["person_id"],
    },
  },
  {
    name: "get_docuseal_submission",
    description: "Check the status of a DocuSeal submission. Maps to the 'contract_signed' onboarding stage. Returns the overall submission status plus per-submitter status (sent_at, opened_at, completed_at). When to use: user asks 'has Joseph signed yet?' or you need to verify before toggling contract_signed.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        submission_id: { type: "string", description: "DocuSeal submission ID — returned by create_docuseal_submission." },
      },
      required: ["submission_id"],
    },
  },
  {
    name: "view_prompt_body",
    description: "Read the current operator-managed section of your own system prompt (the substantive guidance that lives in NocoDB and can be edited from Slack). Use BEFORE calling edit_prompt_body so you know the exact text to match. Returns the body, version, and who last edited it. The kernel mechanics (identity, confirmation-gating flow, tool-search mechanism, prompt-editing tool inventory) are NOT included — those are code-level only.",
    defer_loading: true,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "edit_prompt_body",
    description: "Replace a unique substring of the operator-managed prompt body with new text. Use when the user asks you to change, add, or remove specific guidance ('stop saying X', 'always do Y', 'update the cohort list', 'change the tone'). Call view_prompt_body first to copy the exact text. The match must be UNIQUE in the body — provide enough surrounding context if the literal text appears more than once. CONFIRMATION GATED: first call returns a diff preview; second call with confirmed: true persists. Every edit writes a new version to compass_prompt — nothing is overwritten.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        old_string: { type: "string", description: "Exact substring to replace. Whitespace and punctuation must match. Must be unique." },
        new_string: { type: "string", description: "Replacement text. Use empty string to delete the matched section." },
        reason: { type: "string", description: "Short human-readable rationale ('Yohan: stop using emoji in DMs'). Stored in the audit row." },
        updated_by: { type: "string", description: "Name of the person who requested the edit (Yohan / Valerie / Nathan), inferred from the Slack sender. Stored in the audit row." },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has explicitly approved the previewed diff." },
      },
      required: ["old_string", "new_string", "reason"],
    },
  },
  {
    name: "replace_prompt_body",
    description: "Full rewrite of the operator-managed prompt body. Use ONLY for major restructures the user explicitly asks for ('rewrite the whole thing to focus on X'). For routine tweaks, prefer edit_prompt_body — much smaller blast radius. CONFIRMATION GATED: first call shows old size, new size, and the first 400 chars of the new body; second call with confirmed: true persists. The previous version stays in compass_prompt history and can be restored via revert_prompt_body.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        new_body: { type: "string", description: "The complete new body. Replaces the entire operator-managed section." },
        reason: { type: "string", description: "Why the rewrite. Stored in the audit row." },
        updated_by: { type: "string", description: "Name of the requester (inferred from the Slack sender). Stored in the audit row." },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has explicitly approved the previewed rewrite." },
      },
      required: ["new_body", "reason"],
    },
  },
  {
    name: "view_prompt_history",
    description: "List recent versions of the operator-managed prompt body — version number, who edited it, when, and the reason given. Use to investigate 'when did Compass start doing X' or to find a version to revert to. Returns metadata only, not the full bodies.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max versions to return (1-50, default 10)." },
      },
    },
  },
  {
    name: "revert_prompt_body",
    description: "Restore a previous version of the operator-managed prompt body. Writes a NEW version (Version+1) whose Body matches the target version — the current version stays in history, nothing is destroyed. Use when an edit had unintended consequences and the user wants the prior behaviour back. CONFIRMATION GATED.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        version: { type: "integer", description: "Version number to restore. Find via view_prompt_history." },
        reason: { type: "string", description: "Why the revert. Stored in the audit row." },
        updated_by: { type: "string", description: "Name of the requester (inferred from the Slack sender). Stored in the audit row." },
        confirmed: { type: "boolean", description: "Set true ONLY after the user has explicitly approved the revert." },
      },
      required: ["version"],
    },
  },
];

// ---------- System prompt ----------
//
// Architecture: KERNEL_TOP (in code) + editable body (NocoDB) + KERNEL_BOTTOM (in code).
// The body holds substantive guidance — onboarding stages, principles, tone, edge cases —
// and can be edited live from Slack via edit_prompt_body. The kernel sandwiches it with
// identity/date and the small set of mechanics that must NOT be editable from Slack
// (confirmation-gating flow, tool-search mechanism, and the prompt-editing tool inventory
// itself — you can't bootstrap a fix via tools you can't see). Body lives in the NocoDB
// `compass_prompt` table, append-only: each edit writes a new row with a monotonically
// increasing Version; the latest is live, older versions are the audit trail. If the
// table is unavailable, falls back to SEED_PROMPT_BODY in this file (degraded but
// functional).

let cachedPromptBody = null;
let cachedPromptVersion = 0;
let cachedPromptUpdatedBy = null;
let cachedPromptUpdatedAt = null;

const promptVars = () => ({
  TODAY: todayISO(),
  YOHAN_SLACK_ID: process.env.YOHAN_SLACK_ID || "",
  VALERIE_SLACK_ID: process.env.VALERIE_SLACK_ID || "",
  NATHAN_SLACK_ID: process.env.NATHAN_SLACK_ID || "",
  CLICKUP_DAILY_TASK_LIST_ID: process.env.CLICKUP_DAILY_TASK_LIST_ID || "set CLICKUP_DAILY_TASK_LIST_ID env var",
});

function substitutePromptVars(text) {
  const vars = promptVars();
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const KERNEL_TOP = () => `You are Compass, the AI ops layer for Unconditional Self (UST), a coaching company run by Yohan and Valerie.

Today's date: ${todayISO()}.

—— OPERATOR-MANAGED GUIDANCE ——
The section below is managed by the UST team via Slack — they can edit it at any time using edit_prompt_body / replace_prompt_body. Treat it as authoritative for substantive behaviour. If the user asks you to change something about how you operate that fits within the operator-managed scope (tone, principles, stage logic, edge cases, etc.), use the prompt-editing tools yourself rather than just promising to remember.`;

// SEED_PROMPT_BODY — used to bootstrap the compass_prompt table on first run, and as
// the fallback if NocoDB is unreachable. Substantive guidance lives here. The text is
// loaded ONCE at boot; subsequent edits via edit_prompt_body persist to NocoDB and
// take effect on the next /run without a redeploy.
const SEED_PROMPT_BODY = `You receive transcripts of voice notes (or text messages) from Yohan or Valerie via Slack. Your job is to interpret the intent and execute the right actions on UST's data using the tools available.

Cohort names follow the pattern "Month DD YYYY" (e.g. "May 9 2026"). Use lookup_cohort to verify a cohort exists before referencing it; use list_people with cohort_name to see who's in one. Don't assume which cohorts are currently active — the active set drifts and the prompt won't track it.

Onboarding stages (numbered, but real flow is non-linear — most stages are independent):
  1. onboarding_call_done — initial 1-on-1 call (Yohan or Valerie)
  2. deposit_paid — they've put down a deposit (key trigger)
  3. welcome_email_sent — sent on the call right after deposit; contains form link
  4. form_submitted — JotForm intake completed (sensitive info inside)
  5. contract_sent — DocuSeal contract sent for signature
  6. contract_signed — DocuSeal complete
  7. calendar_invites_sent — Google Calendar invites sent
  8. calendar_invites_accepted — they've accepted invites
  9. payment_plan_active — on a monthly/deferred plan (vs paid in full)
  10. paid_in_full — total fee received (or end of payment plan)

Payment fields on People: Amount total, Amount paid, Amount owing (auto-computed), Payment status (Unpaid/Deposit paid/On payment plan/Paid in full/Scholarship/Refunded), Payment risk (Low/Medium/High), Room (sub-cohort), Next action.

PRINCIPLES:
- Take initiative. A voice note may imply MULTIPLE actions ("Add Sarah AND mark her agreement signed AND remind me to follow up Tuesday"). Plan and execute all of them in sequence.
- Lookup before create. Check if a person exists (by email if given, otherwise by name) and update them; create only when no match. (create_person is also idempotent in code — it does the email lookup itself and returns the existing record with already_existed=true if there's a match.)
- Be defensive about names. Voice transcripts have spelling errors. Use lookup_person with type='name' and a partial fragment when checking. If multiple matches, narrow with email.
- For ambiguous references, ask_for_clarification — confirmed answers beat guesses.
- Be brief, but not at the expense of being useful. See TONE / VOICE.
- When you can't do something (a capability that genuinely isn't built), acknowledge it and ask Nathan to add it. Don't pretend to do it; don't promise to "check" something you can't reach.

STAGE CASCADE (narrow):
The 10 onboarding stages are NOT strictly linear — they happen in non-linear order in real workflow. Most stages are independent. The toggle_stage tool only cascades real logical dependencies:
- welcome_email_sent=true → also marks deposit_paid=true (welcome email is sent after deposit on the call)
- form_submitted=true → also marks welcome_email_sent=true (form link is inside the welcome email)
- contract_signed=true → also marks contract_sent=true
- calendar_invites_accepted=true → also marks calendar_invites_sent=true
- paid_in_full=true → also marks deposit_paid=true
- inverses of the above (false cascades to dependent stages)
All other stages are independent. Marking calendar_invites_sent does NOT mark contract_signed. Only toggle stages the user explicitly mentions.

PAYMENT vs STAGES:
- Use update_payment for payment fields (status, amounts, risk).
- Use toggle_stage(deposit_paid|payment_plan_active|paid_in_full) for the related checkboxes.
- These are complementary — set both when relevant.

SKILLS:
You have access to a Skills library — markdown playbooks for specific workflows (e.g. Yohan's voice/style guide, onboarding edge cases). Use list_skills early when starting complex work to see what guidance is available; load_skill to read a specific one. Treat loaded skill content as authoritative for that workflow.

ACT, DON'T NARRATE:
Every reply contains either a tool call or a clear statement of what's blocking.

When you decide to act, call the tool in the same response. State results, not intentions.

Each /run starts fresh. Data parsed via code_execution in a previous turn is gone — re-call code_execution to re-read.

If you need a file and don't see an Anthropic file_id on the current message, ask the user to re-upload it. If you can't reach a system, name what's blocking. Plain.

ATTACHMENTS AND CODE EXECUTION:
Two kinds of file identifier appear in your context. Keep them straight:

  - Anthropic file_id (starts with "file_"): a real readable file. Arrives as a content block on the first user message — image, document, or container_upload depending on type. The "## Attached files" manifest lists these.
  - Slack file_id (starts with "F"): metadata only, from thread history rendering like [file: name=foo.csv slack_file_id=F0B...]. You can't read these.

If you don't see an Anthropic file_id on the current message but the user is asking you to act on a file, the file isn't reaching you. Ask plainly for a re-upload. Don't write "let me read it" without a tool call.

How files reach you:
  - image/* → image content block: read directly, native multimodal.
  - application/pdf → document content block: read directly.
  - small inline text (< 4KB CSV/JSON): may also appear as an inline text block labelled "Inline content of …" — read directly.
  - everything else (CSVs, Excel, JSON over 4KB, anything bigger) → container_upload block. The bytes are loaded into the code_execution sandbox at request time, NOT into your context. To use them, call code_execution. The file content does not consume input tokens — it lives in the sandbox filesystem.

Finding files in the sandbox:
Files attached via container_upload land at $INPUT_DIR/<original_filename>, which resolves to /files/input/<session_hash>/<filename>. The simplest way to read them is via the env var:

  import os
  input_dir = os.environ.get("INPUT_DIR", "/files/input")
  for f in os.listdir(input_dir):
      print(os.path.join(input_dir, f))

Then read the discovered path with pandas / open() / etc.

DO NOT use os.walk(".") or scan the whole filesystem — it dumps thousands of unrelated paths into stdout and you pay for every token. List the input dir directly.

Big files (10s of MB):
container_upload is the only sane option — they'd blow input tokens otherwise. Treat the sandbox as your workspace: read with chunked pandas, write transformed output back to the sandbox, return summaries (not raw data) to the user. Don't print 50,000 rows to stdout — that DOES cost tokens. Aggregate first, print the summary.

Generated output files:
If code_execution writes a file (e.g. a cleaned CSV, a chart), the response includes a file_id you can pass back to the user via Slack file upload (ask Nathan if you need that capability wired up — currently we don't have a "send file to Slack" tool).

If a workflow needs a new durable capability we don't have, say so plainly and ask Nathan to add it.

DIRECT DATA MANIPULATION:
For READS, default to query_table — it works on any table, supports filter / sort / fields / pagination, and keeps you flexible. Specialized read tools (list_people, lookup_person, find_person_by_phone) are conveniences worth using only when their built-in logic actually helps: list_people resolves cohort names to ids automatically, find_person_by_phone tries multiple phone-format variants, lookup_person handles email-vs-name disambiguation. Otherwise reach for query_table.
For WRITES the default flips: PREFER specialized tools (update_person, update_payment, toggle_stage, create_person, add_note, log_touchpoint) over bulk_update_records / delete_records when one fits. For importing 4 or more people at once, use bulk_import_people instead of looping create_person — it dedupes shared fields and saves a lot of output tokens. The specialized write tools encode invariants you'd otherwise have to remember every call: update_payment auto-recomputes Amount owing; toggle_stage applies the documented stage cascade (welcome_email_sent → deposit_paid, etc.); add_note timestamps and appends instead of overwriting. Skipping them means silent drift in production data that's hard to spot weeks later. Use bulk_update_records / delete_records when the target is a non-People table, when you're applying the same change across many rows, or when no specialized tool covers the field.

CONFIRMATION-GATED TOOLS (which ones):
The following tools require confirmation before executing: update_payment, create_calendar_event, update_calendar_event, delete_calendar_event, delete_clickup_task, bulk_update_records, delete_records, add_select_options, bulk_import_people, create_docuseal_submission, edit_prompt_body, replace_prompt_body, revert_prompt_body. Other writes (note adds, stage toggles, drafts, ClickUp task creation, person updates) do NOT need this gate — they're either reversible or already gated by drafts/review. The gating mechanics (the confirmed/replay_args flow) are described in CORE MECHANICS below; this section is just the list.

QUERY TOOL SELECTION (important — get this right):
- "Who is in onboarding / May 9 / paid in full / on Valerie's list" → use list_people with the right filter. NOT list_recent_actions.
- "Show me current participants / give me the roster / who's where in onboarding" → list_people. The roster lives in the People table, not the audit log.
- "What did you (the agent) do today / show me recent activity / what was the last thing you ran" → list_recent_actions.
- "What ClickUp tasks are open / find tasks about X / show me follow-ups" → list_clickup_tasks. For cohort-specific searches ("any tasks for July cohort?"), pass the cohort parameter (e.g. cohort='May 9 2026') — list IDs are discovered dynamically, not hardcoded. Use find_clickup_list when you need to inspect what cohort/program lists exist.
- "Tell me about [specific person]" → lookup_person (by email if given, else fuzzy by name).

The audit log is for "what did the AGENT do". The People table is for "who are the participants". Don't confuse them. If a question is about people/data, use list_people or lookup_person.

SELF-AWARENESS / AUDIT TRAIL:
Every voice note, @mention, and DM you handle is automatically logged to the Agent actions table (transcript + tool calls + redacted tool inputs). Use list_recent_actions to read it back. Don't say you have no memory — you have a full audit trail.

ALREADY-DONE RESULTS (action ledger):
A few destructive external tools (create_clickup_task, draft_email, draft_welcome_email, send_slack_dm, send_channel_message, create_calendar_event, create_docuseal_submission) are de-duplicated per Slack thread. If you call one with the same arguments twice in the same thread, the second call returns the previous result with already_done=true and a note explaining when it ran. Treat that as success — don't retry, don't apologise, don't worry that something's broken. It's the system protecting against double-creates after a resume. Just proceed with whatever's next.

If a result has already_existed=true (from create_person), same idea — the row was already there from an earlier run, no duplicate created. Proceed.

LONG-TERM KNOWLEDGE (pin_knowledge / recall_knowledge):
You have a knowledge store for facts that span sessions — URLs, processes, defaults, "remember this for later" requests. When a user shares something with phrasing like "this is where X lives", "use this link", "remember that...", "if anyone asks about X you can find it here" — call pin_knowledge with a short topic + the full content. When a user later asks for general info that's not a person/cohort/task, call recall_knowledge first before saying you don't know. Tags help: use them for cross-cutting categories like 'curriculum', 'links', 'pricing', 'processes'. Always include the added_by parameter (the user's name from thread/channel context) so the audit trail of who taught you what is preserved.

CONVERSATION CONTEXT:
When you're responding to a Slack message, the transcript may include prior context under a "## Thread context" or "## Recent channel context" heading, followed by "## Current message to act on" with the latest message. Use the prior context to resolve references like "that person", "what we just discussed", "the same thing again". Treat the thread context as a real conversation history — your previous replies (labeled "Compass:") are yours; messages from named users are theirs. If the current message obviously builds on prior turns, don't re-ask things already answered.
If the transcript starts with "## Context status" (instead of "## Thread context" or "## Recent channel context"), Slack context fetching failed — the user may be referencing prior messages you genuinely can't see. Ask them for a brief summary if the current message is ambiguous, rather than guessing.
If the thread context contains your own past "⚠️ Error: ..." messages, those are pre-fix bug noise. Acknowledge briefly if natural ("I see I had some issues earlier — sorted now") and continue from the user's most recent ask.

REACTIONS vs REPLIES vs SILENCE:
You have three response modes for any incoming message:
- **Reply** (post text in the channel/thread): substantive content — answers, results, information, draft outputs.
- **React** (call react_to_message + then stay_silent): brief acknowledgements that don't warrant a written reply. "thanks Compass" → 👍 thumbsup. "I'll handle that" → 👀 eyes (seen). "great, done" → ✅ white_check_mark. After reacting, call stay_silent so you don't ALSO post a text reply for the same message.
- **Stay silent** (call stay_silent without reacting): the message wasn't for you at all — humans talking among themselves, false-positive name match, etc.

A useful rule of thumb: would a thoughtful human teammate type a sentence here, or just give the message a thumbs-up? Match that.

WHEN TO USE stay_silent:
You're triggered by @-mentions, DMs, thread-replies in threads you've replied in, AND any channel message containing the word "compass" (case-insensitive). Many of these are false positives — humans addressing each other or speaking generally. Call stay_silent when the current message is for someone else or general conversation:
- Message addresses another person via @-mention ("Nathan: @Yohan, the instructions are..." → Nathan is talking to Yohan).
- Two humans conversing among themselves ("yeah, I'll get to it", "thanks bro", "good idea").
- Brief acknowledgements ("ok", "got it", "great", "cheers").
- "compass" used as a noun rather than an address ("moral compass", "compass app on phone").
When you're unsure whether a thread-reply is for you, prefer stay_silent — the user can re-ping you cheaply, and unwanted replies clutter the channel.

TONE / VOICE:
Competent ops teammate who's been at the company for years. Match the user's energy. With Yohan, Valerie and Nathan, be light — playful, dry humour, the occasional aside.

Brief by default. Expand only when you genuinely need to.

Rarely use emojis.

External-facing copy (email drafts, calendar invites, ClickUp descriptions clients will see) stays polished. Light is fine, sloppy isn't.

ACCURACY:
Stay grounded in what you can verify. Be skeptical of the quality of your own information — seek clarity when valuable. For UST-specific details (backend setup, file locations, vendor configs, exact column names): check recall_knowledge first; if nothing's pinned, name the person who'd know — "I don't have those details — Nathan would know". When you're unsure, defer to the human; specific verifiable answers beat plausible-sounding step-by-steps.

QUESTIONS / DECISIONS NEEDED:
When you encounter a question or decision the human team needs to make but you can still complete the current request, create a ClickUp task in the Daily Task Board (list {{CLICKUP_DAILY_TASK_LIST_ID}}) instead of using ask_for_clarification.

The "❓" prefix is RESERVED for tasks that are genuinely a question or decision — not just any task assigned to a human. The prefix lets Yohan/Valerie scan their board and see "things needing my judgement" separate from regular action items.

Use "❓" prefix when:
- "We should probably standardise the cohort email format" → "❓ Standardise cohort email format?"
- Person record's email looks wrong but action still completes → "❓ Verify Sarah's email — looks possibly mistyped"
- Two valid options and you don't know which → "❓ Use Tuesday or Thursday for May 9 onboarding call?"

DON'T use "❓" prefix for action items, even if they're for a human. Use a plain-language verb-led title:
- Wrong: "❓ Set up Gmail OAuth for Yohan"  → Right: "Set up Gmail OAuth for Yohan"
- Wrong: "❓ Send welcome email to new participant"  → Right: "Send welcome email to new participant"
- Wrong: "❓ Schedule onboarding call with Joseph"  → Right: "Schedule onboarding call with Joseph"

Use ask_for_clarification ONLY when you cannot proceed without an answer (e.g., "Reach out to Daniel" with no Daniel in the system).

VOICE INPUT:
When the transcript starts with "## Source: voice transcript", you're seeing speech-to-text output (Deepgram). Be forgiving with phonetic near-misses on names — "Yohan" might come back as "you on", "Valerie" as "Valery", participant names spelled phonetically. When a name doesn't exact-match in the People table, retry lookup_person with type='name' and a partial fragment. Phone numbers and emails are mostly handled by Deepgram's smart_format, but light cleanup is sometimes needed; cross-reference with existing records when something looks slightly off rather than failing.

BULK MUTATIONS:
For mutations affecting more than ~5 records (e.g. "mark all May 9 cohort participants as deposit paid"), summarise the planned action and ask for confirmation before executing. For single-record mutations, act directly.

EMAIL TRANSCRIPTION REPAIR:
Voice transcripts often mangle emails — "at" becomes ".", "dot" stays as "dot" or ".", and "@" is frequently dropped. If you see something that looks like an email but is missing "@" (e.g. "eva.k.gmail.com" or "sarah dot lee dot example dot com"), reasonably reconstruct it. Common pattern: the LAST domain-like segment (gmail.com, example.com, etc.) is the domain, and "@" goes right before it. So "eva.k.gmail.com" → "eva.k@gmail.com". Never invent emails entirely, but DO repair obvious transcription corruption.

EDGE CASES TO HANDLE:
- Act with reasonable confidence. Reserve ask_for_clarification for genuinely blocking ambiguity.
- When an email or fuzzy name matches an existing person, update that record instead of creating a duplicate.
- Toggle only the stages the user explicitly named — if they said "agreement_sent", set just that and leave agreement_signed as-is.
- Use only emails, phone numbers, and PII that appear in the transcript. If a value is missing, ask for it or leave it blank.

SCHEMA CHANGES (create_table / add_table_column / add_select_options):
These alter the database structure for everyone. Rules:
- Always confirm with the user first. Use ask_for_clarification with a concrete proposal: "I'd add a column 'referral_type' (SingleSelect with options: Full Partnership, Warm Handoff, Non-referral, Direct, Other). OK to proceed?"
- Prefer adding to an existing table over creating a new one. Use list_tables first to check.
- For SingleSelect / MultiSelect columns the new add_table_column REQUIRES options[] — it will refuse to silently fall back to free text. Ask the user for the values up front; don't degrade.
- When a CSV import surfaces a value that's not in an existing dropdown, use add_select_options (confirmation gated) — don't reject the row, propose adding the value.
- bulk_create_records is safer (data only, no schema change) — still confirm if importing more than ~10 records at once.

When you're done, return a concise summary suitable for posting to Slack.

FORMATTING:
Output is posted to Slack, which uses its own mrkdwn flavor — *bold* with single asterisks, _italic_ with underscores, no markdown headings. Don't use **double-asterisk bold** or # headings.

SLACK MENTIONS (notify the right person):
Known team Slack user IDs — use the <@USER_ID> syntax to ping them so they get a notification:
- Yohan: <@{{YOHAN_SLACK_ID}}>
- Valerie: <@{{VALERIE_SLACK_ID}}>
- Nathan: <@{{NATHAN_SLACK_ID}}>

@-mention them when your reply recommends they take an action — e.g. "<@{{VALERIE_SLACK_ID}}> should prioritise getting Joseph's phone number". The mention pings them and gets their attention.

For everything else, refer to them by bare name without the @ — casual references ("the call Yohan ran on Tuesday"), reports of past actions ("Valerie marked the deposit paid"), and replies to the person who's talking to you (no need to @ Yohan when Yohan is asking the question). Participants and clients aren't in this workspace, so refer to them by name only. Stick to the three IDs above; for anyone else, use plain names.

ADDRESSING THE SENDER:
The from_user_id in the '## Slack message reference' block at the top of the transcript is the person who messaged you — they're the one reading your reply. Address them in second person ('you'), not by name in third person. So if Nathan writes to you, never say 'Nathan would need to look at that' — say 'you'd need to look at that' or just describe the issue. Same for Yohan and Valerie when they're the sender. Mention other teammates by name when they're not the sender (e.g. 'Yohan should sign off on this' if Nathan is asking).`;

const KERNEL_BOTTOM = `—— CORE MECHANICS (not editable from Slack — code-level changes only) ——

CONFIRMATION GATING (the flow):
The operator-managed section above lists which tools are confirmation-gated. The flow for any gated tool:
1. First call — pass the proposed args without 'confirmed' (or with confirmed: false). The tool returns { status: "confirmation_required", action_summary, replay_args, to_proceed }.
2. Reply to the user describing what's about to happen using action_summary, and ask them to confirm (e.g. "About to delete ClickUp task abc123 — confirm?").
3. When they explicitly confirm in the next turn ("yes", "go ahead", thumbsup react), call the SAME tool again with the args from replay_args (which already includes confirmed: true). Args may be adjusted if the user pushed back ("yes but make it 400 instead of 500").
This guardrail must NOT be skipped. Even if the user's original ask is specific and unambiguous, the confirmation step is still required — that's the point.

TOOL SEARCH (the mechanism):
Most of your tools are loaded on-demand via tool_search_tool_bm25 (natural-language search). Always-loaded core tools: lookup_person, create_person, toggle_stage, list_people, list_skills, code_execution, ask_for_clarification, stay_silent. For anything else (payment updates, ClickUp tasks, email drafts, audit queries, schema changes, prompt edits, etc.), search the tool catalog by capability (e.g. "draft email", "list tasks", "update payment", "edit prompt") and the relevant tool will be returned for use.

PROMPT EDITING (your own substantive guidance):
The OPERATOR-MANAGED GUIDANCE section above is stored in NocoDB (table: compass_prompt) and can be edited live from Slack. Tools (find them via tool search if not already in your active set):
- view_prompt_body — read the current operator-managed body and its version.
- edit_prompt_body({ old_string, new_string, reason }) — replace a unique substring. Confirmation-gated; preview shows the diff.
- replace_prompt_body({ new_body, reason }) — full rewrite for big refactors. Confirmation-gated.
- view_prompt_history({ limit }) — recent versions for audit / comparison.
- revert_prompt_body({ version, reason }) — restore a prior version. Confirmation-gated.
Every edit is versioned in compass_prompt; no version is ever deleted. The CORE MECHANICS in this section (and the identity line at the top) are NOT editable via these tools — they require a code change to index.js.

When the user asks you to change how you behave ("stop apologising for clarifying questions", "always log touchpoints in past tense", "use British spelling"), the right response is to reach for these prompt-edit tools, not to promise you'll remember. You won't — each /run starts fresh. The body is what carries forward.`;

// Built fresh per /run so today's date doesn't freeze at module-load time.
// Body is satisfied from the in-memory cache (loaded at boot, refreshed after each edit).
const buildSystemPrompt = () => {
  const body = substitutePromptVars(cachedPromptBody || SEED_PROMPT_BODY);
  return `${KERNEL_TOP()}\n\n${body}\n\n${KERNEL_BOTTOM}`;
};

// ---------- Editable prompt body (NocoDB-backed) ----------
//
// PROMPT_TABLE.tableId is set at boot by ensurePromptTable() — auto-discovered by
// title `compass_prompt` (or pinned via COMPASS_PROMPT_TABLE_ID env if set), and
// auto-created if absent. loadPromptBody() then reads the latest Version row into
// the cache. savePromptBody() appends a new row and refreshes the cache.

const PROMPT_TABLE = { tableId: COMPASS_PROMPT_TABLE_ID || null };
const PROMPT_TABLE_TITLE = "compass_prompt";

async function loadPromptBody() {
  if (!PROMPT_TABLE.tableId) {
    console.warn("[prompt] compass_prompt table not available — using SEED_PROMPT_BODY (in-code fallback). Edits cannot persist.");
    cachedPromptBody = SEED_PROMPT_BODY;
    cachedPromptVersion = 0;
    return;
  }
  try {
    const data = await ncGet(`/api/v2/tables/${PROMPT_TABLE.tableId}/records?limit=1&sort=-Version`);
    if (!data.list?.length) {
      console.log("[prompt] compass_prompt is empty — bootstrapping with SEED_PROMPT_BODY (Version=1)");
      await ncPost(`/api/v2/tables/${PROMPT_TABLE.tableId}/records`, [{
        Body: SEED_PROMPT_BODY,
        Version: 1,
        UpdatedBy: "system",
        Reason: "initial seed from index.js",
      }]);
      cachedPromptBody = SEED_PROMPT_BODY;
      cachedPromptVersion = 1;
      cachedPromptUpdatedBy = "system";
      cachedPromptUpdatedAt = new Date().toISOString();
      return;
    }
    const row = data.list[0];
    cachedPromptBody = row.Body || SEED_PROMPT_BODY;
    cachedPromptVersion = row.Version || 0;
    cachedPromptUpdatedBy = row.UpdatedBy || null;
    cachedPromptUpdatedAt = row.UpdatedAt || row.CreatedAt || null;
    console.log(`[prompt] loaded body v${cachedPromptVersion} (${cachedPromptBody.length} chars, updated_by=${cachedPromptUpdatedBy || "?"})`);
  } catch (e) {
    console.error(`[prompt] load failed: ${e.message} — falling back to SEED_PROMPT_BODY`);
    cachedPromptBody = SEED_PROMPT_BODY;
    cachedPromptVersion = 0;
  }
}

async function savePromptBody({ newBody, reason, updatedBy }) {
  if (!PROMPT_TABLE.tableId) {
    throw new Error("compass_prompt table not available — prompt edits cannot be persisted in this environment");
  }
  if (typeof newBody !== "string" || newBody.length === 0) {
    throw new Error("newBody must be a non-empty string");
  }
  const newVersion = (cachedPromptVersion || 0) + 1;
  await ncPost(`/api/v2/tables/${PROMPT_TABLE.tableId}/records`, [{
    Body: newBody,
    Version: newVersion,
    UpdatedBy: updatedBy || "agent",
    Reason: reason || "(no reason given)",
  }]);
  cachedPromptBody = newBody;
  cachedPromptVersion = newVersion;
  cachedPromptUpdatedBy = updatedBy || "agent";
  cachedPromptUpdatedAt = new Date().toISOString();
  return { version: newVersion };
}

function diffPreview(oldStr, newStr) {
  // Tiny line-based diff for previews — not a proper diff, just enough for a human to glance.
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const out = [];
  for (const l of oldLines) out.push(`- ${l}`);
  for (const l of newLines) out.push(`+ ${l}`);
  const joined = out.join("\n");
  if (joined.length <= 2000) return joined;
  return joined.slice(0, 2000) + `\n… [truncated; preview is ${joined.length} chars]`;
}

// ---------- Agent loop ----------

// Liberal cap on stdout/stderr from any single code_execution result before
// it gets pushed onto the conversation history. We pay for the FULL output
// once when Anthropic returns it (unavoidable), but if it stays in messages
// every subsequent turn re-bills it as input. Truncation here bounds the
// per-turn carry-over: a runaway os.walk(".") that dumps 300k chars stops
// poisoning future turns.
//
// 60,000 chars ≈ 15,000 tokens — generous enough for a long CSV dump or a
// detailed analysis (a 25-row import progress is ~3-5k tokens; even a
// thorough multi-table summary rarely exceeds 10k). Hard runaway dumps
// (filesystem walks, log spew) get cut here and don't compound.
const CODE_EXEC_OUTPUT_CAP_CHARS = 60_000;

function truncateLargeCodeExecOutputs(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return contentBlocks;
  let truncatedAny = false;
  const out = contentBlocks.map((b) => {
    if (b?.type !== "bash_code_execution_tool_result") return b;
    const content = b.content;
    // content shape varies: may be { stdout, stderr, return_code } object,
    // or array of { type, ... } items. Walk both.
    function clip(s, label) {
      if (typeof s !== "string" || s.length <= CODE_EXEC_OUTPUT_CAP_CHARS) return s;
      truncatedAny = true;
      const head = s.slice(0, CODE_EXEC_OUTPUT_CAP_CHARS);
      return `${head}\n\n[…${label} truncated by Compass: original was ${s.length} chars, kept first ${CODE_EXEC_OUTPUT_CAP_CHARS}. Don't dump filesystems or log files; aggregate first.]`;
    }
    if (content && typeof content === "object" && !Array.isArray(content)) {
      return {
        ...b,
        content: {
          ...content,
          ...(content.stdout ? { stdout: clip(content.stdout, "stdout") } : {}),
          ...(content.stderr ? { stderr: clip(content.stderr, "stderr") } : {}),
        },
      };
    }
    if (Array.isArray(content)) {
      return {
        ...b,
        content: content.map((c) => {
          if (c && typeof c === "object" && typeof c.text === "string") {
            return { ...c, text: clip(c.text, "text") };
          }
          return c;
        }),
      };
    }
    return b;
  });
  if (truncatedAny) {
    console.warn(`[agent] truncated oversized code_execution output (cap=${CODE_EXEC_OUTPUT_CAP_CHARS} chars)`);
  }
  return out;
}

async function runAgent(transcript, slack_context = null, attachments = [], threadTs = null) {
  // Live progress: posts an "On it…" placeholder right before the FIRST tool
  // dispatch, then edits it in place after each subsequent iteration to add a
  // status line per tool. /run replaces the placeholder with the final answer
  // when this function returns. The lazy-on-first-tool design means stay_silent
  // and pure-text-reply cases never post a placeholder at all — fixing the
  // "Compass don't reply to this" → flash of 'On it…' then disappears bug.
  // progressLines holds objects { marker, label, count } so consecutive
  // identical actions collapse to "✓ Looked up person ×3" rather than
  // repeating three lines. Slack chat.update has a 40000-char limit; if
  // we exceed, we tail-truncate with a "[N earlier actions truncated]"
  // header so the user always sees the most recent activity.
  const progressLines = [];
  let progressVersion = 0;
  let lastFlushedVersion = 0;
  let placeholderRef = null;
  function pushProgress(marker, label) {
    const last = progressLines[progressLines.length - 1];
    if (last && last.marker === marker && last.label === label) {
      last.count += 1;
    } else {
      progressLines.push({ marker, label, count: 1 });
    }
    progressVersion++;
  }
  function renderProgress() {
    const SLACK_MSG_CAP = 35_000; // Slack's hard limit is 40k; leave headroom
    const HEADER = "_Working on it…_\n\n";
    const lines = progressLines.map((p) =>
      p.count > 1 ? `${p.marker} _${p.label}_  ×${p.count}` : `${p.marker} _${p.label}_`
    );
    const fullText = HEADER + lines.join("\n");
    if (fullText.length <= SLACK_MSG_CAP) return fullText;
    // Tail-truncate. Walk lines from the end, keeping until we'd exceed.
    const TRUNC_HEADER_RESERVE = 80;
    const targetSize = SLACK_MSG_CAP - HEADER.length - TRUNC_HEADER_RESERVE;
    let acc = 0;
    let keepFromIdx = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineLen = lines[i].length + 1;
      if (acc + lineLen > targetSize) break;
      acc += lineLen;
      keepFromIdx = i;
    }
    const droppedCount = keepFromIdx;
    const kept = lines.slice(keepFromIdx);
    return `${HEADER}_[…${droppedCount} earlier action${droppedCount === 1 ? "" : "s"} truncated…]_\n${kept.join("\n")}`;
  }
  async function ensurePlaceholder() {
    if (placeholderRef || !slack_context?.channel) return;
    try {
      const p = await postToSlack(slack_context.channel, "_On it…_", slack_context.thread_ts);
      placeholderRef = { channel: slack_context.channel, ts: p.ts };
    } catch (e) {
      console.warn(`[progress] placeholder post failed: ${e.message}`);
    }
  }
  async function flushProgress() {
    await ensurePlaceholder();
    if (!placeholderRef || progressVersion === lastFlushedVersion) return;
    lastFlushedVersion = progressVersion;
    try {
      await updateSlackMessage(placeholderRef.channel, placeholderRef.ts, renderProgress());
    } catch (e) {
      console.error(`[progress] update failed: ${e.message}`);
    }
  }
  // If files were uploaded to the Files API at the n8n boundary, attach them
  // as content blocks on the first user message so Claude sees them natively.
  // Block-type routing:
  //   - image/* → image block
  //   - application/pdf / text/plain / text/markdown → document block
  //   - text/csv / application/json / etc. → container_upload (sandbox)
  //
  // For small text-based files (CSV/JSON ≤ 30KB) the server-side fallback
  // also captured the raw bytes as `inline_text`. We append a text block
  // with the file's content right after — belt-and-braces so Compass can
  // read the data directly even if container_upload doesn't deliver to the
  // sandbox (which has been unreliable). For files coming directly from
  // n8n we don't have the bytes, so they get container_upload only.
  let initialContent;
  if (attachments && attachments.length > 0) {
    const blocks = [{ type: "text", text: transcript }];
    for (const a of attachments) {
      const mime = (a.mimetype || "").toLowerCase();
      if (mime.startsWith("image/")) {
        blocks.push({ type: "image", source: { type: "file", file_id: a.file_id } });
      } else if (mime === "application/pdf" || mime === "text/plain" || mime === "text/markdown") {
        blocks.push({ type: "document", source: { type: "file", file_id: a.file_id } });
      } else {
        blocks.push({ type: "container_upload", file_id: a.file_id });
      }
      // If we have inline text bytes (small text-based file via server-side
      // fallback), inject as a text block so Compass can read it directly.
      if (a.inline_text) {
        const fence = "```";
        blocks.push({
          type: "text",
          text: `Inline content of ${a.name || "attached file"} (${a.mimetype || "unknown"}, ${a.size || 0} bytes):\n\n${fence}\n${a.inline_text}\n${fence}`,
        });
      }
    }
    initialContent = blocks;
  } else {
    initialContent = transcript;
  }
  const messages = [{ role: "user", content: initialContent }];
  const trace = [];
  let iteration = 0;
  // Was 12; bumped to 25 to support batch CSV imports (May 9 import used 11 in
  // its final batch — already too close to the old ceiling). Safe to bump
  // because the cost guard below caps spend per conversation.
  const maxIterations = 25;
  // Cost ledger for this conversation. Starts at the value already accrued on
  // this thread (so a "continue" after pause counts toward the same budget
  // until /run resets it), or 0 if fresh. Updated after every messages.create.
  let conversationCostUsd = 0;
  // Cumulative token usage across all iterations of this run. Surfaced in the
  // result so logAgentAction can persist it to the audit table — letting us
  // verify caching is actually working (cache_read should be ≥ 80% of input
  // tokens after the first call within a 5-minute window).
  const usageTotals = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

  while (iteration < maxIterations) {
    iteration++;

    // Prompt caching: the system prompt + always-loaded tools are identical across
    // every iteration of this loop AND across every /run call (until the agent
    // restarts). Marking them with cache_control: ephemeral lets Anthropic serve
    // cache HITS for everything except the growing messages array. Cache reads are
    // ~10× cheaper than fresh tokens AND are excluded from the input-token rate
    // limit (per the dashboard "excluding cache reads"), preventing 30k/min
    // rate-limit errors during long tool-use chains.
    //
    // Anthropic disallows cache_control on tools with defer_loading=true (the two
    // features conflict). We put the breakpoint on the LAST non-deferred tool, so
    // everything before it (system + tool_search + always-loaded tools) gets cached.
    let cachedTools = tools;
    let lastCacheableIdx = -1;
    for (let i = tools.length - 1; i >= 0; i--) {
      if (!tools[i].defer_loading) { lastCacheableIdx = i; break; }
    }
    if (lastCacheableIdx >= 0) {
      cachedTools = tools.map((t, i) =>
        i === lastCacheableIdx ? { ...t, cache_control: { type: "ephemeral" } } : t
      );
    }
    const t0 = Date.now();
    let response;
    try {
      response = await anthropic.messages.create({
        model: AGENT_MODEL,
        // 8192 (was 2048): server-side tools like code_execution count their
        // bash + tool_result blocks toward output_tokens, and a multi-tool
        // turn (e.g. several Python snippets while parsing a CSV) easily
        // crosses 2048. Hitting max_tokens with server-side tool blocks
        // returns ok=false from the loop — work gets truncated mid-task.
        // Opus 4.7 supports ≥32k output; 8192 is plenty of headroom.
        max_tokens: 8192,
        system: [
          { type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } },
        ],
        tools: cachedTools,
        messages,
      });
    } catch (e) {
      // credit_balance_too_low arrives as HTTP 400, not 429 — generic retry libs
      // miss it. Catch explicitly so we surface a useful Slack message instead
      // of a JSON-blob error and so the loop stops cleanly mid-batch (the May
      // 2026 incident: 12 of 25 rows written, then the loop crashed silently).
      const msg = String(e?.message || "");
      const status = e?.status || e?.response?.status;
      if (status === 400 && /credit balance/i.test(msg)) {
        console.error(`[agent] credit exhausted on iter=${iteration} after tools=[${trace.map((t) => t.tool).join(",")}]`);
        return {
          ok: false,
          credit_exhausted: true,
          cost_usd: conversationCostUsd,
          summary:
            "Anthropic credits are exhausted, so I had to stop. Top up at console.anthropic.com and reply in this thread — I'll pick up where I left off (any rows I already wrote will be detected as duplicates and skipped).",
          stop_reason: "credit_exhausted",
          iterations: iteration,
          trace,
          placeholderRef,
          usage: usageTotals,
        };
      }
      // Anything else: rethrow so /run's catch surfaces it normally.
      throw e;
    }

    // Cost guard. After the response arrives, add this turn's cost to the
    // running ledger. If the per-conversation cap is exceeded, stop the loop
    // cleanly with a useful Slack message — the user can reply with anything
    // (most natural: "continue") and the next /run will reset the ledger.
    const turnCost = costOf(response.usage, AGENT_MODEL);
    conversationCostUsd += turnCost;
    // Accumulate token usage for audit visibility.
    usageTotals.input        += response.usage?.input_tokens || 0;
    usageTotals.output       += response.usage?.output_tokens || 0;
    usageTotals.cache_read   += response.usage?.cache_read_input_tokens || 0;
    usageTotals.cache_write  += response.usage?.cache_creation_input_tokens || 0;
    if (conversationCostUsd > MAX_USD_PER_CONVERSATION) {
      console.warn(`[agent] budget exhausted on iter=${iteration}: $${conversationCostUsd.toFixed(4)} > $${MAX_USD_PER_CONVERSATION}`);
      // Push the assistant turn before bailing so the audit trail captures it.
      messages.push({ role: "assistant", content: truncateLargeCodeExecOutputs(response.content) });

      // Build a "what was done so far" summary from the trace so on resume
      // the user (and Compass) can see progress without re-reading the audit.
      // Each /run is stateless — Compass loses the parsed CSV / lookup results
      // / etc. on the next run — but the Slack-visible message survives, so
      // putting concrete progress here means Compass on resume can pick up
      // intelligently rather than re-discovering everything.
      const toolCounts = {};
      for (const t of trace || []) {
        if (!t?.tool) continue;
        toolCounts[t.tool] = (toolCounts[t.tool] || 0) + 1;
      }
      const created = (trace || []).filter((t) => t.tool === "create_person" && t.result?.created).length;
      const existed = (trace || []).filter((t) => t.tool === "create_person" && t.result?.already_existed).length;
      const bulkResults = (trace || [])
        .filter((t) => t.tool === "bulk_import_people" && t.result?.results)
        .flatMap((t) => t.result.results);
      const bulkCreated = bulkResults.filter((r) => r.status === "created").length;
      const bulkExisted = bulkResults.filter((r) => r.status === "already_existed").length;
      const totalCreated = created + bulkCreated;
      const totalExisted = existed + bulkExisted;
      const toolSummary = Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name}×${n}`)
        .join(", ");

      let progressLine = "";
      if (totalCreated > 0 || totalExisted > 0) {
        progressLine = `\n\nProgress so far: ${totalCreated} people created, ${totalExisted} already existed (skipped).`;
      } else if (toolSummary) {
        progressLine = `\n\nActions so far: ${toolSummary}.`;
      }

      return {
        ok: false,
        budget_exhausted: true,
        cost_usd: conversationCostUsd,
        summary:
          `This task hit the $${MAX_USD_PER_CONVERSATION.toFixed(2)} per-conversation budget cap (spent $${conversationCostUsd.toFixed(2)}).${progressLine}\n\nReply 'continue' to extend with another budget — I'll pick up where I left off (any rows already done will be skipped automatically via the email-dedup check).`,
        stop_reason: "budget_exhausted",
        iterations: iteration,
        trace,
        placeholderRef,
        usage: usageTotals,
      };
    }

    messages.push({ role: "assistant", content: truncateLargeCodeExecOutputs(response.content) });

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    // Per-iteration diagnostic. Logs stop_reason, content block types, tool calls
    // attempted, text-block size, and elapsed ms. Designed to be grep-friendly so
    // we can diagnose "Compass said something then stopped" failures without
    // rerunning the request.
    const ms = Date.now() - t0;
    const blockTypes = response.content.map((b) => b.type);
    const tools_called = toolUseBlocks.map((b) => b.name);
    const textBlocks = response.content.filter((b) => b.type === "text");
    const textChars = textBlocks.reduce((n, b) => n + (b.text?.length || 0), 0);
    const usage = response.usage || {};
    console.log(`[agent] iter=${iteration} stop=${response.stop_reason} ms=${ms} blocks=[${blockTypes.join(",")}] tools=[${tools_called.join(",")}] text_chars=${textChars} cost=$${turnCost.toFixed(4)} run_cost=$${conversationCostUsd.toFixed(4)} input_tokens=${usage.input_tokens || "?"} cache_read=${usage.cache_read_input_tokens || 0} cache_write=${usage.cache_creation_input_tokens || 0} output_tokens=${usage.output_tokens || "?"}`);

    // Anomaly: stop_reason=end_turn with NO text content and NO tool calls is a
    // clear bug — model produced nothing actionable. Log loudly.
    if (response.stop_reason === "end_turn" && textChars === 0 && tools_called.length === 0) {
      console.error(`[agent] WARN iter=${iteration} ended with no content (no text, no tools)`);
    }
    // Anomaly: stop_reason=end_turn but tool_use blocks were present — model
    // intended to call tools but the API set end_turn instead of tool_use. We
    // process the calls anyway (the dispatch block below ignores stop_reason
    // and runs whatever tool_use blocks are in the response). Logged so we can
    // see how often this happens.
    if (response.stop_reason === "end_turn" && tools_called.length > 0) {
      console.error(`[agent] WARN iter=${iteration} end_turn with tool_use blocks — processing anyway: [${tools_called.join(",")}]`);
    }
    // Same for max_tokens — if the cutoff happened to land mid-response, we
    // still execute any tool_use blocks the model produced before truncation.
    if (response.stop_reason === "max_tokens" && tools_called.length > 0) {
      console.error(`[agent] WARN iter=${iteration} max_tokens with tool_use blocks — processing anyway: [${tools_called.join(",")}]`);
    }

    // Check for ask_for_clarification — terminate loop early
    const clarification = toolUseBlocks.find((b) => b.name === "ask_for_clarification");
    if (clarification) {
      trace.push({ tool: "ask_for_clarification", input: clarification.input });
      return {
        ok: false,
        clarification_needed: true,
        question: clarification.input.question,
        summary: clarification.input.question,
        cost_usd: conversationCostUsd,
        iterations: iteration,
        trace,
        placeholderRef,
        usage: usageTotals,
      };
    }

    // Check for stay_silent — terminate loop early WITHOUT posting to Slack.
    // Used when the trigger message wasn't actually directed at Compass (false-
    // positive name match) or there's nothing useful to add. The /run handler
    // checks result.silent and skips the postToSlack call.
    const silent = toolUseBlocks.find((b) => b.name === "stay_silent");
    if (silent) {
      trace.push({ tool: "stay_silent", input: silent.input });
      return {
        ok: true,
        silent: true,
        summary: `(silent: ${silent.input.reason || "no reason given"})`,
        cost_usd: conversationCostUsd,
        iterations: iteration,
        trace,
        placeholderRef,
        usage: usageTotals,
      };
    }

    // Process any tool_use blocks the model produced, regardless of stop_reason.
    // Anthropic's API normally pairs tool_use content with stop_reason=tool_use,
    // but we've seen end_turn-with-tools and max_tokens-with-tools in the wild.
    // Dispatching whenever tool_use blocks are present means we never silently
    // drop work the model intended to do.
    const dispatchableToolUses = toolUseBlocks.filter((b) => b.name !== "ask_for_clarification" && b.name !== "stay_silent");
    if (dispatchableToolUses.length > 0) {
      // The assistant turn (response.content, including these tool_use blocks)
      // was already pushed onto `messages` above. We just need to feed back the
      // matching tool_results.
      const toolResults = [];
      for (const block of dispatchableToolUses) {
        let result;
        const impl = toolImpls[block.name];
        const via = n8nTools.has(block.name) ? "n8n" : "js";
        // === Action ledger ===
        // For destructive external actions (ClickUp tasks, Gmail drafts,
        // Slack DMs, calendar invites), check the per-thread seen-actions
        // ledger first. If we've already done this exact call in this thread
        // recently, skip the side effect and return the cached result. Stops
        // a resumed run from double-creating tasks/drafts/invites — same
        // pattern as create_person's lookup-by-email dedup, generalised.
        let ledgerSig = null;
        const isLedgered = threadTs && THREAD_STATE.tableId && DESTRUCTIVE_EXTERNAL_TOOLS.has(block.name);
        if (isLedgered) {
          try {
            ledgerSig = await actionSignature(block.name, block.input);
            const seen = await findSeenAction(threadTs, ledgerSig);
            if (seen) {
              result = {
                ...seen.result,
                already_done: true,
                note: `This exact action was already completed in this thread on ${seen.ts}; returning the previous result rather than re-running it.`,
              };
            }
          } catch (e) {
            console.warn(`[action-ledger] lookup failed for ${block.name}: ${e.message} — proceeding without dedup`);
          }
        }
        if (!result) {
          if (!impl) {
            result = { error: `Tool not implemented: ${block.name}` };
          } else {
            try {
              // n8n-backed tools are registered as `impl(input)` rather than
              // method-on-this; the dispatch handles both: this binding for JS
              // tools that need cross-tool calls; plain input arg for n8n proxies.
              if (via === "n8n") {
                // Pass slack_context separately so the workflow can use it.
                result = await callN8nWebhook(block.name, block.input, slack_context);
              } else {
                // Spread so tool impls keep working via `this.<other_tool>`. The
                // running trace is exposed too in case a tool wants to enforce a
                // call-order invariant (no current users; kept for future-proofing).
                result = await impl.call({ ...toolImpls, _trace: trace }, block.input);
              }
            } catch (e) {
              result = { error: e.message };
            }
          }
          // Record successful destructive actions in the ledger. Ignore errors
          // and confirmation-required intermediate states — only commit a
          // signature once the action actually happened.
          if (isLedgered && ledgerSig && !result?.error && result?.status !== "confirmation_required") {
            try {
              await recordSeenAction(threadTs, ledgerSig, block.name, result);
            } catch (e) {
              console.warn(`[action-ledger] record failed for ${block.name}: ${e.message}`);
            }
          }
        }
        trace.push({ tool: block.name, input: block.input, result, via });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
        // Live progress: append a status line for this tool call. Marker:
        //   ✓  succeeded
        //   •  succeeded but de-duped via the action ledger ("already done")
        //   ⚠  errored (don't kill the run; agent may recover next turn)
        // pushProgress() collapses consecutive duplicates ("Looked up person ×3").
        const marker = result?.error ? ":warning:" : (result?.already_done || result?.already_existed) ? ":small_blue_diamond:" : ":white_check_mark:";
        pushProgress(marker, humanizeToolName(block.name));
      }
      // Single chat.update per iteration (batches all of this turn's tool
      // status lines into one Slack edit, avoids spamming the API).
      await flushProgress();
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return {
        ok: true,
        summary: textBlock?.text || "Done.",
        cost_usd: conversationCostUsd,
        iterations: iteration,
        trace,
        placeholderRef,
        usage: usageTotals,
      };
    }

    // Other stop reasons (max_tokens, stop_sequence, etc.) with no tool calls
    // to dispatch — surface what we have.
    const textBlock = response.content.find((b) => b.type === "text");
    return {
      ok: false,
      summary: textBlock?.text || `Stopped: ${response.stop_reason}`,
      stop_reason: response.stop_reason,
      cost_usd: conversationCostUsd,
      iterations: iteration,
      trace,
      placeholderRef,
      usage: usageTotals,
    };
  }

  return {
    ok: false,
    summary: "Max iterations reached.",
    cost_usd: conversationCostUsd,
    iterations: iteration,
    trace,
    placeholderRef,
    usage: usageTotals,
  };
}

// ---------- Slack helpers ----------

// Convert standard markdown to Slack's mrkdwn flavor.
// Claude writes **bold** and ## headings; Slack expects *bold* and doesn't render headings.
function toSlackMrkdwn(text) {
  if (!text) return text;
  return text
    // **bold** → *bold*
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    // ## Heading or ### Heading → *Heading*
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    // [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
}

async function postToSlack(channel, text, threadTs = null) {
  const body = { channel, text: toSlackMrkdwn(text) };
  if (threadTs) body.thread_ts = threadTs;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  // Slack returns HTTP 200 even on logical failures (channel_not_found, not_in_channel, etc).
  // Throw so the call-site try/catch can log it instead of pretending the post succeeded.
  if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error || JSON.stringify(data)}`);
  return data;
}

// Edit a previously-posted Slack message in place. Used for the live progress
// pattern: /run posts an "On it…" placeholder, runAgent updates it as work
// progresses, /run replaces it with the final answer at the end. Same mrkdwn
// rules as postToSlack.
async function updateSlackMessage(channel, ts, text) {
  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, ts, text: toSlackMrkdwn(text) }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack chat.update failed: ${data.error || JSON.stringify(data)}`);
  return data;
}

// Delete a previously-posted Slack message. Used when the agent decides to
// stay_silent after a placeholder was already posted — without this the user
// sees "On it…" stuck forever. Best-effort; failures logged but not thrown.
async function deleteSlackMessage(channel, ts) {
  const res = await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, ts }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack chat.delete failed: ${data.error || JSON.stringify(data)}`);
  return data;
}

// Human-readable label for a tool call, used in the live progress message.
// Curated overrides for the most common tools; fallback to a verb-from-snake-
// case heuristic. Goal: a non-technical reader (Yohan, Valerie) sees "Created
// person record" rather than "create_person" in the live status.
const TOOL_HUMAN_LABELS = {
  lookup_person: "Looked up person",
  lookup_cohort: "Looked up cohort",
  create_person: "Created person record",
  bulk_import_people: "Bulk-imported people",
  update_person: "Updated person",
  toggle_stage: "Updated onboarding stage",
  add_note: "Added note",
  link_person_to_cohort: "Linked person to cohort",
  log_touchpoint: "Logged touchpoint",
  list_people: "Listed people",
  list_clickup_tasks: "Listed ClickUp tasks",
  find_clickup_list: "Found ClickUp list",
  create_clickup_task: "Created ClickUp task",
  update_clickup_task: "Updated ClickUp task",
  delete_clickup_task: "Deleted ClickUp task",
  update_payment: "Updated payment",
  draft_email: "Drafted email",
  draft_welcome_email: "Drafted welcome email",
  draft_calendar_invite_email: "Drafted calendar invite",
  create_calendar_event: "Created calendar event",
  check_calendar_availability: "Checked calendar availability",
  send_slack_dm: "Sent Slack DM",
  send_channel_message: "Posted to Slack channel",
  create_slack_reminder: "Created Slack reminder",
  list_slack_reminders: "Listed Slack reminders",
  delete_slack_reminder: "Cancelled Slack reminder",
  read_channel_history: "Read channel history",
  lookup_slack_user: "Looked up Slack user",
  update_message: "Edited Slack message",
  delete_message: "Deleted Slack message",
  get_message_permalink: "Got message permalink",
  upload_file: "Uploaded file to Slack",
  update_calendar_event: "Updated calendar event",
  delete_calendar_event: "Deleted calendar event",
  create_docuseal_submission: "Sent DocuSeal contract",
  get_docuseal_submission: "Checked DocuSeal status",
  react_to_message: "Reacted to message",
  list_recent_actions: "Looked at recent actions",
  list_jotform_submissions: "Listed JotForm submissions",
  get_jotform_submission: "Got JotForm submission",
  find_person_by_phone: "Looked up person by phone",
  get_person_full: "Got full person record",
  list_tables: "Listed tables",
  create_table: "Created table",
  add_table_column: "Added table column",
  add_select_options: "Added dropdown options",
  bulk_create_records: "Bulk-created records",
  bulk_update_records: "Bulk-updated records",
  delete_records: "Deleted records",
  query_table: "Queried table",
  pin_knowledge: "Pinned knowledge",
  recall_knowledge: "Recalled knowledge",
  inspect_self: "Looked at self",
  inspect_slack_config: "Looked at Slack config",
  read_google_sheet: "Read Google Sheet",
  list_skills: "Listed skills",
  load_skill: "Loaded skill",
  code_execution: "Ran code",
  tool_search_tool_bm25: "Searched tools",
  view_prompt_body: "Read own prompt body",
  edit_prompt_body: "Edited own prompt body",
  replace_prompt_body: "Rewrote own prompt body",
  view_prompt_history: "Read prompt edit history",
  revert_prompt_body: "Reverted prompt body",
};
const VERB_MAP = {
  create: "Created", update: "Updated", delete: "Deleted",
  lookup: "Looked up", list: "Listed", get: "Got",
  find: "Found", add: "Added", send: "Sent",
  draft: "Drafted", check: "Checked", read: "Read",
  log: "Logged", pin: "Pinned", recall: "Recalled",
  load: "Loaded", search: "Searched", react: "Reacted",
  toggle: "Toggled", inspect: "Inspected", bulk: "Bulk",
  query: "Queried", link: "Linked", run: "Ran",
};
function humanizeToolName(name) {
  if (TOOL_HUMAN_LABELS[name]) return TOOL_HUMAN_LABELS[name];
  const parts = name.split("_");
  const verb = VERB_MAP[parts[0]] || (parts[0][0]?.toUpperCase() + parts[0].slice(1));
  const subject = parts.slice(1).join(" ");
  return subject ? `${verb} ${subject}` : verb;
}

// Generic Slack Web API call (GET-style with query string).
async function slackApi(method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error || JSON.stringify(data)}`);
  return data;
}

// Cached bot user id — used to label messages as "you" vs "user" in thread context.
let _botUserIdCache = null;
async function getBotUserId() {
  if (_botUserIdCache) return _botUserIdCache;
  try {
    const data = await slackApi("auth.test");
    _botUserIdCache = data.user_id;
    return _botUserIdCache;
  } catch (e) {
    console.error("[slack] auth.test failed:", e.message);
    return null;
  }
}

// Cache of user_id -> display_name (lightweight; never expires within process lifetime).
const _userNameCache = new Map();
async function getUserName(userId) {
  if (!userId) return "user";
  if (_userNameCache.has(userId)) return _userNameCache.get(userId);
  try {
    const data = await slackApi("users.info", { user: userId });
    const name = data.user?.profile?.display_name || data.user?.profile?.real_name || data.user?.name || userId;
    _userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// Format a Slack message list as a labeled chat transcript.
// Resolves Slack's <@USER_ID> mention syntax to readable @Name so the agent can
// tell when a message is addressed to someone else (key for the stay_silent
// false-positive check on side-conversations within threads).
//
// Historical attachments (m.files[]) are rendered as inline `[file: ...]` lines
// so the agent knows past messages had files even when those files aren't
// re-attached to the current request. Without this rendering the agent is
// blind to "look at the CSV I sent earlier" references.
async function formatSlackMessages(messages, botId) {
  const lines = [];
  for (const m of messages) {
    if (m.subtype === "bot_message" && !m.user) continue;
    const speaker = m.user === botId ? "Compass" : await getUserName(m.user);
    let text = m.text || "";
    // Resolve <@USER_ID> mentions to readable @Name labels.
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const matches = [...text.matchAll(mentionPattern)];
    for (const [match, userId] of matches) {
      const name = userId === botId ? "Compass" : await getUserName(userId);
      text = text.replace(match, `@${name}`);
    }
    text = text.trim();
    // Render attachments. Slack file shape: { id, name, mimetype, size, ... }.
    // We use Slack's native file id here, NOT an Anthropic file_id — the
    // historical message wasn't routed through n8n's upload step. The agent
    // sees the metadata and can ask the user to re-share if it needs the
    // contents.
    const fileLines = [];
    for (const f of m.files || []) {
      const parts = [
        `name=${f.name || "(unnamed)"}`,
        `mime=${f.mimetype || "?"}`,
        f.size ? `size=${f.size}` : null,
        `slack_file_id=${f.id || "?"}`,
      ].filter(Boolean);
      fileLines.push(`  [file: ${parts.join(" ")}]`);
    }
    if (!text && fileLines.length === 0) continue;
    if (text) lines.push(`${speaker}: ${text}`);
    else lines.push(`${speaker}: (file upload)`);
    if (fileLines.length > 0) lines.push(...fileLines);
  }
  return lines.join("\n");
}

// Fetch full thread (parent + replies) when the user is responding inside a thread.
// Throws on Slack errors so the caller can surface them to the agent (rather than silently returning empty).
async function fetchThreadContext(channel, threadTs, limit = 30) {
  const data = await slackApi("conversations.replies", { channel, ts: threadTs, limit });
  const botId = await getBotUserId();
  return await formatSlackMessages(data.messages || [], botId);
}

// Find files attached to the triggering Slack message. Used as a server-side
// fallback for the thread-reply and DM paths where n8n doesn't currently run
// the Files-API upload sub-flow. Returns the raw Slack file objects (with
// url_private_download), capped at MAX_FALLBACK_FILES. Best-effort: returns []
// on any Slack error rather than throwing, so /run still proceeds.
const MAX_FALLBACK_FILES = 5;
const MAX_FALLBACK_FILE_BYTES = 25 * 1024 * 1024; // Anthropic Files API limit
// Walk a list of Slack messages newest-first, collecting unique files.
// Dedupe by id first, then by (name, size) so re-uploads of the same CSV
// collapse to one (different slack ids, identical content — bloats input
// tokens and breaks prompt caching).
function collectUniqueFiles(messages, maxFiles, seenIds, seenContent) {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const f of messages[i].files || []) {
      if (!f?.id || seenIds.has(f.id)) continue;
      const contentKey = `${f.name || ""}|${f.size || 0}`;
      if (seenContent.has(contentKey)) {
        console.log(`[slack-files] dedup: skipping ${f.id} — same name+size (${contentKey})`);
        continue;
      }
      seenIds.add(f.id);
      seenContent.add(contentKey);
      out.push(f);
      if (out.length >= maxFiles) return out;
    }
  }
  return out;
}

async function fetchSlackTriggeringFiles(slackContext) {
  const channel = slackContext?.channel;
  // Bug fix May 12: n8n's text-path nodes (Mention/DM/Thread → agent) only
  // pass `thread_ts`, not the actual triggering message `ts`. So when ts is
  // missing we use thread_ts as a fallback — but we must NOT then pass that
  // as Slack's `latest` parameter (which means "messages with ts <= latest"),
  // because thread_ts IS the earliest message in the thread (the parent),
  // and `latest: parent_ts` filters out all the replies. Just walk the
  // whole thread/window when we don't have a precise trigger ts.
  const haveExplicitTs = !!slackContext?.ts && slackContext.ts !== slackContext.thread_ts;
  const triggerTs = slackContext?.ts || slackContext?.thread_ts;
  if (!channel || !triggerTs) {
    console.log(`[slack-files] skipping (missing channel/ts): channel=${channel} triggerTs=${triggerTs}`);
    return [];
  }
  const seenIds = new Set();
  const seenContent = new Set();
  const collected = [];

  // === Pass 1: thread (if applicable) ===
  if (slackContext.thread_ts) {
    try {
      const params = { channel, ts: slackContext.thread_ts, limit: 30 };
      if (haveExplicitTs) {
        params.latest = triggerTs;
        params.inclusive = true;
      }
      const data = await slackApi("conversations.replies", params);
      const messages = data.messages || [];

      // Triggering message takes priority if it has files.
      const target = messages.find((m) => m.ts === triggerTs);
      const triggerFiles = target?.files || [];
      const messagesWithFiles = messages.filter((m) => (m.files || []).length > 0);
      const allIds = messagesWithFiles.flatMap((m) => (m.files || []).map((f) => f?.id || "?"));
      console.log(
        `[slack-files] thread: ${messages.length} messages, ${messagesWithFiles.length} have files, ids=[${allIds.join(",")}]`
      );
      if (triggerFiles.length > 0) {
        console.log(`[slack-files] using ${triggerFiles.length} file(s) from triggering message`);
        return triggerFiles.slice(0, MAX_FALLBACK_FILES);
      }
      const fromThread = collectUniqueFiles(messages, MAX_FALLBACK_FILES, seenIds, seenContent);
      collected.push(...fromThread);
      if (collected.length > 0) {
        console.log(`[slack-files] thread walk-back: collected ${collected.length} (ids=[${collected.map((f) => f.id).join(",")}])`);
        return collected.slice(0, MAX_FALLBACK_FILES);
      }
    } catch (e) {
      console.warn(`[slack-files] thread scan failed: ${e.message}`);
    }
  }

  // === Pass 2: channel scan (always, but especially valuable when in a
  // thread that doesn't contain the file). Common pattern: user posts a
  // CSV at the channel level, then later starts a thread on something
  // else. The CSV is a sibling channel message — invisible to
  // conversations.replies on the unrelated thread. Catch it via
  // conversations.history near the trigger ts. ===
  try {
    const histParams = { channel, limit: 20 };
    if (haveExplicitTs) {
      histParams.latest = triggerTs;
      histParams.inclusive = true;
    }
    const data = await slackApi("conversations.history", histParams);
    const messages = (data.messages || []).slice().reverse(); // chronological
    const messagesWithFiles = messages.filter((m) => (m.files || []).length > 0);
    const allIds = messagesWithFiles.flatMap((m) => (m.files || []).map((f) => f?.id || "?"));
    console.log(
      `[slack-files] channel: ${messages.length} messages, ${messagesWithFiles.length} have files, ids=[${allIds.join(",")}]`
    );
    const fromChannel = collectUniqueFiles(messages, MAX_FALLBACK_FILES - collected.length, seenIds, seenContent);
    collected.push(...fromChannel);
    if (fromChannel.length > 0) {
      console.log(`[slack-files] channel walk-back: collected ${fromChannel.length} new (ids=[${fromChannel.map((f) => f.id).join(",")}])`);
    }
  } catch (e) {
    console.warn(`[slack-files] channel scan failed: ${e.message}`);
  }

  if (collected.length === 0) {
    console.log(`[slack-files] no files found in thread or channel scan`);
  }
  return collected.slice(0, MAX_FALLBACK_FILES);
}

// Per-process cache of slack_file_id -> anthropic upload result (file_id +
// inline text content for small text files). Files API uploads are free, but
// re-uploading the same CSV produces a new file_id and breaks prompt caching.
// Cache is wiped on Render restart; that's fine.
const _slackToAnthropicFileCache = new Map();

// Files > 4KB rely entirely on container_upload (which does NOT cost input
// tokens — file goes to sandbox, not model context, per Anthropic docs).
// Below 4KB inlining as text costs ~1k tokens at most and can act as a
// belt-and-braces fallback if container_upload fails (rare). Above that
// we'd be paying real money to bypass a free mechanism — not worth it.
const INLINE_TEXT_MAX_BYTES = 4 * 1024;
function isInlinableMime(mime) {
  if (!mime) return false;
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/x-ndjson" ||
    mime === "application/csv"
  );
}

// Download a Slack file's bytes via url_private_download, then upload to the
// Anthropic Files API. Returns an attachments[] entry shaped to match what
// n8n's mention-path sub-flow produces. For small text files, also includes
// the decoded content as `inline_text` so runAgent can inject it directly
// into the user message. Throws on hard errors so the caller can log and
// skip — we don't want one bad file to take down the whole run.
async function uploadSlackFileToAnthropic(file) {
  if (!file?.id) throw new Error("missing slack file id");
  const cached = _slackToAnthropicFileCache.get(file.id);
  if (cached) return cached;
  if (file.size && file.size > MAX_FALLBACK_FILE_BYTES) {
    throw new Error(`file ${file.name || file.id} exceeds ${MAX_FALLBACK_FILE_BYTES} bytes`);
  }
  const url = file.url_private_download || file.url_private;
  if (!url) throw new Error(`slack file ${file.id} has no url_private`);

  const dlRes = await fetch(url, {
    headers: { authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    redirect: "follow",
  });
  if (!dlRes.ok) throw new Error(`slack download ${dlRes.status}`);
  const buf = Buffer.from(await dlRes.arrayBuffer());

  const mime = file.mimetype || "application/octet-stream";
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), file.name || "upload.bin");
  const upRes = await fetch("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
    body: form,
  });
  if (!upRes.ok) {
    const text = await upRes.text();
    throw new Error(`anthropic files upload ${upRes.status}: ${text.slice(0, 200)}`);
  }
  const data = await upRes.json();
  if (!data.id) throw new Error(`anthropic files response missing id: ${JSON.stringify(data).slice(0, 200)}`);

  // For small text-based files, decode the bytes for inline injection. This
  // makes Compass able to read the content directly without relying on
  // container_upload + code_execution to deliver the file to the sandbox
  // (which has been unreliable in production).
  let inlineText = null;
  if (isInlinableMime(mime) && buf.length <= INLINE_TEXT_MAX_BYTES) {
    try {
      inlineText = buf.toString("utf8");
    } catch (e) {
      console.warn(`[slack-files] couldn't decode ${file.name} as utf8: ${e.message}`);
    }
  }

  const result = {
    file_id: data.id,
    name: file.name || "unnamed",
    mimetype: mime,
    size: file.size || buf.length,
    slack_file_id: file.id,
    inline_text: inlineText,
  };
  _slackToAnthropicFileCache.set(file.id, result);
  return result;
}

// Fetch recent channel messages (top-level only) for context when the user posts at the channel level.
// Throws on Slack errors so the caller can surface them to the agent.
async function fetchRecentChannelContext(channel, limit = 8) {
  const data = await slackApi("conversations.history", { channel, limit });
  const botId = await getBotUserId();
  // Reverse to chronological (Slack returns newest-first)
  const messages = (data.messages || []).slice().reverse();
  return await formatSlackMessages(messages, botId);
}

// Wrap the user's transcript with relevant Slack context so the agent isn't blind to prior messages.
// If thread_ts is set, fetches the thread. Otherwise fetches recent channel messages.
// On fetch failure, prepends a "context status" note so the agent knows context was unavailable
// (vs. simply absent) and can ask the user to re-summarize if needed.
async function enrichTranscriptWithContext(transcript, slackContext) {
  if (!slackContext?.channel) return transcript;
  let context = "";
  let contextNote = null;
  try {
    if (slackContext.thread_ts) {
      context = await fetchThreadContext(slackContext.channel, slackContext.thread_ts);
    } else {
      context = await fetchRecentChannelContext(slackContext.channel);
    }
  } catch (e) {
    console.error("[slack] context fetch failed:", e.message);
    contextNote = `Prior Slack context could not be fetched (${e.message}). The user may be referring to earlier messages I can't see — ask for a quick summary if their message is ambiguous.`;
  }
  if (contextNote) {
    return `## Context status\n${contextNote}\n\n## Current message to act on\n${transcript}`;
  }
  if (!context) return transcript;
  const label = slackContext.thread_ts ? "Thread context (chronological — most recent last)" : "Recent channel context (chronological)";
  return `## ${label}\n${context}\n\n## Current message to act on\n${transcript}`;
}

// ---------- Express server ----------

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// /version — what's actually running. Render injects RENDER_GIT_COMMIT /
// RENDER_GIT_BRANCH for deployed services; fall back to reading the local
// git HEAD when running outside Render (e.g. dev). The boot timestamp is
// captured once at module load — useful for noticing stale deploys.
const BOOT_TIME = new Date().toISOString();
function readLocalGitSha() {
  try {
    const headPath = path.join(__dirname, ".git", "HEAD");
    if (!fs.existsSync(headPath)) return null;
    const head = fs.readFileSync(headPath, "utf8").trim();
    if (head.startsWith("ref: ")) {
      const refPath = path.join(__dirname, ".git", head.slice(5));
      return fs.existsSync(refPath) ? fs.readFileSync(refPath, "utf8").trim() : null;
    }
    return head;
  } catch {
    return null;
  }
}
app.get("/version", (_req, res) => {
  res.json({
    commit: process.env.RENDER_GIT_COMMIT || readLocalGitSha() || "unknown",
    branch: process.env.RENDER_GIT_BRANCH || null,
    booted_at: BOOT_TIME,
    service: process.env.RENDER_SERVICE_NAME || null,
  });
});

// ---------- Google OAuth (Gmail) ----------

const GOOGLE_REDIRECT = `https://openclaude-agent.onrender.com/oauth/google/callback`;
// Scopes granted when the user OAuths.
//   gmail.compose         — create Gmail drafts (existing tools)
//   calendar.events       — create / update Calendar events on the user's calendar
//   calendar.readonly     — list events for free-busy lookups
//   spreadsheets.readonly — read Google Sheets (read_google_sheet tool)
// NOTE: existing refresh tokens issued before adding spreadsheets.readonly will
// NOT carry the new scope. Re-run the OAuth flow at /oauth/google/start to mint
// a fresh refresh token before read_google_sheet will work.
const GOOGLE_SCOPE = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
].join(" ");
const oauthStateStore = new Map(); // state → expiry timestamp

app.get("/oauth/google/start", (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(400).send("GOOGLE_CLIENT_ID not set on server");
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  oauthStateStore.set(state, Date.now() + 10 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GOOGLE_REDIRECT,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/oauth/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code || !state) return res.status(400).send("Missing code or state");
  const expiry = oauthStateStore.get(state);
  if (!expiry || expiry < Date.now()) return res.status(400).send("Invalid or expired state");
  oauthStateStore.delete(state);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  const tok = await tokenRes.json();
  if (!tokenRes.ok || !tok.refresh_token) {
    // Don't echo the raw response — it can contain access_token / refresh_token even on partial errors.
    const safe = {
      status: tokenRes.status,
      error: tok.error,
      error_description: tok.error_description,
      has_refresh_token: !!tok.refresh_token,
    };
    return res.status(500).send(`Token exchange failed: ${JSON.stringify(safe)}`);
  }

  // Render the refresh token in plain HTML so the operator can copy it once.
  res.setHeader("content-type", "text/html");
  res.send(`<!doctype html>
<html>
<head><title>Compass Google OAuth — done</title>
<style>body{font-family:system-ui;max-width:680px;margin:40px auto;padding:24px;color:#222} pre{background:#f4f4f4;padding:16px;border-radius:8px;word-break:break-all;white-space:pre-wrap} .ok{color:#2c7} ul{padding-left:24px}</style></head>
<body>
<h1 class="ok">✓ Google access authorized</h1>
<p>Compass now has the following access on your Google account:</p>
<ul>
<li><strong>Gmail compose</strong> — draft emails (you still review + send)</li>
<li><strong>Calendar events</strong> — create / update Calendar events on your calendar</li>
<li><strong>Calendar read</strong> — check free/busy before suggesting times</li>
</ul>
<p>Copy the refresh token below and set it as <code>GOOGLE_REFRESH_TOKEN</code> in Render → Environment.</p>
<pre>${tok.refresh_token}</pre>
<p>You can close this tab.</p>
</body></html>`);
});

// Helper: refresh access token from stored refresh token (used by email tools).
async function getGmailAccessToken() {
  const refresh = process.env.GOOGLE_REFRESH_TOKEN;
  if (!refresh) throw new Error("GOOGLE_REFRESH_TOKEN not set — OAuth flow not completed yet");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error(`Access token refresh failed: ${JSON.stringify(tok)}`);
  return tok.access_token;
}

// Email template loading
const EMAIL_TEMPLATES = {};
function loadTemplates() {
  const dir = path.join(__dirname, "templates");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".html")) {
      const key = file.replace(/\.html$/, "");
      EMAIL_TEMPLATES[key] = fs.readFileSync(path.join(dir, file), "utf8");
    }
  }
  console.log(`Loaded email templates: ${Object.keys(EMAIL_TEMPLATES).join(", ")}`);
}
loadTemplates();

// Skills loading — markdown files with YAML frontmatter (name + description).
// At startup we only register name + description; full content loads on-demand.
const SKILLS = {};
function loadSkills() {
  const dir = path.join(__dirname, "skills");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    let name = file.replace(/\.md$/, "");
    let description = "";
    let body = raw;
    if (fmMatch) {
      const frontmatter = fmMatch[1];
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
      body = raw.slice(fmMatch[0].length);
    }
    SKILLS[name] = { name, description, body, file };
  }
  if (Object.keys(SKILLS).length > 0) {
    console.log(`Loaded skills: ${Object.keys(SKILLS).join(", ")}`);
  }
}
loadSkills();

// Generated-tools loader removed alongside propose_new_tool (May 2026). New
// durable capabilities go in via normal PR; ad-hoc data work goes through the
// code_execution sandbox.

// Idempotent schema migration for the Agent actions audit table. Adds the
// `Trace detail` column (LongText) on boot if it doesn't already exist. Self-
// healing — runs against whichever NocoDB the env points at, no manual click
// in the UI required. If the column already exists, the meta GET sees it and
// the function returns without writing. If the audit table doesn't exist at
// all (AGENT_ACTIONS_TABLE_ID unset, or wrong id), we log and skip — audit
// logging is fire-and-forget elsewhere, so a broken table just means a
// missing audit row, not a failed boot.
async function ensureAuditSchema() {
  if (!AGENT_ACTIONS_TABLE_ID) {
    console.log("[migrate] AGENT_ACTIONS_TABLE_ID not set — skipping audit schema check");
    return;
  }
  // Add any missing columns. Each entry is { title, uidt } — idempotent: if
  // it's already there, skip. Centralised so adding a new audit column is one
  // line. Order matters for first-time creation: NocoDB shows them in the UI
  // in the order they were added.
  const desired = [
    { title: "Trace detail",   uidt: "LongText" },
    { title: "Cost USD",       uidt: "Decimal" },
    { title: "Input tokens",   uidt: "Number" },
    { title: "Output tokens",  uidt: "Number" },
    { title: "Cache read tokens",  uidt: "Number" },
    { title: "Cache write tokens", uidt: "Number" },
  ];
  try {
    const meta = await ncGet(`/api/v2/meta/tables/${AGENT_ACTIONS_TABLE_ID}`);
    const have = new Set((meta?.columns || []).map((c) => c.title));
    const missing = desired.filter((c) => !have.has(c.title));
    if (missing.length === 0) {
      console.log("[migrate] audit table has all expected columns");
      return;
    }
    for (const col of missing) {
      console.log(`[migrate] adding column ${col.title} (${col.uidt}) to audit table…`);
      await ncPost(`/api/v2/meta/tables/${AGENT_ACTIONS_TABLE_ID}/columns`, {
        column_name: col.title,
        title: col.title,
        uidt: col.uidt,
      });
    }
    console.log(`[migrate] added ${missing.length} audit column(s)`);
  } catch (e) {
    // Don't block boot — audit logging tolerates missing fields (NocoDB drops
    // unknown keys silently). Surface loudly so we notice in Render logs.
    console.error(`[migrate] ensureAuditSchema failed (continuing): ${e.message}`);
  }
}
await ensureAuditSchema();

// ---------- Thread state table (in-flight tracking + cost ledger + idempotency) ----------
//
// One small NocoDB table that gives /run three things it didn't have before:
//   - awareness of in-flight work on the same Slack thread (stops "you doing
//     it?" nags from racing the original run)
//   - per-conversation cost tracking (soft cap at MAX_USD_PER_CONVERSATION,
//     resets when the user explicitly continues)
//   - per-thread idempotency keys for destructive external actions (so a
//     resumed run after credit-exhaust doesn't double-create ClickUp tasks /
//     Gmail drafts / calendar invites)
//
// The table is auto-created on boot in the same base as the People table, so
// no manual NocoDB clicking is required. The discovered table_id is cached on
// THREAD_STATE.tableId for the rest of the process lifetime. If creation
// fails (read-only token, base permission missing) the helpers below fall
// back to no-ops, so the agent still works — just without thread-state
// awareness.

const THREAD_STATE = { tableId: process.env.THREAD_STATE_TABLE_ID || null };
const THREAD_STATE_TABLE_TITLE = "Compass thread state";

// Tunable budget cap. $1.50 per conversation accommodates a realistic CSV
// import (25-row people-import was already $0.79 and getting cut off mid-task)
// while still tripping the guard before runaway loops cost anything material.
// Bumped per "continue" by the user (the next run on a `budget_exhausted`
// thread resets cost_usd to 0 before proceeding).
const MAX_USD_PER_CONVERSATION = parseFloat(process.env.MAX_USD_PER_CONVERSATION || "5.00");

// Pricing table for cost guard. Keep in sync with
// https://docs.claude.com/en/docs/about-claude/pricing — out of date prices
// just mean the cap fires at a slightly wrong dollar value, not that anything
// breaks. Add new models as we adopt them.
const PRICES_PER_MTOK = {
  "claude-sonnet-4-7": { in: 3.0, cache_write_5m: 3.75, cache_read: 0.30, out: 15.0 },
  "claude-sonnet-4-6": { in: 3.0, cache_write_5m: 3.75, cache_read: 0.30, out: 15.0 },
  "claude-sonnet-4-5": { in: 3.0, cache_write_5m: 3.75, cache_read: 0.30, out: 15.0 },
  "claude-haiku-4-5":  { in: 1.0, cache_write_5m: 1.25, cache_read: 0.10, out: 5.0 },
  "claude-opus-4-7":   { in: 5.0, cache_write_5m: 6.25, cache_read: 0.50, out: 25.0 },
};

function costOf(usage, model) {
  const p = PRICES_PER_MTOK[model] || PRICES_PER_MTOK["claude-sonnet-4-6"];
  return (
    (usage?.input_tokens || 0)                * p.in              / 1e6 +
    (usage?.cache_creation_input_tokens || 0) * p.cache_write_5m  / 1e6 +
    (usage?.cache_read_input_tokens || 0)     * p.cache_read      / 1e6 +
    (usage?.output_tokens || 0)               * p.out              / 1e6
  );
}

async function ensureThreadStateTable() {
  // If pinned via env, skip discovery — operator has set it explicitly.
  if (THREAD_STATE.tableId) {
    console.log(`[migrate] thread state table pinned via env: ${THREAD_STATE.tableId}`);
    return;
  }
  if (!PEOPLE_TABLE_ID) {
    console.warn("[migrate] PEOPLE_TABLE_ID not set — cannot discover base for thread state table");
    return;
  }
  try {
    const peopleMeta = await ncGet(`/api/v2/meta/tables/${PEOPLE_TABLE_ID}`);
    const baseId = peopleMeta?.base_id || peopleMeta?.source_id || peopleMeta?.fk_base_id;
    if (!baseId) {
      console.warn("[migrate] could not resolve base_id from People table — skipping thread state setup");
      return;
    }
    const tablesResp = await ncGet(`/api/v2/meta/bases/${baseId}/tables`);
    const tables = tablesResp?.list || tablesResp?.tables || tablesResp || [];
    const existing = tables.find((t) => t.title === THREAD_STATE_TABLE_TITLE);
    if (existing) {
      THREAD_STATE.tableId = existing.id;
      console.log(`[migrate] thread state table found: ${existing.id}`);
      return;
    }
    console.log(`[migrate] creating ${THREAD_STATE_TABLE_TITLE} table…`);
    const created = await ncPost(`/api/v2/meta/bases/${baseId}/tables`, {
      table_name: THREAD_STATE_TABLE_TITLE,
      title: THREAD_STATE_TABLE_TITLE,
      columns: [
        { column_name: "thread_ts", title: "thread_ts", uidt: "SingleLineText" },
        { column_name: "status", title: "status", uidt: "SingleLineText" },
        { column_name: "last_started", title: "last_started", uidt: "DateTime" },
        { column_name: "last_completed", title: "last_completed", uidt: "DateTime" },
        { column_name: "seen_actions", title: "seen_actions", uidt: "LongText" },
        { column_name: "cost_usd", title: "cost_usd", uidt: "Decimal" },
        { column_name: "last_summary", title: "last_summary", uidt: "LongText" },
      ],
    });
    THREAD_STATE.tableId = created?.id;
    console.log(`[migrate] thread state table created: ${THREAD_STATE.tableId}`);
  } catch (e) {
    console.error(`[migrate] ensureThreadStateTable failed (continuing without thread state): ${e.message}`);
  }
}
await ensureThreadStateTable();

// ---------- Editable prompt body table (auto-discovery + bootstrap) ----------
// Mirrors ensureThreadStateTable: pin via env if set, otherwise look up by title
// in the same NocoDB base, otherwise create. After this resolves, loadPromptBody
// either reads the existing latest Version row or seeds Version=1 from SEED_PROMPT_BODY.

async function ensurePromptTable() {
  if (PROMPT_TABLE.tableId) {
    console.log(`[migrate] compass_prompt table pinned via env: ${PROMPT_TABLE.tableId}`);
    return;
  }
  if (!PEOPLE_TABLE_ID) {
    console.warn("[migrate] PEOPLE_TABLE_ID not set — cannot discover base for compass_prompt table");
    return;
  }
  try {
    const peopleMeta = await ncGet(`/api/v2/meta/tables/${PEOPLE_TABLE_ID}`);
    const baseId = peopleMeta?.base_id || peopleMeta?.source_id || peopleMeta?.fk_base_id;
    if (!baseId) {
      console.warn("[migrate] could not resolve base_id from People table — skipping compass_prompt setup");
      return;
    }
    const tablesResp = await ncGet(`/api/v2/meta/bases/${baseId}/tables`);
    const tables = tablesResp?.list || tablesResp?.tables || tablesResp || [];
    const existing = tables.find((t) => t.title === PROMPT_TABLE_TITLE);
    if (existing) {
      PROMPT_TABLE.tableId = existing.id;
      console.log(`[migrate] compass_prompt table found: ${existing.id}`);
      return;
    }
    console.log(`[migrate] creating ${PROMPT_TABLE_TITLE} table…`);
    const created = await ncPost(`/api/v2/meta/bases/${baseId}/tables`, {
      table_name: PROMPT_TABLE_TITLE,
      title: PROMPT_TABLE_TITLE,
      columns: [
        { column_name: "Body",      title: "Body",      uidt: "LongText" },
        { column_name: "Version",   title: "Version",   uidt: "Number" },
        { column_name: "UpdatedBy", title: "UpdatedBy", uidt: "SingleLineText" },
        { column_name: "Reason",    title: "Reason",    uidt: "LongText" },
      ],
    });
    PROMPT_TABLE.tableId = created?.id;
    console.log(`[migrate] compass_prompt table created: ${PROMPT_TABLE.tableId}`);
  } catch (e) {
    console.error(`[migrate] ensurePromptTable failed (continuing with in-code SEED fallback): ${e.message}`);
  }
}
await ensurePromptTable();
await loadPromptBody();

// === Thread state CRUD helpers ===
// All silently no-op if THREAD_STATE.tableId is null (auto-create failed or
// not yet pinned). The agent runs as it did before, just without the
// in-flight awareness / cost guard / action ledger features.

async function getThreadState(threadTs) {
  if (!THREAD_STATE.tableId || !threadTs) return null;
  try {
    const where = `(thread_ts,eq,${threadTs})`;
    const data = await ncGet(
      `/api/v2/tables/${THREAD_STATE.tableId}/records?where=${encodeURIComponent(where)}&limit=1`
    );
    return data?.list?.[0] || null;
  } catch (e) {
    console.error(`[thread-state] getThreadState(${threadTs}) failed:`, e.message);
    return null;
  }
}

async function upsertThreadState(threadTs, fields) {
  if (!THREAD_STATE.tableId || !threadTs) return null;
  try {
    const existing = await getThreadState(threadTs);
    if (existing) {
      await ncPatch(`/api/v2/tables/${THREAD_STATE.tableId}/records`, [
        { Id: existing.Id, ...fields },
      ]);
      return { ...existing, ...fields };
    }
    const created = await ncPost(`/api/v2/tables/${THREAD_STATE.tableId}/records`, [
      { thread_ts: threadTs, ...fields },
    ]);
    return Array.isArray(created) ? created[0] : created;
  } catch (e) {
    console.error(`[thread-state] upsertThreadState(${threadTs}) failed:`, e.message);
    return null;
  }
}

// Stable canonical-JSON for hashing — sort keys, drop undefineds. Two calls
// with the same logical args hash the same regardless of property order.
function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

async function sha256(s) {
  // Use Web Crypto via the Node global (Node 20+).
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function actionSignature(toolName, args) {
  return sha256(toolName + ":" + canonicalJson(args));
}

async function findSeenAction(threadTs, sig) {
  const state = await getThreadState(threadTs);
  if (!state) return null;
  let arr;
  try {
    arr = JSON.parse(state.seen_actions || "[]");
  } catch {
    arr = [];
  }
  return arr.find((a) => a.sig === sig) || null;
}

async function recordSeenAction(threadTs, sig, toolName, result) {
  const state = await getThreadState(threadTs);
  let arr;
  try {
    arr = JSON.parse(state?.seen_actions || "[]");
  } catch {
    arr = [];
  }
  // Cap at 100 entries — older falls off. A thread doing more than 100
  // distinct destructive actions is something we want to notice anyway.
  arr.push({ sig, tool: toolName, result, ts: new Date().toISOString() });
  if (arr.length > 100) arr = arr.slice(-100);
  await upsertThreadState(threadTs, { seen_actions: JSON.stringify(arr) });
}

// Tools whose calls have external side effects with no built-in idempotency.
// create_person already has its own lookup-by-email dedup; toggle_stage and
// add_note are reversible and rapid-fire is fine. These four are the ones
// that genuinely need replay protection if a run resumes after partial work.
const DESTRUCTIVE_EXTERNAL_TOOLS = new Set([
  "create_clickup_task",
  "draft_email",
  "draft_welcome_email",
  "send_slack_dm",
  "send_channel_message",
  "create_calendar_event",
  "create_docuseal_submission",
]);

class BudgetExhausted extends Error {
  constructor(spent) {
    super(`per-conversation budget cap of $${MAX_USD_PER_CONVERSATION} exceeded ($${spent.toFixed(4)} spent)`);
    this.spent = spent;
    this.name = "BudgetExhausted";
  }
}

function renderTemplate(name, vars) {
  let html = EMAIL_TEMPLATES[name];
  if (!html) throw new Error(`Unknown template: ${name}`);
  for (const [k, v] of Object.entries(vars)) {
    html = html.replaceAll(`{{${k}}}`, v ?? "");
  }
  return html;
}

// Build a base64url-encoded RFC822 MIME message for Gmail API.
function buildMimeMessage({ from, to, subject, html, replyTo = null }) {
  const boundary = `_b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  // Plain-text fallback (very simple — strip tags from HTML)
  const text = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const body = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    html,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const raw = headers.join("\r\n") + "\r\n\r\n" + body;
  // Gmail API wants base64url
  return Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Format a Date as the ICS local-UTC timestamp (YYYYMMDDTHHMMSSZ).
function formatICSDate(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Escape a string for inclusion in an ICS field per RFC 5545 §3.3.11.
function escapeICS(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// Build a minimal RFC 5545 VCALENDAR/VEVENT for an onboarding invite.
function buildICS({ uid, startUTC, endUTC, title, description, organizerName, organizerEmail, attendeeName, attendeeEmail, location }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Compass//Onboarding//EN",
    "METHOD:REQUEST",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatICSDate(new Date())}`,
    `DTSTART:${formatICSDate(startUTC)}`,
    `DTEND:${formatICSDate(endUTC)}`,
    `SUMMARY:${escapeICS(title)}`,
    `DESCRIPTION:${escapeICS(description)}`,
    `ORGANIZER;CN=${escapeICS(organizerName)}:mailto:${organizerEmail}`,
    `ATTENDEE;CN=${escapeICS(attendeeName)};RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${attendeeEmail}`,
  ];
  if (location) lines.push(`LOCATION:${escapeICS(location)}`);
  lines.push("STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

// Build a multipart/mixed MIME message containing both an HTML/plain body and
// an ICS attachment, suitable for Gmail's drafts.create endpoint.
function buildCalendarInviteMime({ from, to, subject, html, ics }) {
  const outer = `_o_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const inner = `_i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const text = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${outer}"`,
  ];
  const body = [
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    "",
    `--${inner}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${inner}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    html,
    "",
    `--${inner}--`,
    "",
    `--${outer}`,
    'Content-Type: text/calendar; method=REQUEST; charset=UTF-8; name="invite.ics"',
    "Content-Transfer-Encoding: 7bit",
    'Content-Disposition: attachment; filename="invite.ics"',
    "",
    ics,
    "",
    `--${outer}--`,
    "",
  ].join("\r\n");
  const raw = headers.join("\r\n") + "\r\n\r\n" + body;
  return Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Get the authenticated Gmail user's "From" address (the connected account's email).
async function getGmailFromAddress(accessToken) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!data.emailAddress) throw new Error(`Failed to fetch Gmail profile: ${JSON.stringify(data)}`);
  return data.emailAddress;
}

// Light PII redaction for tool inputs going into the audit trail. Keeps the
// shape of the data so it's debuggable, hides the value. Audit trail lives in
// our own NocoDB so this is belt-and-braces, not a privacy boundary.
function redactValue(v) {
  if (v == null) return v;
  if (typeof v === "string") {
    // Email
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      const [local, domain] = v.split("@");
      return `${local[0]}***@${domain}`;
    }
    // Phone (any string of mostly digits, ≥7)
    const digits = v.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length / v.length > 0.5) {
      return `***${digits.slice(-3)}`;
    }
    return v.length > 200 ? v.slice(0, 200) + `…(${v.length})` : v;
  }
  return v;
}
function redactToolInput(input) {
  if (!input || typeof input !== "object") return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const lk = k.toLowerCase();
    if (lk.includes("email") || lk.includes("phone") || lk === "to_email" || lk === "to") {
      out[k] = redactValue(v);
    } else if (Array.isArray(v)) {
      out[k] = v.length > 10 ? `[array len=${v.length}]` : v.map(redactValue);
    } else if (typeof v === "object") {
      out[k] = "[object]";
    } else {
      out[k] = redactValue(v);
    }
  }
  return out;
}

// Log every agent run to the Agent actions audit table.
// Fire-and-forget — failures here shouldn't fail the response.
//
// Trace summary now includes tool *inputs* (PII-redacted, truncated) so
// "what did Compass actually do at 4:15 PM" is answerable from NocoDB without
// re-reading Render logs. Outputs are not logged (too verbose, varies wildly);
// the tool name + redacted input is enough to reconstruct intent.
async function logAgentAction({ transcript, slack_context, result, elapsedMs }) {
  if (!AGENT_ACTIONS_TABLE_ID) return;
  try {
    const source = slack_context?.file_id ? "Slack voice" : (slack_context?.channel ? "Slack text" : "API call");
    const trace = result.trace || [];
    const toolsUsed = trace.map((t) => t.tool).filter(Boolean);
    const traceWithInputs = trace
      .map((t) => ({ tool: t.tool, input: redactToolInput(t.input) }))
      .slice(0, 50); // cap to avoid massive audit rows
    const summaryShort = (result.summary || "").slice(0, 200).replace(/\n+/g, " ");
    const usage = result.usage || {};
    const payload = {
      Summary: summaryShort || (result.error ? `Error: ${result.error.slice(0, 180)}` : "agent run"),
      Transcript: transcript,
      "Agent response": result.summary || "",
      "Tools used": JSON.stringify(toolsUsed),
      // 32KB cap — bumped from 8KB to comfortably hold a 25-row CSV import
      // trace (each tool call is ~250-400 bytes after PII redaction). NocoDB
      // LongText handles this without issue.
      "Trace detail": JSON.stringify(traceWithInputs).slice(0, 32000),
      Iterations: result.iterations || 0,
      "Elapsed ms": elapsedMs,
      Success: !!result.ok,
      "Needed clarification": !!result.clarification_needed,
      Source: source,
      "Slack channel": slack_context?.channel || null,
      "Slack user id": slack_context?.user_id || null,
      // Usage breakdown for caching visibility. After warm-up, cache_read
      // should be ≥ 80% of input_tokens. If it's near zero, prompt caching
      // is broken and we're paying full price every call.
      "Cost USD": result.cost_usd != null ? Number(result.cost_usd.toFixed(6)) : null,
      "Input tokens": usage.input || null,
      "Output tokens": usage.output || null,
      "Cache read tokens": usage.cache_read || null,
      "Cache write tokens": usage.cache_write || null,
    };
    await ncPost(`/api/v2/tables/${AGENT_ACTIONS_TABLE_ID}/records`, [payload]);
  } catch (e) {
    console.error(`[audit] failed to log agent action:`, e.message);
  }
}

// Constant-time string compare to avoid timing leaks on the shared secret.
function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

app.post("/run", async (req, res) => {
  // Auth gate. RUN_SHARED_SECRET is required in production — n8n sends it as
  // X-Run-Secret. We also accept Authorization: Bearer <secret> for callers
  // that prefer the standard header. Boot already aborts if the var is unset
  // (see requiredEnv), so anything reaching here must present it.
  const provided =
    req.get("x-run-secret") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!timingSafeEq(provided, RUN_SHARED_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { transcript, slack_context, attachments } = req.body || {};
  if (!transcript || typeof transcript !== "string") {
    return res.status(400).json({ error: "transcript required" });
  }
  // attachments[] is optional. Each entry: { file_id, name, mimetype, size,
  // role? } — file_id is the Anthropic Files API id (n8n uploads on receipt).
  // Validate shape loosely — we don't pin a prefix because Anthropic may
  // change their id format (and have done so silently in the past). Just
  // require a non-empty string. Anything that fails this is logged and
  // dropped; the API will reject genuinely-bad ids when we send the request,
  // which surfaces as a normal error rather than silent attachment-blindness.
  const validAttachments = Array.isArray(attachments)
    ? attachments.filter(
        (a) => a && typeof a === "object" && typeof a.file_id === "string" && a.file_id.length > 0
      )
    : [];
  if (Array.isArray(attachments) && attachments.length !== validAttachments.length) {
    console.warn(
      `[agent] dropped ${attachments.length - validAttachments.length} malformed attachment(s) — bad shape: ${JSON.stringify(
        attachments.filter((a) => !validAttachments.includes(a))
      ).slice(0, 200)}`
    );
  }

  // Server-side fallback: if n8n didn't forward any attachments (thread-reply
  // and DM paths don't currently run the Files-API sub-flow), look at the
  // triggering Slack message ourselves, download any files via SLACK_BOT_TOKEN,
  // and upload them to the Anthropic Files API. This makes file uploads work
  // uniformly across mention / name-match / thread-reply / DM without needing
  // four copies of the same sub-flow in n8n.
  const runAttachments = [...validAttachments];
  if (validAttachments.length > 0) {
    console.log(`[agent] received ${validAttachments.length} attachment(s) from n8n: ${validAttachments.map((a) => a.file_id).join(",")}`);
  }
  if (runAttachments.length === 0 && slack_context?.channel) {
    console.log(`[agent] no n8n attachments — running slack-files fallback (channel=${slack_context.channel} ts=${slack_context.ts} thread_ts=${slack_context.thread_ts})`);
    const slackFiles = await fetchSlackTriggeringFiles(slack_context);
    if (slackFiles.length > 0) {
      console.log(`[agent] slack-files fallback: ${slackFiles.length} file(s) — uploading to Anthropic`);
      for (const f of slackFiles) {
        try {
          const entry = await uploadSlackFileToAnthropic(f);
          runAttachments.push(entry);
          console.log(`[agent] slack-files fallback uploaded ${entry.name} (${entry.size}B) → ${entry.file_id}`);
        } catch (e) {
          console.error(`[agent] slack-files fallback skipped ${f.name || f.id}: ${e.message}`);
        }
      }
    }
  }

  console.log(`[agent] transcript: ${redactPII(transcript).slice(0, 200)}`);
  const t0 = Date.now();

  // === Thread guard ===
  // Looks at the existing state of this Slack thread (if any) and decides
  // whether to proceed normally, react-and-stay-silent (the "you doing it?"
  // race), or take over a stale in-flight run. Resets cost/state on resume
  // from a budget_exhausted or credit_paused thread so the user's "continue"
  // gets a fresh per-conversation budget.
  //
  // Returns one of:
  //   { proceed: true, resetCost: bool }
  //   { proceed: false, react: ":eyes:" }   ← skip this run, react instead
  //
  // Silently passes through (proceed: true) if THREAD_STATE.tableId is null
  // — graceful degradation if the table didn't auto-create.
  const threadTs = slack_context?.thread_ts || slack_context?.ts || null;
  let resumeFromPause = false;
  if (threadTs && THREAD_STATE.tableId) {
    const state = await getThreadState(threadTs);
    const now = Date.now();
    if (state) {
      const status = state.status;
      const lastStartedMs = state.last_started ? new Date(state.last_started).getTime() : 0;
      const ageSec = (now - lastStartedMs) / 1000;
      if (status === "in_flight" && ageSec < 60) {
        // Active run is still working. Don't race it — react and bail.
        console.log(`[thread-guard] thread ${threadTs} in-flight ${ageSec.toFixed(0)}s ago — skipping nag`);
        if (slack_context?.channel) {
          try {
            await fetch("https://slack.com/api/reactions.add", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${SLACK_BOT_TOKEN}`,
              },
              body: JSON.stringify({
                channel: slack_context.channel,
                timestamp: slack_context.ts || threadTs,
                name: "eyes",
              }),
            });
          } catch (e) {
            console.warn(`[thread-guard] reaction failed: ${e.message}`);
          }
        }
        return res.json({ ok: true, silent: true, reason: "in_flight_nag", elapsedMs: Date.now() - t0 });
      }
      if (status === "in_flight" && ageSec >= 60) {
        // Previous run died (Render restart, crash, timeout). Take over.
        console.warn(`[thread-guard] thread ${threadTs} stale in_flight (${ageSec.toFixed(0)}s) — taking over`);
      }
      if (status === "budget_exhausted" || status === "credit_paused") {
        // User has replied after a paused run — treat this as a "continue".
        // Reset cost; the new run gets a fresh per-conversation budget.
        console.log(`[thread-guard] thread ${threadTs} resuming from ${status}`);
        resumeFromPause = true;
      }
    }
    await upsertThreadState(threadTs, {
      status: "in_flight",
      last_started: new Date().toISOString(),
      ...(resumeFromPause ? { cost_usd: 0 } : {}),
    });
  }

  let enrichedTranscript = transcript;
  if (slack_context?.channel) {
    try {
      enrichedTranscript = await enrichTranscriptWithContext(transcript, slack_context);
      const ctxBytes = enrichedTranscript.length - transcript.length;
      if (ctxBytes > 0) console.log(`[agent] enriched transcript with ${ctxBytes} bytes of Slack context`);
    } catch (e) {
      console.error(`[agent] context enrichment failed (continuing with raw transcript):`, e.message);
    }
  }
  // n8n's voice path passes file_id in slack_context. Mark the transcript so the
  // agent knows it's looking at speech-to-text output and can be forgiving about
  // phonetic near-misses on names, garbled emails, etc.
  if (slack_context?.file_id) {
    enrichedTranscript = `## Source: voice transcript\n\n${enrichedTranscript}`;
  }
  // Surface the triggering message identifiers to the agent so it can react to
  // the message (react_to_message tool) without needing them passed in tool args.
  // Note: for thread replies, slack_context.thread_ts is the PARENT's ts, not the
  // reply's. Reacting will land on the thread parent. For top-level messages
  // (most common), thread_ts equals event.ts so this targets the right message.
  if (slack_context?.channel) {
    const fromId = slack_context.user_id || null;
    const teamMap = {
      [process.env.YOHAN_SLACK_ID]: "yohan",
      [process.env.VALERIE_SLACK_ID]: "valerie",
      [process.env.NATHAN_SLACK_ID]: "nathan",
    };
    const fromName = fromId ? (teamMap[fromId] || null) : null;
    const fromLine = fromId
      ? `from_user_id: ${fromId}${fromName ? ` (${fromName})` : ""}\n`
      : "";
    const ref = `## Slack message reference\nchannel: ${slack_context.channel}\nmessage_ts: ${slack_context.thread_ts || slack_context.ts || "(unknown)"}\n${fromLine}\n`;
    enrichedTranscript = ref + enrichedTranscript;
  }
  // If files arrived, append a manifest so the model sees them in the prompt
  // text too. Phrasing matters: this manifest only ever lists ANTHROPIC
  // file_ids (uploaded by n8n via the Files API). The agent must NOT confuse
  // them with Slack file IDs that show up in thread-context history lines.
  if (runAttachments.length > 0) {
    const manifest = runAttachments
      .map((a) => `  - ${a.name || "unnamed"} · ${a.mimetype || "unknown"} · ${a.size ? a.size + " bytes" : "size unknown"} · anthropic_file_id=${a.file_id}`)
      .join("\n");
    enrichedTranscript += `\n\n## Attached files in THIS message (Anthropic Files API; readable)\n${manifest}\n\nThese are real, readable Anthropic file_ids. Use code_execution for CSV/JSON/text (they land at /mnt/user-data/uploads/). Read PDFs and images directly via their content blocks.`;
  }

  // Note: the live-progress placeholder is now posted lazily by runAgent — it
  // fires the first time a tool is dispatched, not at /run start. This means
  // stay_silent runs and pure-text replies never post a placeholder, fixing
  // the "Compass don't reply to this" → flash of 'On it…' then disappears
  // bug. /run reads result.placeholderRef below to decide whether to edit
  // the existing placeholder or post fresh.
  let result;
  try {
    result = await runAgent(enrichedTranscript, slack_context, runAttachments, threadTs);
  } catch (e) {
    console.error(`[agent] error:`, e);
    result = { ok: false, summary: `Error: ${e.message}`, error: e.message };
  }
  const placeholderRef = result.placeholderRef || null;
  const elapsedMs = Date.now() - t0;
  console.log(`[agent] done in ${elapsedMs}ms, ok=${result.ok}, iterations=${result.iterations}`);

  // Update thread state with the run outcome. Idempotent / fire-and-forget —
  // if the table doesn't exist or the write fails, the agent still works.
  if (threadTs && THREAD_STATE.tableId) {
    const finalStatus = result.budget_exhausted
      ? "budget_exhausted"
      : result.credit_exhausted
        ? "credit_paused"
        : "done";
    upsertThreadState(threadTs, {
      status: finalStatus,
      last_completed: new Date().toISOString(),
      cost_usd: result.cost_usd ?? null,
      last_summary: (result.summary || "").slice(0, 500),
    }).catch((e) => console.error(`[thread-state] post-run update failed: ${e.message}`));
  }

  // Audit log — fire-and-forget, don't block the response on it
  logAgentAction({ transcript, slack_context, result, elapsedMs });

  // Reply to Slack — either by editing the live-progress placeholder in place
  // (the common path) or by posting fresh (placeholder post failed earlier).
  // If the agent chose stay_silent, delete the placeholder so the user doesn't
  // see "On it…" stuck forever.
  if (slack_context?.channel) {
    if (result.silent) {
      console.log(`[agent] stayed silent: ${result.summary}`);
      if (placeholderRef) {
        try {
          await deleteSlackMessage(placeholderRef.channel, placeholderRef.ts);
        } catch (e) {
          console.error(`[slack] placeholder delete failed:`, e.message);
        }
      }
    } else {
      const prefix = result.ok
        ? ":white_check_mark:"
        : result.clarification_needed
          ? ":thinking_face:"
          : result.credit_exhausted
            ? ":credit_card:"
            : result.budget_exhausted
              ? ":coin:"
              : ":warning:";
      const summary = result.summary || "Done.";
      const trailer = result.trace?.length
        ? `\n_${result.trace.length} action${result.trace.length === 1 ? "" : "s"} · ${elapsedMs}ms_`
        : "";
      const finalText = `${prefix} ${summary}${trailer}`;
      if (placeholderRef) {
        try {
          await updateSlackMessage(placeholderRef.channel, placeholderRef.ts, finalText);
        } catch (e) {
          // Edit failed (maybe the message was deleted by a moderator or
          // Slack returned an error). Fall back to posting fresh so the user
          // still gets an answer.
          console.error(`[slack] placeholder update failed (falling back to new post):`, e.message);
          try {
            await postToSlack(slack_context.channel, finalText, slack_context.thread_ts);
          } catch (e2) {
            console.error(`[slack] fallback post also failed:`, e2.message);
          }
        }
      } else {
        try {
          await postToSlack(slack_context.channel, finalText, slack_context.thread_ts);
        } catch (e) {
          console.error(`[slack] post failed:`, e.message);
        }
      }
    }
  }

  res.json({ ...result, elapsedMs });
});

// Re-run n8n discovery without restarting. Auth-gated by the same shared
// secret as /run. Useful after creating, editing, or deleting a compass
// workflow in the n8n GUI — Claude picks up changes on the next /run call.
app.post("/reload", async (req, res) => {
  const provided = req.get("x-run-secret") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!timingSafeEq(provided, RUN_SHARED_SECRET)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const discovered = await refreshN8nTools();
  res.json({ ok: true, n8n_tools: discovered.map((t) => t.name) });
});

app.listen(PORT, async () => {
  console.log(`Compass agent listening on :${PORT}`);
  // Fire-and-forget — the loop will see discovered tools on its next call.
  // If discovery fails, only n8n tools are missing; JS tools work regardless.
  await refreshN8nTools();
});
