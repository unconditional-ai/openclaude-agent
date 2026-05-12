---
name: csv-to-people-import
description: Import a CSV of people into the NocoDB People table with email-based dedup, dry-run preview, and explicit confirmation before writes. Use whenever a user uploads a CSV to Slack and wants those rows in the People table — even if they don't say "import": phrases like "add these to the CRM", "load this list", "here are the new signups", "May 9 cohort", or "Yohan/Valerie's onboarding sheet" should activate this. Skip if the CSV is clearly NOT people data, or if the target is a different table (Sessions, Invoices, etc).
---

# CSV → People import

Imports a CSV that has already been uploaded via Slack into the People table in NocoDB. **Always runs as dry-run first → user confirms → execute → report.** Never writes on the first turn.

## When this skill is wrong

Skip and ask for clarification if any of these apply:
- The CSV is clearly not people data (no name/email-shaped columns).
- The user's target is another table (Sessions, Invoices, Touchpoints).
- The user says "just analyse, don't import".

If unsure, name what you think the CSV is and ask before proceeding. Wrong-table imports are expensive to undo.

## The five-step workflow

Copy this checklist into your reply and check items off as you go. Do not skip steps.

```
Import progress:
- [ ] 1. Read the CSV via code_execution
- [ ] 2. Validate columns against People schema
- [ ] 3. Dedup by email, classify each row (new / update / skip / error)
- [ ] 4. Post dry-run summary in Slack and WAIT for confirmation
- [ ] 5. Execute confirmed writes, report per-row outcome
```

### 1. Read the CSV

The file is already in the code_execution sandbox at `/mnt/user-data/uploads/<filename>` (you'll see it in the "## Attached files" manifest). Load it with pandas, handling the three real-world CSV pains:

```python
import pandas as pd
df = pd.read_csv("/mnt/user-data/uploads/<filename>", dtype=str, keep_default_na=False)
df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
for col in df.columns:
    df[col] = df[col].astype(str).str.strip()
print(df.head())
print(df.dtypes)
print(f"{len(df)} rows, {len(df.columns)} columns")
```

If the CSV has wide unstructured headers (the May 9 file had inline emojis, totals, and pivot rows mashed in), find the actual header row first by looking for "First Name" / "Email" cells, and re-read with `skiprows=N`.

### 2. Validate against the People schema

Use `list_tables` to confirm the People table id, then look at a sample record to learn the exact column titles. Don't hardcode them — the schema evolves.

For each CSV column, classify it as one of:
- **mapped** — exact or near match to an existing People column (case-insensitive, ignore underscores/spaces).
- **new column needed** — no match. Would require `add_table_column`.
- **dropdown extension** — maps to an existing SingleSelect column but the CSV has a value not in the option list. Would require `add_select_options`.
- **ignored** — present in CSV but you'd skip on import (internal-notes, totals rows, etc).

Required columns for People: `email` (always) and at least one of `first_name` / `name`. If `email` is missing entirely, stop and explain — there's no useful dedup without it.

### 3. Dedup and classify rows

For each row, normalise the email (`.strip().lower()`) and use `lookup_person({type: "email", query: ...})` to check existence. Batch the lookups; don't fire 100 sequential calls if you have 100 rows — group by 25 max and parallelise inside code_execution where possible.

Per row, decide:
- **new** — no email match → INSERT
- **update** — email match, CSV has at least one differing non-empty field → UPDATE (only the changed fields)
- **skip** — email match, no field changes → no-op
- **error** — invalid email, missing required field, or duplicate email *within* the CSV itself

Note: `create_person` is now idempotent in code — if you call it on a row whose email already exists, it returns `{ already_existed: true }` without creating a duplicate. So even if you misclassify a row as new, the underlying tool won't double-write.

### 4. Dry-run summary and confirmation gate

Post a Slack message in this exact shape (the structure is load-bearing — coaches scan it in 5 seconds):

```
CSV import dry-run · People · 47 rows
  • 31 new       → will INSERT
  • 12 update    → will UPDATE (field diffs available on request)
  •  3 skip      → already match
  •  1 error     → row 18 has no email; will not import

Schema notes:
  • New column proposed: "referral_source" (12 rows have a value)
  • Dropdown "programme" needs new options: "Foundations Plus" (4 rows)

Reply "go" to import, "go without schema changes" to skip the new column
and dropdown options, or "cancel" to abort. I will not write anything
without an explicit confirmation.
```

Then **stop and wait**. Do not proceed on ambiguous responses ("looks good", "ok", a thumbsup reaction). Treat anything other than `go`, `go without schema changes`, or `cancel` as needing more detail and ask back.

#### Why this gate exists (anti-rationalisation)

| Excuse you might be tempted by | Why it's wrong |
|---|---|
| "The user said 'looks fine', that's a confirmation" | A coach skimming Slack on a phone says 'looks fine' to a lot of things. The cost of a bad import (manual cleanup of 50 records) is much higher than one extra round-trip. |
| "Only 3 rows, I'll just do it" | Three wrong rows is still three wrong rows, and the habit of skipping the gate at small N leaks into large N. |
| "The user has confirmed similar imports before" | Each CSV is different. Past confirmations don't transfer. |
| "Adding the new column is obviously right" | Schema changes are forever. Always require a separate `go` for them. |

### 5. Execute and report

On `go`:

1. **Schema changes first** (if any) — `add_table_column` for new columns (with `options[]` for SingleSelect), `add_select_options` for dropdown extensions. Each goes through its confirmation gate; you only proceed once the user says go.
2. **INSERTs** via `bulk_import_people` (preferred) for any batch of 4+ people. One tool call takes the whole array; cohort/owner/source can be set as defaults at the top level so per-row args stay slim. For 1-3 rows, `create_person` per row is fine. Cohort linking is automatic via `cohort_name`.
3. **UPDATEs** via `update_person` for each updated row.
4. Track per-row outcome. If a row fails, **continue with the rest** — don't roll back the batch. Partial failure on messy CSVs is the normal case.

Final Slack reply, in this shape:

```
Import complete · People
  ✓ 31 inserted (1 was already in the system, skipped)
  ✓ 12 updated
  • 3 skipped (already matched)
  ✗ 1 failed (row 18: missing email — same as flagged in dry-run)
Total writes: 43 · Duration: 12.4s
```

Always include the failure count even if it's zero — silent absence is ambiguous.

## Resume after a partial run

If a previous run was killed mid-batch (credit exhaustion, deploy, anything), you can re-run the same CSV. `create_person`'s built-in dedup will treat the already-written rows as "already existed" and skip them. The dry-run will show this in the "skip" bucket — that's the expected shape of a resumed run, not an error.

## What this skill does NOT do

- It does not import to tables other than People. For other tables, write a sibling skill (`csv-to-sessions-import`, etc.) — don't generalise. The validation logic is what makes this safe; a generic CSV importer would be a footgun.
- It does not auto-add columns or dropdown options. Schema changes go through the confirmation gate every time.
- It does not delete rows. CSV-driven deletes are out of scope; ask the user to do those manually.
- It does not modify cohort or stage data inferred from the CSV unless the user confirms. Stages and payments come from the CSV columns *only* if mapped explicitly.

## Tools used

- `code_execution` (CSV parsing, dedup, summary generation)
- `list_tables` (schema discovery)
- `lookup_person` (per-row dedup)
- `bulk_import_people` (preferred for 4+ rows, single call with array)
- `create_person` (single INSERTs, 1-3 rows)
- `update_person` (UPDATEs)
- `add_table_column` (only after confirmation, for new columns)
- `add_select_options` (only after confirmation, for dropdown extensions)
- `link_person_to_cohort` (when cohort_name didn't get linked at create time)
