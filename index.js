// OpenClaude agent service
// Receives a voice-note transcript + slack_context, runs a Claude tool-use loop
// against UST's NocoDB, and replies in Slack with what was done.

import Anthropic from "@anthropic-ai/sdk";
import express from "express";

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

const STAGE_COLUMN_MAP = {
  onboarding_call_done: "1. Onboarding call done",
  agreement_sent: "2. Agreement sent",
  agreement_signed: "3. Agreement signed",
  xero_invoice: "4. Xero invoice set",
  payment_plan: "5. Payment plan active",
  welcome_email: "6. Welcome email sent",
  preform: "7. Pre-form submitted",
  calendar: "8. Calendar invites accepted",
};

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
        cohort_count: p.Cohorts || 0,
        notes: p.Notes,
        stages: {
          onboarding_call_done: p["1. Onboarding call done"] || false,
          agreement_sent: p["2. Agreement sent"] || false,
          agreement_signed: p["3. Agreement signed"] || false,
          xero_invoice: p["4. Xero invoice set"] || false,
          payment_plan: p["5. Payment plan active"] || false,
          welcome_email: p["6. Welcome email sent"] || false,
          preform: p["7. Pre-form submitted"] || false,
          calendar: p["8. Calendar invites accepted"] || false,
        },
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
  }) {
    let normalizedSource = "Other";
    if (source && typeof source === "string") {
      const cap = source.charAt(0).toUpperCase() + source.slice(1).toLowerCase();
      if (VALID_SOURCES.includes(cap)) normalizedSource = cap;
    }

    const created = await ncPost(`/api/v2/tables/${PEOPLE_TABLE_ID}/records`, [
      {
        Name: name,
        "Primary email": primary_email,
        "Primary phone": primary_phone,
        Status: "Onboarding",
        Owner: "Valerie",
        Source: normalizedSource,
        Notes: notes,
        "Last touch": todayISO(),
      },
    ]);
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

  async update_person({ person_id, fields }) {
    const payload = { Id: person_id, ...fields, "Last touch": todayISO() };
    const updated = await ncPatch(`/api/v2/tables/${PEOPLE_TABLE_ID}/records`, [payload]);
    return { id: person_id, updated_fields: Object.keys(fields), result: updated };
  },

  async toggle_stage({ person_id, stage, value }) {
    const column = STAGE_COLUMN_MAP[stage];
    if (!column) {
      return {
        error: `Invalid stage: ${stage}. Valid: ${Object.keys(STAGE_COLUMN_MAP).join(", ")}`,
      };
    }
    await ncPatch(`/api/v2/tables/${PEOPLE_TABLE_ID}/records`, [
      { Id: person_id, [column]: value, "Last touch": todayISO() },
    ]);
    return { id: person_id, stage, value, column };
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
      "Create a new person record and optionally link to a cohort. Default Status='Onboarding', Owner='Valerie'. Source is one of: Direct, Referral, Workshop, Website, Social, Other (case-insensitive, mapped). Use ONLY after confirming the person doesn't already exist via lookup_person.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        primary_email: { type: "string", description: "lowercase preferred" },
        primary_phone: { type: "string", description: "E.164 if possible" },
        cohort_name: {
          type: "string",
          description: "Exact cohort name e.g. 'May 9 2026'. Set null if not specified.",
        },
        source: {
          type: "string",
          enum: ["Direct", "Referral", "Workshop", "Website", "Social", "Other"],
        },
        notes: { type: "string" },
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
      "Set an onboarding stage checkbox for a person. Stages are sequential: onboarding_call_done → agreement_sent → agreement_signed → xero_invoice → payment_plan → welcome_email → preform → calendar.",
    input_schema: {
      type: "object",
      properties: {
        person_id: { type: "number" },
        stage: {
          type: "string",
          enum: [
            "onboarding_call_done",
            "agreement_sent",
            "agreement_signed",
            "xero_invoice",
            "payment_plan",
            "welcome_email",
            "preform",
            "calendar",
          ],
        },
        value: { type: "boolean", description: "true = mark done, false = unmark" },
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

Onboarding stages (in order):
  1. onboarding_call_done
  2. agreement_sent
  3. agreement_signed
  4. xero_invoice
  5. payment_plan
  6. welcome_email
  7. preform
  8. calendar

PRINCIPLES:
- Take initiative. A voice note may imply MULTIPLE actions ("Add Sarah AND mark her agreement signed AND remind me to follow up Tuesday"). Plan and execute all of them in sequence.
- Lookup before create. ALWAYS check if a person exists (by email if given, otherwise by name) before creating. Update instead of duplicate.
- Be defensive about names. Voice transcripts have spelling errors. Use lookup_person with type='name' and a partial fragment when checking. If multiple matches, narrow with email.
- For ambiguous references, ask_for_clarification — don't guess and risk wrong action.
- Keep your final response concise: a short summary of what you did, plus any recommended next steps.
- When you can't do something (e.g. drafting an email — that tool isn't built yet), acknowledge it and note what's still needed manually.

STAGE CASCADE (important):
Stages are SEQUENTIAL — completing a later stage logically implies all earlier stages are done.
- agreement_signed=true → agreement_sent must also be true (you can't sign what wasn't sent)
- xero_invoice=true → agreement_signed and agreement_sent are likely true
- payment_plan=true → xero_invoice is likely true
- welcome_email=true → payment_plan is likely true
- preform=true → welcome_email is likely true
- calendar=true → preform is likely true
When the user marks a stage and earlier stages are still false, treat that as an oversight by default and ALSO toggle the earlier stages true. Mention in your summary that you cascaded ("Also marked stage 2 since stage 3 implies it"). If you have a real reason to think the earlier stage was deliberately skipped, ask for clarification.

EMAIL TRANSCRIPTION REPAIR:
Voice transcripts often mangle emails — "at" becomes ".", "dot" stays as "dot" or ".", and "@" is frequently dropped. If you see something that looks like an email but is missing "@" (e.g. "eva.k.gmail.com" or "sarah dot lee dot example dot com"), reasonably reconstruct it. Common pattern: the LAST domain-like segment (gmail.com, example.com, etc.) is the domain, and "@" goes right before it. So "eva.k.gmail.com" → "eva.k@gmail.com". Never invent emails entirely, but DO repair obvious transcription corruption.

ANTI-PATTERNS:
- Do NOT call ask_for_clarification if you can act with reasonable confidence.
- Do NOT create duplicates when an existing person matches by email.
- Do NOT toggle FUTURE stages that weren't mentioned (don't mark agreement_signed if user only said agreement_sent).
- Do NOT make up emails, phone numbers, or other PII not in the transcript.

When you're done, return a concise plain-text summary suitable for posting to Slack.`;

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

async function postToSlack(channel, text, threadTs = null) {
  const body = { channel, text };
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
