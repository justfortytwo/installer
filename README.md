# @justfortytwo/installer

The all-in-one installer and lifecycle CLI for **fortytwo** — a personal
assistant built on Claude Code. One package ships two bins:

- **`create-fortytwo`** — the install-time alias; with no verb it runs `init`.
- **`fortytwo`** — the everyday lifecycle alias for the verbs below.

## Quick start

```sh
npx @justfortytwo/installer init   # in a new, empty directory: capture your details,
                                   # install the engine, scaffold the persona
fortytwo start                     # run fortytwo (foreground; Ctrl+C stops it)
fortytwo pair                      # in a second terminal: connect Telegram
```

`pair` prints a code; send `/login <code>` to your bot from the chat you want to
connect. Until then the bot ignores everyone, so it is safe to run `start`
before any chat is paired.

### The `fortytwo` command

No global npm install is involved. `init` does two things so `fortytwo` keeps
working after `npx` exits:

1. **Pins the CLI into the project.** `@justfortytwo/installer` is added to the
   project's `package.json` at the exact version you ran (`--save-exact`), so
   `package-lock.json` records it and every project runs its own version.
2. **Installs a small launcher** named `fortytwo` into a directory that is
   already on your `PATH`: the first writable one of `~/.local/bin`, `~/bin`, or
   npm's global bin directory (`npm prefix -g`/bin). Set `FORTYTWO_BIN_DIR` to
   choose the directory yourself. Your shell config and `PATH` are never edited.

The launcher holds no version and no project path. It finds the Fortytwo project
you are in (the nearest directory, from the current one upward, that contains
`.fortytwo/`) and runs that project's own `node_modules/.bin/fortytwo` from the
project root (only if you own that project's `.fortytwo/` and CLI, so code
another user plants in a shared directory such as `/tmp` is never run), so several projects can sit side by side on different versions.
Outside a project it exits with an error and runs nothing. It is one shared
file, refreshed on every `init`, and it never replaces a `fortytwo` it did not
write. If no directory on your `PATH` is writable, `init` says so and tells you to
use `npx fortytwo …` from the project, which runs the same pinned CLI without
downloading. `fortytwo --version` prints the version the current project runs.

To remove it: delete the launcher (`init` prints its path) and, per project,
`npm uninstall @justfortytwo/installer`.

You only install **this** package — `init` installs the engine packages it needs
on demand (`@justfortytwo/gate`, `/memory`, `/persona`, `/telegram`, `/scheduler`, `/transcript`).
`/memory` and `/telegram` are pinned to exact `1.0.0`, `/scheduler` and `/persona` to exact `1.0.1`,
and `/transcript` to `^1.0.0` (see `fortytwo.compat` in `package.json`); telegram
and scheduler pull in `@justfortytwo/runner` themselves, so the installer never
installs runner directly. Engine versions live only in `package.json`
`fortytwo.compat` (not in `peerDependencies`), so upgrading the installer never
trips npm's peer resolution. Pass
`--no-install` to manage them yourself, and `--yes` (with `--answers <file.json>`
or `FORTYTWO_*` env) for non-interactive installs. Point the memory engine at a
remote embedder with `--ollama-base-url https://host` (threaded into `.mcp.json`,
so the memory MCP server uses it — see [The embedder](#the-embedder)). When `@justfortytwo/transcript` is installed, `init` also lists it in `FORTYTWO_MCP_EXTENSIONS` on that `.mcp.json` entry (launching memory with `npx -y -p @justfortytwo/memory -p @justfortytwo/transcript fortytwo-memory` so both share one install), and `status`/`doctor` warn if the package, the env var and the `-p` launch args disagree, or if memory is installed without the declared transcript (chat is then not recorded). Re-wiring keeps the entry's other env (a hand-set `EMBED_PROVIDER`/`EMBED_API_KEY`/`EMBED_MODEL` survives `init` and `update`); a `.mcp.json` that does not parse is reported and left untouched. Pre-seed the optional Telegram channel
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
| `start`    | Run fortytwo in the foreground: load the project `.env` (the shell/container env wins over it), start every installed and configured service (the Telegram bridge needs `TELEGRAM_BOT_TOKEN`; the scheduler daemon needs nothing), prefix and forward their logs, and stop them all on Ctrl+C/SIGTERM. If a service exits, the others are stopped and `start` exits non-zero. It never daemonizes or restarts anything — see [Running as a service](#running-as-a-service). |
| `status`   | Show whether fortytwo, the Telegram bridge and the scheduler are running, and whether memory is configured. Exits 0 when `fortytwo start` is running, 3 when not (usable as a health check). |
| `stop`     | Stop the `fortytwo start` running for this project. It signals only the process recorded in `.fortytwo/runtime.json`, and only while that record's heartbeat is fresh and its OS process-start identity matches; it never looks for processes by name. |
| `init`     | Install any missing engine packages, pin this CLI into the project and install the `fortytwo` launcher (see [The `fortytwo` command](#the-fortytwo-command)), then capture your assistant's name + owner details (interactive, or via flags/env for CI). Writes `.fortytwo/identity.json`, secrets + `ALLOWED_CHAT_IDS` to `.env`, wires `.mcp.json`, renders the persona, provisions local infra (pulls the embedder model, migrates the memory DB), and records the installed version set. |
| `pair`     | Issue a one-time `/login` pairing code, persisted to the bridge's bindings db so the running bridge can redeem it (the dynamic counterpart to the static `ALLOWED_CHAT_IDS` allowlist). Refuses, and tells you to run `fortytwo start`, when Telegram isn't running; `--force` issues a code anyway (for a bridge you run yourself). |
| `doctor`   | Health-check the engine: check Gate package compatibility (`POLICY_SCHEMA_VERSION`) and memory's `MEMORY_TOOL_CONTRACT_VERSION` match what this CLI expects, confirm the memory DB is migrated, cross-check installed sibling versions against the declared compatibility ranges, and check the embedder model is pulled (warn-only). |
| `update`   | Resolve the latest in-range version of each **installed** engine package (plus `@justfortytwo/transcript` when memory is installed and it is missing), install it, rotate the rollback baseline, then run `doctor` to verify. `--dry-run` reports the resolved set without installing. |
| `rollback` | Re-install the previous version set recorded before the last `update`, then run `doctor`. Manual by design — never auto-triggered, so you can inspect a bad upgrade first. |
| `enrich`   | Capture more answers to deepen the persona, then re-render (no clobber). |
| `forget`   | Permanently delete memories selected by `--id` / `--query` (semantic) / `--tag` / `--source` / `--since`/`--until` — previewed and confirmed (or `--yes`). Owner-only: it deletes via a library API, never exposed to the assistant. |
| `unbind`   | Revoke a channel binding (un-pair a chat / drop it from the allowlist). |

Run `fortytwo <verb> --help` for verb-specific options.

> **Status:** `init`, `start`, `status`, `stop`, `pair`, `doctor`, `forget`,
> `unbind`, `update`, and `rollback` are functional — `update` resolves latest-in-range from npm,
> installs, rotates the rollback ledger, and post-verifies with `doctor`;
> `rollback` restores the recorded previous set. `enrich` is still a stub.

## Running as a service

`fortytwo start` stays in the foreground on purpose, so the thing that runs it
owns restarts and logs. Use it directly as the service command:

```yaml
# docker-compose.yml (excerpt)
services:
  fortytwo:
    command: ["npx", "fortytwo", "start"]   # the project's pinned CLI; no download
    working_dir: /workspace        # the project init was run in
    init: true                     # reap processes the bridge's Claude sessions leave
    restart: unless-stopped
```

```ini
# systemd unit (excerpt)
[Service]
WorkingDirectory=/path/to/project
ExecStart=/usr/bin/env npx fortytwo start
Restart=on-failure
```

`npx fortytwo` passes SIGTERM through. Use `["fortytwo", "start"]` only if the
image itself ran `init` (so the launcher is on the container's `PATH`).

On SIGTERM it stops its services (SIGKILL after 10 s) and exits 0; if a service
dies on its own, it stops the rest and exits non-zero, so `restart` policies
kick in. Use `docker compose stop` / `systemctl stop` there rather than
`fortytwo stop`.

**Environment precedence** for the services: the process env (shell, container,
systemd `Environment=`) > the project `.env` > defaults. `FORTYTWO_ROOT`
defaults to the project directory. You never need to `source .env` yourself.

### Advanced: running a service by hand

For development and debugging, each service still ships its own bin. They do not
load `.env`, so export it and `FORTYTWO_ROOT` yourself:

```sh
set -a; . ./.env; set +a
FORTYTWO_ROOT=$PWD npx fortytwo-telegram-bridge   # Telegram bridge only
npx fortytwo-scheduler                            # scheduler daemon only
```

`fortytwo status` won't show a hand-run bridge, and `fortytwo pair` needs
`--force` to issue a code for it.

## Update safety

From the project root, bootstrap installations pinned to a pre-1.0.0 installer
into this coordinated release (after publication):

```sh
fortytwo stop
npx @justfortytwo/installer@1.0.0 update
fortytwo start
```

The old CLI cannot discover a new installer's exact compatibility matrix, so this
one-time explicit version is necessary. No re-exec, manual npm install or init is needed. The invoked installer refuses a live runtime, persists its own newer
version with `npm install --save-exact`, and continues in the same process using
its own compatibility matrix. This updates package.json, package-lock.json and
the project-local CLI used by the existing launcher. Verify with
`fortytwo --version`. Repeated updates skip installer installation when equal;
invoking an older installer is refused. `--dry-run` writes no project state.

Later project-local `fortytwo update` uses the new matrix. Discovery of future
installer releases/channels is a separate policy; this command does not query
for newer installer versions. Engine rollback does not roll back the installer.
If a later engine step fails, fix the reported error and retry update while
services remain stopped; the persisted installer stays available.

Update never calls init or blanket-renders persona context. `UpdateDeps.reconcile`
is the seam for explicit, idempotent machine-owned asset/state migrations,
including Oneiros checkpoint initialization and job seeding. Curated context
remains untouched.

Distribution follows a **semver-ranges, latest-compatible** policy — there is no
curated bill-of-materials. `update` installs the latest in-range version of each
engine package and then runs `doctor` as a post-install health check. **Rollback
is manual**: the prior version set is recorded before every update, so
`fortytwo rollback` can restore exactly the set that was running before.

## The embedder

The engine uses a **local** embedder for privacy — personal data never leaves
your machine. The standard model is `qwen3-embedding:0.6b`, served by Ollama;
`init` makes sure it is available and `doctor` verifies it.

`init` asks where Ollama runs:

```
Ollama base URL — where the embedder runs (Enter for http://localhost:11434):
```

Press Enter for a local install, or type another endpoint — e.g.
`http://ollama:11434` when Ollama runs in a sibling container. The default shown
is `$OLLAMA_BASE_URL` if it is set, else the URL already saved in `.env` by a
previous `init` (so re-running and pressing Enter keeps it), else
`http://localhost:11434`; an explicit
`--ollama-base-url <url>` skips the question, and `--yes`/non-TTY runs use the
default. The chosen URL is written to both `.env` and the memory server's
`.mcp.json` entry, and `init` checks for the model on **that** server
(`GET /api/tags`), pulling it there over HTTP (`POST /api/pull`) only if it is
missing — the `ollama` CLI is not needed on the installer's machine.

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

## Oneiros installation and upgrades

Init automatically initializes Oneiros at the current memory head and seeds one
`persona.oneiros` scheduler job, with no extra questions. An empty DB starts at
zero; an existing DB starts at its current insertion high watermark.

Update never re-renders persona/context files. After package installation and
health checks it initializes only missing Oneiros state and reconciles the job.
Unchanged-version updates also reconcile incomplete wiring, while dry-run does
not mutate anything. Existing checkpoints and curated context are preserved;
historical memory is never replayed implicitly.

Existing installations first need the updated installer (`1.0.0`); the CLI
is project-pinned and `fortytwo update` does not update that CLI. Once these
coordinated versions are released, use the new CLI, stop services with
`fortytwo stop` (or the service manager), run `fortytwo update`, then restart via
`fortytwo start`. Update refuses live services before changing anything so an
old scheduler cannot claim jobs it does not understand. No second init is needed.

### Runtime ownership across container restarts

`runtime.json` records `processIdentity` alongside the supervisor PID and
heartbeat. On Linux it combines the kernel boot ID, PID namespace and field 22
(start ticks) of `/proc/<pid>/stat`. A fresh file from an earlier container cannot
claim a new process merely because its PID was reused. Start, status, pair and
update use the same ownership check; stop also rechecks immediately before
signalling and while waiting for that process generation to exit.

On macOS and other systems with `ps -p <pid> -o lstart=`, the fallback compares
the OS start timestamp using a fixed locale/timezone and a bounded command.
This fallback has second-level precision; it cannot distinguish reuse of the
same PID within the same second. Linux uses kernel start ticks instead. Missing
or unreadable identity is never accepted as proof of ownership, and a supervisor
that cannot read its own identity refuses to start services.

Legacy runtime records without `processIdentity` are treated as stale. Stop an
older running supervisor through its container/service manager before upgrading;
its PID-only record cannot safely be adopted or signalled by the new CLI. The
heartbeat timeout, foreground supervision and external restart policy are unchanged.

Identity is rechecked immediately before `SIGTERM`, but Node's PID-based signal
API does not make the check and signal atomic. Eliminating that final OS race
would require a native process handle (for example Linux pidfd), beyond this fix.

To reproduce the two-container ownership regression locally (Docker and a
`node:22` image required), run from the installer repository. Both containers
use PID 1 and share only the disposable workspace. The repository is read-only.
The subshell keeps fail-fast settings out of your interactive shell.

```sh
(
  set -euo pipefail
  npm run build
  fixture_dir="$(mktemp -d)"
  docker run --rm -v "$PWD":/code:ro -v "$fixture_dir":/workspace -w /workspace \
    node:22 node /code/test/runtime-container.mjs seed
  docker run --rm -v "$PWD":/code:ro -v "$fixture_dir":/workspace -w /workspace \
    node:22 node /code/test/runtime-container.mjs check
)
```

## Release notes — 1.0.0-13

Doctor's former `safety gate` check is now `gate package compatibility`.
It still fails for a missing package or incompatible policy schema. Success means
only that the package/schema is compatible: optional Claude hook activation and
enforcement are not checked. Doctor does not report Gate as active or inactive.
Claude Code owns tool permissions; Gate adds optional policy through explicitly
configured Claude hooks/plugins. The library remains required by Telegram's
attachment provenance helpers even when its policy hook is not enabled.
