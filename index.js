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

  SLACK_BOT_TOKEN,
  AGENT_MODEL = "claude-sonnet-4-6",
  PORT = 10000,
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
};
for (const [k, v] of Object.entries(requiredEnv)) {
  if (!v) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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

// ---------- Tool implementations ----------

const toolImpls = {
  async lookup_person({ query, type }) {
    const where = type === "email"
      ? `(Primary email,eq,${query})`
      : `(Name,like,%${query}%)`;
    const data = await ncGet(
      `/api/v2/tables/${PEOPLE_TABLE_ID}/records?where=${encodeURIComponent(where)}&limit=10`
    );
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
    let normalizedSource = "Other";
    if (source && typeof source === "string") {
      const cap = source.charAt(0).toUpperCase() + source.slice(1).toLowerCase();
      if (VALID_SOURCES.includes(cap)) normalizedSource = cap;
    }

    const record = {
      Name: name,
      "Primary email": primary_email,
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

  async update_payment({ person_id, payment_status, amount_total, amount_paid, payment_risk }) {
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

  async delete_clickup_task({ task_id }) {
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
    const tables = (data.list || data.tables || data || []).map((t) => ({
      id: t.id,
      title: t.title,
      table_name: t.table_name,
      description: t.description || null,
    }));
    return { base_id: baseId, tables };
  },

  async add_table_column({ table_id, name, type = "SingleLineText" }) {
    // type must be a NocoDB UI data type (uidt). Common: SingleLineText, LongText,
    // Number, Decimal, Checkbox, Date, DateTime, Email, PhoneNumber, URL, JSON.
    const created = await ncPost(`/api/v2/meta/tables/${table_id}/columns`, {
      column_name: name,
      title: name,
      uidt: type,
    });
    return { table_id, column_id: created.id || null, name, type };
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
  async create_calendar_event({ person_id, datetime, duration_minutes = 45, title = null, description = null, location = null, send_invites = false }) {
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
    name: "update_payment",
    description:
      "Update payment-related fields for a person in one call. When to use: user mentions payment activity (deposit received, paid in full, on monthly plan, refund, scholarship). 'Amount owing' is auto-computed. When NOT to use: for stage checkboxes related to payment (use toggle_stage with deposit_paid/payment_plan_active/paid_in_full instead) — though both can be needed together.",
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
    description: "Delete a ClickUp task by its ID. When to use: a task is no longer relevant, was created in error, or the user explicitly asks to delete it. When NOT to use: to mark a task complete (let the user close it in ClickUp).",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The ClickUp task ID (visible in the task URL after /t/)" },
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
      "Set an onboarding stage checkbox for a person. The 8 stages don't all happen linearly — most are independent, so changing one stage usually doesn't affect others. " +
      "NARROW CASCADE: only TRUE logical dependencies are cascaded automatically: " +
      "  • agreement_signed=true → also marks agreement_sent=true (can't sign what wasn't sent) " +
      "  • payment_plan=true → also marks xero_invoice=true (payment plan needs invoice first) " +
      "  • inverses (agreement_sent=false → unmarks agreement_signed; xero_invoice=false → unmarks payment_plan) " +
      "All other stages are independent — marking xero_invoice does NOT mark onboarding_call_done. The tool returns 'cascaded_stages' showing what (if anything) was also affected.",
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
    description: "Add a column to an existing NocoDB table. When to use: ONLY after explicit user confirmation. Use list_tables to find the table_id. Common types as above.",
    defer_loading: true,
    input_schema: {
      type: "object",
      properties: {
        table_id: { type: "string" },
        name: { type: "string", description: "Column name (will also be the title)." },
        type: { type: "string", description: "NocoDB UI data type — defaults to SingleLineText" },
      },
      required: ["table_id", "name"],
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
    description: "Create a native Google Calendar event on Yohan's calendar with the participant as an attendee. PREFERRED over draft_calendar_invite_email when scheduling — the event lands on Yohan's calendar so he can see it alongside other commitments. By DEFAULT does NOT send an invite email (send_invites=false) — just creates the event silently. Yohan can then review the calendar entry and either send invites manually from Calendar UI, or you can call again with send_invites=true if user explicitly says 'send the invite'. Use check_calendar_availability first if there's any chance of conflict.",
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
];

// ---------- System prompt ----------

// Built fresh per /run so today's date doesn't freeze at module-load time.
// Cache rebuilds once per UTC day (when the date string changes); negligible cost.
const buildSystemPrompt = () => `You are Compass, the AI ops layer for Unconditional Self (UST), a coaching company run by Yohan and Valerie.

You receive transcripts of voice notes (or text messages) from Yohan or Valerie via Slack. Your job is to interpret the intent and execute the right actions on UST's data using the tools available.

Today's date: ${todayISO()}.

Active cohorts: "May 9 2026", "May 10 2026" (both upcoming).

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
- Lookup before create. Check if a person exists (by email if given, otherwise by name) and update them; create only when no match.
- Be defensive about names. Voice transcripts have spelling errors. Use lookup_person with type='name' and a partial fragment when checking. If multiple matches, narrow with email.
- For ambiguous references, ask_for_clarification — confirmed answers beat guesses.
- Keep your final response concise: a short summary of what you did, plus any recommended next steps.
- When you can't do something (e.g. drafting an email — that tool isn't built yet), acknowledge it and note what's still needed manually.

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

TOOL SEARCH:
Most of your tools are loaded on-demand via tool_search_tool_bm25 (natural-language search). Always-loaded core tools: lookup_person, create_person, toggle_stage, list_people, ask_for_clarification, list_skills. For anything else (payment updates, ClickUp tasks, email drafts, audit queries, etc.), search the tool catalog by capability (e.g. "draft email", "list tasks", "update payment") and the relevant tool will be returned for use. Don't apologize for not having a tool — search first.

QUERY TOOL SELECTION (important — get this right):
- "Who is in onboarding / May 9 / paid in full / on Valerie's list" → use list_people with the right filter. NOT list_recent_actions.
- "Show me current participants / give me the roster / who's where in onboarding" → list_people. The roster lives in the People table, not the audit log.
- "What did you (the agent) do today / show me recent activity / what was the last thing you ran" → list_recent_actions.
- "What ClickUp tasks are open / find tasks about X / show me follow-ups" → list_clickup_tasks. For cohort-specific searches ("any tasks for July cohort?"), pass the cohort parameter (e.g. cohort='May 9 2026') — list IDs are discovered dynamically, not hardcoded. Use find_clickup_list when you need to inspect what cohort/program lists exist.
- "Tell me about [specific person]" → lookup_person (by email if given, else fuzzy by name).

The audit log is for "what did the AGENT do". The People table is for "who are the participants". Don't confuse them. If a question is about people/data, use list_people or lookup_person.

SELF-AWARENESS / AUDIT TRAIL:
Every voice note, @mention, and DM you handle is automatically logged to the Agent actions table via list_recent_actions. Don't say you have no memory — you have a full audit trail.

LONG-TERM KNOWLEDGE (pin_knowledge / recall_knowledge):
You have a knowledge store for facts that span sessions — URLs, processes, defaults, "remember this for later" requests. When a user shares something with phrasing like "this is where X lives", "use this link", "remember that...", "if anyone asks about X you can find it here" — call pin_knowledge with a short topic + the full content. When a user later asks for general info that's not a person/cohort/task, call recall_knowledge first before saying you don't know. Tags help: use them for cross-cutting categories like 'curriculum', 'links', 'pricing', 'processes'. Always include the added_by parameter (the user's name from thread/channel context) so the audit trail of who taught you what is preserved.

CONVERSATION CONTEXT:
When you're responding to a Slack message, the transcript may include prior context under a "## Thread context" or "## Recent channel context" heading, followed by "## Current message to act on" with the latest message. Use the prior context to resolve references like "that person", "what we just discussed", "the same thing again". Treat the thread context as a real conversation history — your previous replies (labeled "Compass:") are yours; messages from named users are theirs. If the current message obviously builds on prior turns, don't re-ask things already answered.
If the transcript starts with "## Context status" (instead of "## Thread context" or "## Recent channel context"), Slack context fetching failed — the user may be referencing prior messages you genuinely can't see. Ask them for a brief summary if the current message is ambiguous, rather than guessing.
If the thread context contains your own past "⚠️ Error: ..." messages, those are pre-fix bug noise. Acknowledge briefly if natural ("I see I had some issues earlier — sorted now") and continue from the user's most recent ask.

WHEN TO USE stay_silent:
You're triggered by @-mentions, DMs, thread-replies in threads you've replied in, AND any channel message containing the word "compass" (case-insensitive). Many of these are false positives — humans addressing each other or speaking generally. Call stay_silent when the current message is for someone else or general conversation:
- Message addresses another person via @-mention ("Nathan: @Yohan, the instructions are..." → Nathan is talking to Yohan).
- Two humans conversing among themselves ("yeah, I'll get to it", "thanks bro", "good idea").
- Brief acknowledgements ("ok", "got it", "great", "cheers").
- "compass" used as a noun rather than an address ("moral compass", "compass app on phone").
When you're unsure whether a thread-reply is for you, prefer stay_silent — the user can re-ping you cheaply, and unwanted replies clutter the channel.

TONE / VOICE:
Write like a competent ops person who's been at the company for years: direct, factual, brief. Match the user's energy — terse if they are, conversational if they are. End each reply on the substantive content. One emoji per reply at most, often none. State what you did or what's needed; skip the framing.

ACCURACY:
Stay grounded in what you can verify. For UST-specific details (backend setup, file locations, vendor configs, exact column names): check recall_knowledge first; if nothing's pinned, name the person who'd know — "I don't have those details — Nathan would know". When you're unsure, defer to the human; specific verifiable answers beat plausible-sounding step-by-steps.

QUESTIONS / DECISIONS NEEDED:
When you encounter a question or decision the human team needs to make but you can still complete the current request, create a ClickUp task in the Daily Task Board (list ${process.env.CLICKUP_DAILY_TASK_LIST_ID || "set CLICKUP_DAILY_TASK_LIST_ID env var"}) instead of using ask_for_clarification.

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

SCHEMA CHANGES (create_table / add_table_column):
These are DESTRUCTIVE in the sense that they alter the database structure for everyone. Rules:
- Confirm with the user before calling create_table or add_table_column. Use ask_for_clarification with a concrete proposal: "I'd create a table called 'Invoices' with columns: Number (text), Amount (decimal), Issued (date), Status (single select). OK to proceed?"
- Prefer adding to an existing table over creating a new one. Use list_tables first to check.
- bulk_create_records is safer (data only, no schema change) — still confirm if importing more than ~10 records at once.

When you're done, return a concise summary suitable for posting to Slack.

FORMATTING:
Output is posted to Slack, which uses its own mrkdwn flavor — *bold* with single asterisks, _italic_ with underscores, no markdown headings. Don't use **double-asterisk bold** or # headings.

SLACK MENTIONS (notify the right person):
Known team Slack user IDs — use the <@USER_ID> syntax to ping them so they get a notification:
- Yohan: <@${process.env.YOHAN_SLACK_ID || "set YOHAN_SLACK_ID env"}>
- Valerie: <@${process.env.VALERIE_SLACK_ID || "set VALERIE_SLACK_ID env"}>
- Nathan: <@${process.env.NATHAN_SLACK_ID || "set NATHAN_SLACK_ID env"}>

@-mention them when your reply recommends they take an action — e.g. "<@${process.env.VALERIE_SLACK_ID || ""}> should prioritise getting Joseph's phone number". The mention pings them and gets their attention.

For everything else, refer to them by bare name without the @ — casual references ("the call Yohan ran on Tuesday"), reports of past actions ("Valerie marked the deposit paid"), and replies to the person who's talking to you (no need to @ Yohan when Yohan is asking the question). Participants and clients aren't in this workspace, so refer to them by name only. Stick to the three IDs above; for anyone else, use plain names.`;

// ---------- Agent loop ----------

async function runAgent(transcript) {
  const messages = [{ role: "user", content: transcript }];
  const trace = [];
  let iteration = 0;
  const maxIterations = 12;

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
    const response = await anthropic.messages.create({
      model: AGENT_MODEL,
      max_tokens: 2048,
      system: [
        { type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } },
      ],
      tools: cachedTools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    // Check for ask_for_clarification — terminate loop early
    const clarification = toolUseBlocks.find((b) => b.name === "ask_for_clarification");
    if (clarification) {
      trace.push({ tool: "ask_for_clarification", input: clarification.input });
      return {
        ok: false,
        clarification_needed: true,
        question: clarification.input.question,
        summary: clarification.input.question,
        iterations: iteration,
        trace,
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
        iterations: iteration,
        trace,
      };
    }

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return {
        ok: true,
        summary: textBlock?.text || "Done.",
        iterations: iteration,
        trace,
      };
    }

    if (response.stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of toolUseBlocks) {
        if (block.name === "ask_for_clarification") continue;
        const impl = toolImpls[block.name];
        let result;
        if (!impl) {
          result = { error: `Tool not implemented: ${block.name}` };
        } else {
          try {
            result = await impl.call(toolImpls, block.input);
          } catch (e) {
            result = { error: e.message };
          }
        }
        trace.push({ tool: block.name, input: block.input, result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Other stop reasons (max_tokens, stop_sequence, etc.)
    const textBlock = response.content.find((b) => b.type === "text");
    return {
      ok: false,
      summary: textBlock?.text || `Stopped: ${response.stop_reason}`,
      stop_reason: response.stop_reason,
      iterations: iteration,
      trace,
    };
  }

  return { ok: false, summary: "Max iterations reached.", iterations: iteration, trace };
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
    if (!text) continue;
    lines.push(`${speaker}: ${text}`);
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

// ---------- Google OAuth (Gmail) ----------

const GOOGLE_REDIRECT = `https://openclaude-agent.onrender.com/oauth/google/callback`;
// Scopes granted when the user OAuths.
//   gmail.compose      — create Gmail drafts (existing tools)
//   calendar.events    — create / update Calendar events on the user's calendar
//   calendar.readonly  — list events for free-busy lookups
const GOOGLE_SCOPE = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
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

// Log every agent run to the Agent actions audit table.
// Fire-and-forget — failures here shouldn't fail the response.
async function logAgentAction({ transcript, slack_context, result, elapsedMs }) {
  if (!AGENT_ACTIONS_TABLE_ID) return;
  try {
    const source = slack_context?.file_id ? "Slack voice" : (slack_context?.channel ? "Slack text" : "API call");
    const toolsUsed = (result.trace || []).map((t) => t.tool).filter(Boolean);
    const summaryShort = (result.summary || "").slice(0, 200).replace(/\n+/g, " ");
    const payload = {
      Summary: summaryShort || (result.error ? `Error: ${result.error.slice(0, 180)}` : "agent run"),
      Transcript: transcript,
      "Agent response": result.summary || "",
      "Tools used": JSON.stringify(toolsUsed),
      Iterations: result.iterations || 0,
      "Elapsed ms": elapsedMs,
      Success: !!result.ok,
      "Needed clarification": !!result.clarification_needed,
      Source: source,
      "Slack channel": slack_context?.channel || null,
      "Slack user id": slack_context?.user_id || null,
    };
    await ncPost(`/api/v2/tables/${AGENT_ACTIONS_TABLE_ID}/records`, [payload]);
  } catch (e) {
    console.error(`[audit] failed to log agent action:`, e.message);
  }
}

app.post("/run", async (req, res) => {
  const { transcript, slack_context } = req.body || {};
  if (!transcript || typeof transcript !== "string") {
    return res.status(400).json({ error: "transcript required" });
  }

  console.log(`[agent] transcript: ${transcript.slice(0, 200)}`);
  const t0 = Date.now();
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
  let result;
  try {
    result = await runAgent(enrichedTranscript);
  } catch (e) {
    console.error(`[agent] error:`, e);
    result = { ok: false, summary: `Error: ${e.message}`, error: e.message };
  }
  const elapsedMs = Date.now() - t0;
  console.log(`[agent] done in ${elapsedMs}ms, ok=${result.ok}, iterations=${result.iterations}`);

  // Audit log — fire-and-forget, don't block the response on it
  logAgentAction({ transcript, slack_context, result, elapsedMs });

  // Reply to Slack if context provided AND the agent didn't explicitly choose silence.
  if (slack_context?.channel && !result.silent) {
    const prefix = result.ok ? ":white_check_mark:" : (result.clarification_needed ? ":thinking_face:" : ":warning:");
    const summary = result.summary || "Done.";
    const trailer = result.trace?.length
      ? `\n_${result.trace.length} action${result.trace.length === 1 ? "" : "s"} · ${elapsedMs}ms_`
      : "";
    try {
      await postToSlack(slack_context.channel, `${prefix} ${summary}${trailer}`, slack_context.thread_ts);
    } catch (e) {
      console.error(`[slack] post failed:`, e);
    }
  } else if (result.silent) {
    console.log(`[agent] stayed silent: ${result.summary}`);
  }

  res.json({ ...result, elapsedMs });
});

app.listen(PORT, () => {
  console.log(`Compass agent listening on :${PORT}`);
});
