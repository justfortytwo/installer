# @justfortytwo/installer

The all-in-one installer and lifecycle CLI for **fortytwo** — a personal
assistant built on Claude Code. One package ships two bins:

- **`create-fortytwo`** — the install-time alias; with no verb it runs `init`.
- **`fortytwo`** — the everyday lifecycle alias for the verbs below.

## Quick start

```sh
npm install @justfortytwo/installer   # in your project (or a fresh directory)
npx create-fortytwo init              # capture your details, install the engine,
                                      # and scaffold the persona
```

You only install **this** package — `init` installs the engine packages it needs
on demand (`@justfortytwo/gate`, `/memory`, `/persona`, `/telegram`). Pass
`--no-install` to manage them yourself, and `--yes` (with `--answers <file.json>`
or `FORTYTWO_*` env) for non-interactive installs. Point the memory engine at a
remote embedder with `--ollama-base-url https://host` (threaded into `.mcp.json`,
so the memory MCP server uses it), and pre-seed the optional Telegram channel
with `--telegram-bot-token <token>` / `--allowed-chat-ids <ids>` (or the matching
env vars) — secrets are written to the gitignored `.env`, never prompted.

## The two-surface model

fortytwo is delivered as **two surfaces**, and this CLI is the single
operator interface over both:

1. **The npm engine.** The reusable machinery — the memory MCP server, the
   safety gate, the channel adapters, and the local embedder — published as
   `@justfortytwo/*` packages and wired in as Claude Code plugins. This is
   shared, versioned code.
2. **The scaffolded persona.** `CLAUDE.md` + `context/*` — who the assistant is
   and who it serves. This is **not** a plugin. It is per-user, personal, and
   gitignored. The CLI **scaffolds** it by rendering the `@justfortytwo/persona`
   package's `templates/` (guided by its `manifest.json`) against your captured
   answers in `.fortytwo/identity.json`. Re-rendering is idempotent and never
   clobbers fields you've captured or hand-edited.

Secrets live only in a gitignored `.env`; your captured identity lives in the
gitignored `.fortytwo/identity.json`; neither is ever committed.

## Verbs

| Verb       | What it does |
|------------|--------------|
| `init`     | Install any missing engine packages, then capture your assistant's name + owner details (interactive, or via flags/env for CI). Writes `.fortytwo/identity.json`, secrets + `ALLOWED_CHAT_IDS` to `.env`, wires `.mcp.json`, renders the persona, provisions local infra (pulls the embedder model, migrates the memory DB), and records the installed version set. |
| `pair`     | Issue a one-time `/login` pairing code, persisted to the bridge's bindings db so the separately-running bridge can redeem it (the dynamic counterpart to the static `ALLOWED_CHAT_IDS` allowlist). |
| `doctor`   | Health-check the engine: assert the gate's `POLICY_SCHEMA_VERSION` and memory's `MEMORY_TOOL_CONTRACT_VERSION` match what this CLI expects, confirm the memory DB is migrated, cross-check installed sibling versions against the declared compatibility ranges, and check the embedder model is pulled (warn-only). |
| `update`   | Resolve the latest in-range version of each **installed** engine package, install it, rotate the rollback baseline, then run `doctor` to verify. `--dry-run` reports the resolved set without installing. |
| `rollback` | Re-install the previous version set recorded before the last `update`, then run `doctor`. Manual by design — never auto-triggered, so you can inspect a bad upgrade first. |
| `enrich`   | Capture more answers to deepen the persona, then re-render (no clobber). |
| `forget`   | Permanently delete memories selected by `--id` / `--query` (semantic) / `--tag` / `--source` / `--since`/`--until` — previewed and confirmed (or `--yes`). Owner-only: it deletes via a library API, never exposed to the assistant. |
| `unbind`   | Revoke a channel binding (un-pair a chat / drop it from the allowlist). |

Run `fortytwo <verb> --help` for verb-specific options.

> **Status:** `init`, `pair`, `doctor`, `forget`, `unbind`, `update`, and
> `rollback` are functional — `update` resolves latest-in-range from npm,
> installs, rotates the rollback ledger, and post-verifies with `doctor`;
> `rollback` restores the recorded previous set. `enrich` is still a stub.

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

- Node.js >= 20 (Node 20 or 22 LTS recommended — the memory engine's native
  `better-sqlite3` ships prebuilt binaries for LTS releases; newer/odd versions
  may fall back to a slow source compile)
- [Ollama](https://ollama.com/) for the local embedder (optional but
  recommended — the engine degrades gracefully without it)

## License

MIT © 2026 Enrico Deleo

---

Created and maintained by [**Enrico Deleo**](https://enricodeleo.com).
