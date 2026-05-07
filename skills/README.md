# OpenClaude Skills

This directory holds reusable skill files (markdown). Each skill is a workflow or knowledge pack the agent can load on-demand via the `load_skill` tool.

## Adding a skill

Create a new `.md` file in this directory. Frontmatter:

```yaml
---
name: skill-id-no-spaces
description: One-sentence description of when to use this skill.
---

(skill content as markdown)
```

The agent sees only the name + description at startup and loads the full content when relevant.

## Examples

- `yohan-voice.md` — Yohan's writing style across registers (peer / prospect / leader)
- `onboarding-playbook.md` — Detailed UST onboarding flow with edge cases
- `cohort-comms.md` — Cohort-wide communication patterns

