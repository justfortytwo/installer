# @justfortytwo/magrathea

The all-in-one installer and lifecycle CLI for **justfortytwo** — a personal
assistant built on Claude Code. One package ships two bins:

- **`create-fortytwo`** — the install-time alias (`npm create fortytwo` /
  `npx create-fortytwo`). With no verb, it runs `init`.
- **`fortytwo`** — the everyday lifecycle alias for the verbs below.

## The two-surface model

justfortytwo is delivered as **two surfaces**, and this CLI is the single
operator interface over both:

1. **The npm engine.** The reusable machinery — the guide MCP server, the
   safety gate, the channel adapters, and the local embedder — published as
   `@justfortytwo/*` packages and wired in as Claude Code plugins. This is
   shared, versioned code.
2. **The scaffolded persona.** `CLAUDE.md` + `context/*` — who the assistant is
   and who it serves. This is **not** a plugin. It is per-user, personal, and
   gitignored. The CLI **scaffolds** it by rendering the `@justfortytwo/ford`
   package's `templates/` (guided by its `manifest.json`) against your captured
   answers in `.fortytwo/identity.json`. Re-rendering is idempotent and never
   clobbers fields you've captured or hand-edited.

Secrets live only in a gitignored `.env`; your captured identity lives in the
gitignored `.fortytwo/identity.json`; neither is ever committed.

## Verbs

| Verb       | What it does |
|------------|--------------|
| `init`     | Capture your assistant's name + owner details (interactive, or via flags/env for CI). Writes `.fortytwo/identity.json`, secrets to `.env`, renders the persona, provisions local infra (pulls the embedder model, migrates the guide DB), records the installed version set, and issues a pairing code. |
| `pair`     | Issue a one-time `/login` pairing code to bind another chat/device to a channel. |
| `doctor`   | Health-check the engine: boot the guide MCP and assert its tool contract, fire a synthetic event at the safety gate, confirm DB migrations are applied, check the embedder model is pulled, and cross-check installed sibling versions against the declared compatibility ranges. |
| `update`   | Resolve the latest in-range version of each engine package, install, then run `doctor` to verify. On failure it points you to `rollback`. |
| `rollback` | Restore the previous version set recorded before the last `update`. |
| `enrich`   | Capture more answers to deepen the persona, then re-render (no clobber). |
| `forget`   | Redact or remove specific memories from the memory store. |
| `unbind`   | Revoke a channel binding (un-pair a chat / drop it from the allowlist). |

Run `fortytwo <verb> --help` for verb-specific options.

## Update safety

Distribution follows a **semver-ranges, latest-compatible** policy — there is no
curated bill-of-materials. `update` installs the latest in-range version of each
engine package and then runs `doctor` as a post-install health check. **Rollback
is manual**: the prior version set is recorded before every update, so
`fortytwo rollback` can restore exactly the set that was running before.

## The embedder

The engine uses a **local** embedder for privacy — personal data never leaves
your machine. The standard model is `qwen3-embedding:0.6b`, served by Ollama;
`init` pulls it and `doctor` verifies it.

## Requirements

- Node.js >= 18
- [Ollama](https://ollama.com/) for the local embedder (optional but
  recommended — the engine degrades gracefully without it)

## License

MIT © 2026 justfortytwo

---

Created and maintained by [**Enrico Deleo**](https://enricodeleo.com).
