# n8n attachment handoff to Compass

The agent now expects Slack file uploads to be uploaded to Anthropic's Files API on
the n8n side, with the resulting `file_id`s included in the `/run` payload. This
removes the "I can't see the attached file" failure mode entirely (see the May 2026
post-mortem) and makes CSV / image / PDF handling a first-class capability.

## Payload contract

`/run` accepts a new optional field `attachments[]`:

```json
{
  "transcript": "See attached for the May 9 onboarding sheet",
  "slack_context": { "channel": "C0…", "thread_ts": "172…", "user_id": "U0…" },
  "attachments": [
    {
      "file_id":  "file_abc123…",        // Anthropic Files API id (REQUIRED)
      "name":     "people.csv",
      "mimetype": "text/csv",
      "size":     8412,
      "slack_file_id": "F0…"             // optional; useful for traceability
    }
  ]
}
```

Compass attaches each `file_id` to the model's first message as the right content
block type (image, document, or `container_upload` for sandbox files). It also
appends an `## Attached files` manifest to the transcript so the model sees the
file metadata in plain text.

If `attachments` is omitted or empty, behaviour is unchanged from before.

## Required n8n sub-flow

When the Slack event has `event.files[]`, run this sub-flow before calling `/run`:

1. **Download each file from Slack.**
   `GET file.url_private_download` with header `Authorization: Bearer <SLACK_BOT_TOKEN>`.
   Returns the raw bytes.
2. **Upload to the Anthropic Files API.**
   `POST https://api.anthropic.com/v1/files` (multipart) with headers:
   - `x-api-key: <ANTHROPIC_API_KEY>`
   - `anthropic-version: 2023-06-01`
   - `anthropic-beta: files-api-2025-04-14`
   Form field: `file=<bytes>` with `Content-Type` = the Slack file's mimetype.
   Response: `{ id: "file_…", filename, mime_type, size_bytes, … }`.
3. **Build the `attachments[]` array** from the responses.
4. **Call `/run`** with the original transcript + slack_context + the new
   `attachments` array.

Files uploaded this way are **free** to upload, store, list, and delete. You only
pay (in input tokens) when Compass actually references them in a Messages request.
There's no per-byte storage charge as of May 2026; cap is 500 GB per workspace.

## Optional but recommended

- **Reuse file_ids across turns.** If the user uploads the same CSV twice in the
  same thread, n8n can hash the bytes and reuse a previously stored file_id
  instead of re-uploading. Re-uploading produces a new file_id and breaks
  Compass's prompt-caching for that file.
- **Periodic cleanup.** Run a daily job that lists files older than 30 days via
  `GET /v1/files` and deletes any that are no longer referenced. Coaching CSVs
  shouldn't pile up.
- **Skip empty messages.** If the Slack event has only files (no text body),
  pass the transcript as `"(file upload)"` so Compass still has something to
  anchor the conversation on.

## What Compass does on its end

- Renders historical message attachments in the thread context as
  `[file: name=… mime=… slack_file_id=…]` lines — so even messages that didn't
  go through the n8n upload step are visible to the model.
- Routes attachments by mime type:
  - `image/*` → image content block (model sees natively)
  - `application/pdf` / `text/plain` / `text/markdown` → document block
  - everything else (CSV, JSON, Excel, unknown) → `container_upload` block
    (file lands in the code-execution sandbox at `/mnt/user-data/uploads/`)

If you want to override the routing for a specific upload, you can set
`attachments[i].role` (future-reserved, not currently consumed) — for now Compass
trusts the mime type.
