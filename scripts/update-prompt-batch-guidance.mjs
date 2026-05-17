#!/usr/bin/env node
/**
 * One-shot prompt update: rewrite the "CALLING TOOLS FROM INSIDE PYTHON"
 * section to correctly describe what sandbox programmatic tool calling costs
 * in iterations, and add guidance to prefer bulk_create_records for batch
 * inserts.
 *
 * Why: the existing prompt said "One model turn, 80 sandbox-side tool calls"
 * which is wrong — per Anthropic's programmatic-tool-calling contract, each
 * `await tool_name(...)` in the sandbox is ONE API round-trip = ONE /run
 * iteration. The model believed the prompt and tried to import 26 rows by
 * looping `await create_person()`, hit the 25-iter cap, and 0 rows survived
 * the dry-run safety. This rewrite tells the truth and points at
 * bulk_create_records for batches where cohort linking isn't needed.
 *
 * Usage:
 *   NOCODB_URL=https://your-nocodb \
 *   NOCODB_TOKEN=xxx \
 *   COMPASS_PROMPT_TABLE_ID=m2dxh4cc0blo6kw \
 *   node scripts/update-prompt-batch-guidance.mjs
 *
 * It will:
 *   1. Fetch the current prompt body row (Version DESC, top 1)
 *   2. Apply a string replacement on the targeted section
 *   3. POST a new row with Version = current + 1, UpdatedBy = "Claude
 *      (batch-guidance fix)", Reason = (explanation)
 *
 * Idempotent in the loose sense: if the OLD_SECTION string isn't found in
 * the current body (e.g. someone already updated), the script exits without
 * writing — no duplicate versions.
 */

const NOCODB_URL = process.env.NOCODB_URL;
const NOCODB_TOKEN = process.env.NOCODB_TOKEN;
const TABLE_ID = process.env.COMPASS_PROMPT_TABLE_ID;

if (!NOCODB_URL || !NOCODB_TOKEN || !TABLE_ID) {
  console.error("Missing env: NOCODB_URL, NOCODB_TOKEN, COMPASS_PROMPT_TABLE_ID");
  process.exit(1);
}

const headers = { "xc-token": NOCODB_TOKEN, "content-type": "application/json" };

async function ncGet(path) {
  const res = await fetch(`${NOCODB_URL}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}
async function ncPost(path, body) {
  const res = await fetch(`${NOCODB_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

const OLD_SECTION = `CALLING TOOLS FROM INSIDE PYTHON (sandbox → host tools):
A subset of your tools is callable directly from the code_execution sandbox via "await tool_name(args)" — no round-trip through the model. Use this for per-row work in big imports (lookup_person × 50, create_person × 50) where the model layer adds nothing but cost and latency. The model writes ONE Python block; the tools run inside the sandbox and results land back in the same Python scope.

Callable from sandbox: lookup_person, create_person, update_person, toggle_stage, add_note, log_touchpoint, link_person_to_cohort, lookup_cohort, list_people, query_table, list_tables, recall_knowledge, pin_knowledge, find_person_by_phone, get_person_full, list_clickup_tasks, list_recent_actions, view_prompt_body, view_prompt_history, list_skills, load_skill, read_channel_history, lookup_slack_user, list_slack_reminders, list_jotform_submissions, get_jotform_submission, check_calendar_availability, bulk_create_records.

NOT callable from sandbox (must run through the model): everything confirmation-gated (update_payment, calendar writes, deletes, bulk_import_people, schema changes, prompt edits) and all Slack-message-posting tools. The model has to be in the loop for those — the gates exist for a reason and silent posts are jarring.

Example: importing 80 rows from a CSV. Without sandbox tool calling, you'd loop the model 80 times. With it:

  import pandas as pd
  df = pd.read_csv("/files/input/sample.csv")
  results = []
  for _, row in df.iterrows():
      r = await create_person({"email": row["email"], "name": row["name"], "cohort_name": "May 9 2026"})
      results.append({"email": row["email"], "status": "created" if not r.get("already_existed") else "existed"})
  print(f"{sum(1 for r in results if r['status'] == 'created')} created, {sum(1 for r in results if r['status'] == 'existed')} already existed")

One model turn, 80 sandbox-side tool calls, ~5-10x cheaper. For unsafe tools (anything gated), do the gate dance in the model layer first, THEN drop into Python for the bulk per-row execution.`;

const NEW_SECTION = `CALLING TOOLS FROM INSIDE PYTHON (sandbox → host tools):
A subset of your tools is callable directly from the code_execution sandbox via "await tool_name(args)". Each await is ONE API round-trip — one /run iteration. Sandbox tool calling makes each call cheaper (cached reasoning, no resampling between rows) but does NOT reduce the iteration count: looping "await create_person()" 80 times is still 80 iterations. The per-/run iteration cap is 75.

Choose the right tool for the batch size:
  - 1-3 rows: create_person / update_person per row via the model layer is fine.
  - 5-70 rows, no cohort linking: bulk_create_records from sandbox — array-input, ONE await = N rows = 1 iteration. Use for Touchpoints, Knowledge, or other non-cohort-linked tables.
  - 5-70 rows WITH cohort linking: "await create_person()" per row from sandbox — each row gets its cohort linked automatically (create_person handles the People→Cohorts link internally), but it's N iterations.
  - 70+ rows: chunk into groups of ~50 and call bulk_create_records per chunk; do "await link_person_to_cohort()" per row afterward if cohort linking is needed.

Callable from sandbox: lookup_person, create_person, update_person, toggle_stage, add_note, log_touchpoint, link_person_to_cohort, lookup_cohort, list_people, query_table, list_tables, recall_knowledge, pin_knowledge, find_person_by_phone, get_person_full, list_clickup_tasks, list_recent_actions, view_prompt_body, view_prompt_history, list_skills, load_skill, read_channel_history, lookup_slack_user, list_slack_reminders, list_jotform_submissions, get_jotform_submission, check_calendar_availability, bulk_create_records.

NOT callable from sandbox (must run through the model): everything confirmation-gated (update_payment, calendar writes, deletes, bulk_update_records, bulk_import_people, schema changes, prompt edits) and all Slack-message-posting tools. The model has to be in the loop for those — the gates exist for a reason and silent posts are jarring.

Example: importing 50 rows into Touchpoints (no cohort linking) — ONE iteration via bulk_create_records:

  import os, pandas as pd
  input_dir = os.environ.get("INPUT_DIR", "/files/input")
  csv_path = os.path.join(input_dir, [f for f in os.listdir(input_dir) if f.endswith(".csv")][0])
  df = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
  tables = await list_tables({})
  touchpoints_id = next(t["id"] for t in tables["tables"] if t["title"] == "Touchpoints")
  records = [{"Notes": row["note"], "Date": row["date"]} for _, row in df.iterrows()]
  result = await bulk_create_records({"table_id": touchpoints_id, "records": records})
  print(f"Inserted {result['count']} rows in one call")

Example: importing 26 rows into People WITH cohort linking — 26 iterations via "await create_person()":

  import os, pandas as pd
  input_dir = os.environ.get("INPUT_DIR", "/files/input")
  csv_path = os.path.join(input_dir, [f for f in os.listdir(input_dir) if f.endswith(".csv")][0])
  df = pd.read_csv(csv_path, dtype=str, keep_default_na=False)
  results = []
  for _, row in df.iterrows():
      r = await create_person({"email": row["email"], "name": row["name"], "cohort_name": "May 9 2026"})
      results.append({"email": row["email"], "status": "created" if not r.get("already_existed") else "existed"})
  print(f"{sum(1 for r in results if r['status'] == 'created')} created, {sum(1 for r in results if r['status'] == 'existed')} already existed")

For unsafe / gated tools (update_payment, calendar writes, etc.), do the gate dance in the model layer first, THEN drop into Python for the bulk per-row execution.`;

async function main() {
  const list = await ncGet(`/api/v2/tables/${TABLE_ID}/records?sort=-Version&limit=1`);
  const current = list.list?.[0];
  if (!current) throw new Error("No current prompt row found");

  const currentBody = current.Body;
  const currentVersion = current.Version;

  if (!currentBody.includes(OLD_SECTION)) {
    if (currentBody.includes("Each await is ONE API round-trip")) {
      console.log(`Prompt v${currentVersion} already has the batch-guidance update. No write needed.`);
      return;
    }
    console.error("OLD_SECTION not found in current prompt body — refusing to write a guessing patch.");
    console.error("Either the prompt has drifted from what the script expects, or it was already updated some other way.");
    console.error("First 200 chars of current body for sanity:");
    console.error(currentBody.slice(0, 200));
    process.exit(2);
  }

  const newBody = currentBody.replace(OLD_SECTION, NEW_SECTION);
  const newVersion = currentVersion + 1;

  console.log(`Updating prompt from v${currentVersion} (${currentBody.length} chars) to v${newVersion} (${newBody.length} chars)…`);

  await ncPost(`/api/v2/tables/${TABLE_ID}/records`, [{
    Body: newBody,
    Version: newVersion,
    UpdatedBy: "Claude (batch-guidance fix)",
    Reason: "Correct the misleading 'one model turn = N tool calls' claim — each await in sandbox is one API round-trip per Anthropic's programmatic-tool-calling contract. Add guidance to prefer bulk_create_records for non-cohort-linked batches. Driven by 2026-05-17 max-iterations failure on a 26-row CSV (audit row 14): the model followed the old prompt verbatim, looped 'await create_person()' 26 times, hit the 25-iter cap.",
  }]);

  console.log(`Prompt v${newVersion} written. Hit /reload on the running service to pick it up without a restart, or wait for the next deploy.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
