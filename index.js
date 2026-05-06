// OpenClaude agent service
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
  SLACK_BOT_TOKEN,
  AGENT_MODEL = "claude-sonnet-4-5",
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
      if (data.list[0]) {
        const tot = amount_total !== undefined ? amount_total : data.list[0]["Amount total"];
        const paid = amount_paid !== undefined ? amount_paid : data.list[0]["Amount paid"];
        if (tot != null && paid != null) updates["Amount owing"] = tot - paid;
      }
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

  async create_clickup_task({ name, description = "", priority = null, due_date = null, list_id = null }) {
    const token = process.env.CLICKUP_TOKEN;
    const targetList = list_id || process.env.CLICKUP_DEFAULT_LIST_ID;
    if (!token) return { error: "CLICKUP_TOKEN not configured on server" };
    if (!targetList) return { error: "No list_id provided and CLICKUP_DEFAULT_LIST_ID not set" };

    const body = { name, description };
    if (priority) body.priority = priority; // 1=urgent, 2=high, 3=normal, 4=low
    if (due_date) body.due_date = new Date(due_date).getTime();

    const res = await fetch(`https://api.clickup.com/api/v2/list/${targetList}/task`, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { error: `ClickUp ${res.status}: ${data.err || data.error || JSON.stringify(data)}` };
    return { id: data.id, url: data.url, name: data.name };
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
      Source: "openclaude agent",
      Timestamp: new Date().toISOString(),
      Content: content,
      "Handled by": "openclaude",
    };
    if (person_id) payload.Person = person_id;
    const created = await ncPost(`/api/v2/tables/${TOUCHPOINTS_TABLE_ID}/records`, [payload]);
    return { id: Array.isArray(created) ? created[0].Id : created.Id };
  },
};

// ---------- Tool definitions for Claude ----------

const tools = [
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
      "Find a cohort by exact name. Current cohorts include 'May 9 2026' and 'May 10 2026'. Use to validate cohort_name before creating a person if uncertain.",
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
      "Update payment-related fields for a person in one call. Use when the user mentions payment activity (deposit received, full payment, payment plan, etc.). The 'Amount owing' field is automatically computed from total minus paid.",
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
      "Create a Gmail draft of the standard 9-week training welcome email to a person. Looks up the person's name + email. Use this when the user says 'send the welcome email' or 'draft the welcome email' for a participant who has paid the deposit. Drafts go to Gmail; the user reviews and clicks send. Returns the Gmail draft URL.",
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
      "Create a Gmail draft of an arbitrary email. Use for one-off emails that don't fit the welcome template (follow-ups, replies, intros). Provide body_html for rich content or body_text for plain. The user reviews the draft and clicks send.",
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
    name: "delete_clickup_task",
    description: "Delete a ClickUp task by its ID. Use when a task is no longer relevant or was created in error.",
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
      "Create a task in ClickUp. Use when the user wants to track a follow-up action, project step, or human task. Goes in the default list unless list_id is specified. Priority: 1=urgent, 2=high, 3=normal, 4=low.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task title (concise)" },
        description: { type: "string", description: "Markdown allowed" },
        priority: { type: "number", enum: [1, 2, 3, 4] },
        due_date: { type: "string", description: "ISO 8601 date or datetime, e.g. '2026-05-12' or '2026-05-12T15:00:00+10:00'" },
        list_id: { type: "string", description: "Specific ClickUp list ID. Omit to use default." },
      },
      required: ["name"],
    },
  },
  {
    name: "update_person",
    description:
      "Update arbitrary fields on an existing person record. Use the NocoDB column titles as field keys.",
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
      "Append a timestamped note to a person's Notes field. For freeform observations like 'mentioned travelling next week'.",
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
    description: "Link an existing person to an additional cohort.",
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
      "Log a touchpoint record for audit trail. Optional — useful when a voice note describes communication or interaction worth tracking.",
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
      "Use ONLY when intent is genuinely ambiguous and you cannot proceed without user clarification. This terminates the loop and asks the user a question.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
];

// ---------- System prompt ----------

const SYSTEM_PROMPT = `You are OpenClaude, the AI ops layer for Unconditional Self (UST), a coaching company run by Yohan and Valerie.

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
- Lookup before create. ALWAYS check if a person exists (by email if given, otherwise by name) before creating. Update instead of duplicate.
- Be defensive about names. Voice transcripts have spelling errors. Use lookup_person with type='name' and a partial fragment when checking. If multiple matches, narrow with email.
- For ambiguous references, ask_for_clarification — don't guess and risk wrong action.
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

QUESTIONS / DECISIONS NEEDED:
When you encounter ambiguity or a decision that needs a human but ISN'T blocking the current voice-note action, create a ClickUp task in the Daily Task Board (list 901613028919) instead of using ask_for_clarification. Title prefix: "❓". Examples:
- User says "we should probably standardise the cohort email format" — that's a decision for Yohan, not blocking. Create a ❓ task.
- During a person.upsert, if you notice the email looks wrong but you can still complete the action — create a ❓ task to follow up, but proceed.
Use ask_for_clarification ONLY when you cannot proceed without an answer (e.g., "Reach out to Daniel" with no Daniel in the system).

EMAIL TRANSCRIPTION REPAIR:
Voice transcripts often mangle emails — "at" becomes ".", "dot" stays as "dot" or ".", and "@" is frequently dropped. If you see something that looks like an email but is missing "@" (e.g. "eva.k.gmail.com" or "sarah dot lee dot example dot com"), reasonably reconstruct it. Common pattern: the LAST domain-like segment (gmail.com, example.com, etc.) is the domain, and "@" goes right before it. So "eva.k.gmail.com" → "eva.k@gmail.com". Never invent emails entirely, but DO repair obvious transcription corruption.

ANTI-PATTERNS:
- Do NOT call ask_for_clarification if you can act with reasonable confidence.
- Do NOT create duplicates when an existing person matches by email.
- Do NOT toggle FUTURE stages that weren't mentioned (don't mark agreement_signed if user only said agreement_sent).
- Do NOT make up emails, phone numbers, or other PII not in the transcript.

When you're done, return a concise summary suitable for posting to Slack.

FORMATTING:
Output is posted to Slack, which uses its own mrkdwn flavor — *bold* with single asterisks, _italic_ with underscores, no markdown headings. Don't use **double-asterisk bold** or # headings.`;

// ---------- Agent loop ----------

async function runAgent(transcript) {
  const messages = [{ role: "user", content: transcript }];
  const trace = [];
  let iteration = 0;
  const maxIterations = 12;

  while (iteration < maxIterations) {
    iteration++;

    const response = await anthropic.messages.create({
      model: AGENT_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
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
  return res.json();
}

// ---------- Express server ----------

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- Admin: one-off introspection (no auth, remove later) ----------

app.get("/admin/clickup-structure", async (_req, res) => {
  const token = process.env.CLICKUP_TOKEN;
  if (!token) return res.status(400).json({ error: "CLICKUP_TOKEN not set" });
  const headers = { authorization: token };
  const teamsRes = await fetch("https://api.clickup.com/api/v2/team", { headers });
  const teams = (await teamsRes.json()).teams || [];
  const out = { teams: [] };
  for (const team of teams) {
    const spaces = ((await fetch(`https://api.clickup.com/api/v2/team/${team.id}/space?archived=false`, { headers }).then((r) => r.json())).spaces) || [];
    const teamData = { id: team.id, name: team.name, spaces: [] };
    for (const space of spaces) {
      const folders = ((await fetch(`https://api.clickup.com/api/v2/space/${space.id}/folder?archived=false`, { headers }).then((r) => r.json())).folders) || [];
      const folderless = ((await fetch(`https://api.clickup.com/api/v2/space/${space.id}/list?archived=false`, { headers }).then((r) => r.json())).lists) || [];
      teamData.spaces.push({
        id: space.id,
        name: space.name,
        folders: folders.map((f) => ({
          id: f.id,
          name: f.name,
          lists: (f.lists || []).map((l) => ({ id: l.id, name: l.name })),
        })),
        folderless_lists: folderless.map((l) => ({ id: l.id, name: l.name })),
      });
    }
    out.teams.push(teamData);
  }
  res.json(out);
});

// ---------- Google OAuth (Gmail) ----------

const GOOGLE_REDIRECT = `https://openclaude-agent.onrender.com/oauth/google/callback`;
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
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
    return res.status(500).send(`Token exchange failed: ${JSON.stringify(tok)}`);
  }

  // Render the refresh token in plain HTML so the operator can copy it once.
  res.setHeader("content-type", "text/html");
  res.send(`<!doctype html>
<html>
<head><title>OpenClaude Gmail OAuth — done</title>
<style>body{font-family:system-ui;max-width:680px;margin:40px auto;padding:24px;color:#222} pre{background:#f4f4f4;padding:16px;border-radius:8px;word-break:break-all;white-space:pre-wrap} .ok{color:#2c7}</style></head>
<body>
<h1 class="ok">✓ Gmail access authorized</h1>
<p>Copy the refresh token below and set it as <code>GOOGLE_REFRESH_TOKEN</code> in Render → Environment.</p>
<pre>${tok.refresh_token}</pre>
<p>Once set, the agent can draft and send Gmail messages on your behalf. You can close this tab.</p>
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

// Get the authenticated Gmail user's "From" address (the connected account's email).
async function getGmailFromAddress(accessToken) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!data.emailAddress) throw new Error(`Failed to fetch Gmail profile: ${JSON.stringify(data)}`);
  return data.emailAddress;
}

app.post("/run", async (req, res) => {
  const { transcript, slack_context } = req.body || {};
  if (!transcript || typeof transcript !== "string") {
    return res.status(400).json({ error: "transcript required" });
  }

  console.log(`[agent] transcript: ${transcript.slice(0, 200)}`);
  const t0 = Date.now();
  let result;
  try {
    result = await runAgent(transcript);
  } catch (e) {
    console.error(`[agent] error:`, e);
    result = { ok: false, summary: `Error: ${e.message}`, error: e.message };
  }
  const elapsedMs = Date.now() - t0;
  console.log(`[agent] done in ${elapsedMs}ms, ok=${result.ok}, iterations=${result.iterations}`);

  // Reply to Slack if context provided
  if (slack_context?.channel) {
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
  }

  res.json({ ...result, elapsedMs });
});

app.listen(PORT, () => {
  console.log(`OpenClaude agent listening on :${PORT}`);
});
