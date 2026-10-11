# AGENTS.md — @justfortytwo/installer

## Purpose

`@justfortytwo/installer` is the all-in-one install and lifecycle CLI for **fortytwo**, a personal assistant built on Claude Code. One entry point (`dist/index.js`) ships as two bins:

- `create-fortytwo` runs `init` when called with no verb.
- `fortytwo <verb>` is used day to day.

The verbs are `init`, `start`, `status`, `stop`, `pair`, `doctor`, `update`, `rollback`, `enrich`, `forget` and `unbind` (see README.md for what each does). `enrich` is still a stub: it throws `TODO(impl)`.

The CLI covers both of fortytwo's surfaces:
1. **The npm engine**: the `@justfortytwo/{memory,gate,persona,telegram,scheduler}` packages.
2. **The scaffolded persona**: `CLAUDE.md` and `context/*`, rendered from the `@justfortytwo/persona` templates against `.fortytwo/identity.json`. This surface is per-user and gitignored. It is not a plugin.

## Layout

```
src/
  index.ts          verb dispatch (resolveVerb/main); runs only when invoked as a bin (realpath guard)
  engine.ts         project-rooted sibling lookup (findSiblingDir) + dynamic import, installed-version lookup,
                    fortytwo.compat reader, minimal semver caret matcher, Ollama + migration probes
  state.ts          .fortytwo/identity.json (answers) + .fortytwo/state.json (version set / rollback ledger)
  render.ts         persona renderer (managed vs captured outputs, idempotent)
  shim.ts           the user-level `fortytwo` launcher (POSIX sh) init installs on PATH
  runtime.ts        foreground supervisor behind `fortytwo start` + .fortytwo/runtime.json ownership
  commands/
    init.ts         answer resolution, .env merge, .mcp.json, engine auto-install, provisioning
    doctor.ts       health checks (DoctorDeps injection); scheduler heartbeat check
    update.ts       update + rollback logic (rollback.ts just re-exports runRollback)
    start.ts, status.ts, stop.ts   thin wrappers over runtime.ts
    pair.ts, unbind.ts, forget.ts, enrich.ts
test/               vitest suites (*.test.ts), incl. e2e.test.ts
.github/workflows/ci.yml   delegates to justfortytwo/.github node-ci.yml
```

## Commands (from package.json)

- `npm ci`: install dev dependencies (typescript, @types/node, vitest). The package has **no runtime dependencies**.
- `npm run build`: runs `tsc -p tsconfig.json`, compiling `src/` to `dist/` (gitignored).
- `npm test`: runs `vitest run`. There is no vitest config file, so the defaults apply. To run one file: `npx vitest run test/doctor.test.ts`.
- `prepublishOnly` runs the build.
- No lint or format script is configured.

Requires Node >= 20 (`engines`). Node 20 or 22 LTS is recommended because memory's `better-sqlite3` ships prebuilt binaries for those versions.

## Testing notes

- `test/e2e.test.ts` and the doctor/forget/pair paths import the **real** sibling packages, for example `@justfortytwo/memory` with its `FakeEmbedder` and a real sqlite DB. These siblings are not declared in `package.json` at all (only in `fortytwo.compat`), so `npm ci` does **not** install them. Locally, those tests need the siblings resolvable through `node_modules`, either installed or linked. In CI, the shared workflow takes `siblings: "gate memory persona telegram scheduler"`; it must list every `fortytwo.compat` package, or e2e `init` runs a real `npm install` in the sandbox that prunes the linked siblings. `linkEngineInto` throws early if one is missing.
- Tests use `mkdtempSync(tmpdir())` sandboxes, and e2e tests `process.chdir` into them. Restore cwd and env in `afterEach`. A test that chdirs into a sandbox and needs real siblings must call `linkEngineInto(dir)` (`test/helpers/engine.ts`), since siblings resolve from the project, not from this repo.
- Unit tests target the pure, exported helpers rather than the fs/spawn wrappers. Examples: `resolveAnswers`, `mergeEnvContent`, `buildMcpConfig`, `engineInstallSpecs`, `pickLatestInRange`, `performUpdate`/`performRollback` with injected deps, and `runDoctorChecks(deps)`. Keep new logic in that testable form.

## Code conventions

- ESM with `"module": "NodeNext"` and `verbatimModuleSyntax`. Relative imports use `.js` suffixes, and type-only imports use `import type`.
- `strict` and `noUncheckedIndexedAccess` are on, so handle `undefined` from indexing (e.g. `argv[i]`).
- Style: two-space indent, single quotes, semicolons. Every file opens with an explanatory header comment.
- Commands export `runX(argv): Promise<number>`, where the number is the exit code. Arguments are parsed by hand with no CLI framework.
- Side effects such as npm, ollama and fs go behind injectable `*Deps` interfaces (`DoctorDeps`, `UpdateDeps`, `RollbackDeps`) so they can be tested.
- Commit style: `feat(scope): …`, `fix(scope): …`, `docs: …`, `release: installer X.Y.Z …`.

## Architecture notes and gotchas

- **Engine siblings are undeclared at the npm level.** Reach them only through `loadSibling`/`loadGate`/`loadMemory`/`loadTelegram` in `engine.ts`, which use dynamic import and return `null` if the package is missing. Never add a static import of an `@justfortytwo/*` package, because a partial install must not crash the CLI.
- **`fortytwo.compat` is the only version list.** `init` (auto-install), `doctor` (range cross-check) and `update` (latest-in-range) all read it. The siblings used to be duplicated as optional `peerDependencies`; that was removed because the two lists drifted (`fix(pkg): reconcile peerDependencies with fortytwo.compat`) and because npm validates optional peers against already-installed packages, so upgrading the installer past a sibling's range hard-failed with `ERESOLVE`. Do not re-add `@justfortytwo/*` to `dependencies`/`peerDependencies`; a test enforces this.
- **Siblings resolve from the TARGET PROJECT, never from the installer.** Under `npx create-fortytwo` the installer runs from npm's exec cache (`~/.npm/_npx/<hash>/node_modules`), a separate tree from the project where `init` installs the engine. `findSiblingDir` (engine.ts) walks up `node_modules` from the project root (`process.cwd()`); `loadSibling`, `readInstalledVersion` and `loadPersonaManifest` all go through it, and `loadSibling` imports the resolved ESM entry by file URL. Never use a bare `import(spec)`, `createRequire(import.meta.url)` or `require.resolve` for siblings (the latter also fails on gate/telegram's import-only `exports`). There is deliberately no fallback to the installer's own tree. `test/topology.test.ts` guards this.
- `satisfiesRange` is a deliberately minimal matcher. It handles exact versions and `^` ranges, including npm's 0.x rule. Do not add a semver dependency, and do not use range forms it cannot parse.
- **Render idempotence:** MANAGED outputs are rewritten on every run. CAPTURED outputs are written once and belong to the user afterwards. Never clobber user edits. `render.ts` also guards against path traversal and prototype pollution, so keep those guards.
- `state.json` writes are atomic (a tmp file, then rename). Rollback is **single-step** (`previous` only) and **manual**; it is never triggered automatically. Re-recording an identical set must not overwrite `previous`.
- Secrets and `ALLOWED_CHAT_IDS` go only to the gitignored `.env`. `identity.json` holds non-secret answers. Never commit either file, and never prompt for secrets that flags or env can supply.
- `init` writes a `fortytwo-memory` entry into `.mcp.json` (`npx -y @justfortytwo/memory`) and passes `DB_PATH`/`EMBED_MODEL`/`OLLAMA_BASE_URL` through that entry's env. The memory server reads those settings from there, not from `.env`. The defaults are `db/fortytwo.db`, `qwen3-embedding:0.6b` and `http://localhost:11434`.
- Answer precedence in `resolveAnswers`: answers-file, then `FORTYTWO_*` env, then flags, then the manifest default.
- **CLI availability (`src/shim.ts`, `cliInstallSpec` in init):** `npx` runs the installer from a throwaway cache, so init (1) pins `@justfortytwo/installer@<own version>` into the project with `--save-exact` (skipped when that exact version is already there or under `--no-install`; `FORTYTWO_INSTALLER_SPEC` swaps in a local tarball for dev/CI) and (2) writes one generic launcher into the first writable dir ALREADY on PATH (`~/.local/bin`, `~/bin`, `npm prefix -g`/bin; `FORTYTWO_BIN_DIR` overrides). The launcher carries no version or project path: it walks up to the nearest `.fortytwo/` and execs that project's `node_modules/.bin/fortytwo` from the project root, but only when that `.fortytwo/` and CLI are owned by the current user (`[ -O ]`; blocks code planted by other users in shared ancestors like `/tmp`); keep that check. Never edit shell rc files or PATH; never overwrite a `fortytwo` without the `fortytwo-shim` marker; ignore npm's transient `node_modules/.bin`/`_npx` PATH entries. The installer must stay OUT of `fortytwo.compat` so `update` never moves the CLI (a test enforces this). Tests that run init must set `FORTYTWO_BIN_DIR` to a sandbox.
- **Runtime lifecycle (`start`/`status`/`stop`):** `fortytwo start` is a foreground supervisor only. It spawns each service's own bin (`fortytwo-telegram-bridge`, `fortytwo-scheduler`) with `node`, cwd = project, env = process env > `.env` > `FORTYTWO_ROOT=<project>`, never detached, and never restarts them (Docker/systemd own that). No service logic belongs here. `.fortytwo/runtime.json` (supervisor pid + heartbeat + children) is the only ownership record; it counts as live only with a fresh heartbeat (`RUNTIME_STALE_MS`) and a living pid. `stop` signals only that pid; never add process discovery by name. `pair` refuses to print a code unless Telegram is running under `start` (`--force` overrides).
- **Cross-repo path contracts:**
  - `pair` must write to the same bindings DB that the telegram bridge reads: `state/telegram-bindings.db`, or `TELEGRAM_BINDINGS_DB` if set (shell or `.env`). The bridge resolves it against `FORTYTWO_ROOT`, which `start` sets to the project.
  - `doctor` reads `<dirname(DB_PATH)>/scheduler.heartbeat`, which must match `heartbeatPath()` in `../scheduler/src/heartbeat.ts`. Its stale threshold is 90s (3 × the scheduler's 30s poll).
  - If you change a path on one side, change it on the other side too.
- `doctor` checks fail as **required** or as warn-only. Ollama/embedder and the scheduler daemon are warn-only. It asserts the gate's `POLICY_SCHEMA_VERSION` and memory's `MEMORY_TOOL_CONTRACT_VERSION`.
- Some docs are stale. The header comment in `src/index.ts` still says update/rollback/forget "await publish", but they are wired. The README's list of auto-installed packages leaves out `scheduler`, which is now in `fortytwo.compat`. Treat code and `package.json` as the source of truth.

## Sibling repos (`../`)

Each is a separate git repo under the `justfortytwo` org:
- `gate`: the PreToolUse safety gate.
- `memory`: the memory MCP server, DB migrations and embedder.
- `persona`: `templates/` and `manifest.json`, consumed by `render.ts`.
- `telegram`: the channel adapter and bindings store.
- `scheduler`: the `fortytwo-scheduler` daemon and its heartbeat.

The workspace also contains `docs`, `marketplace`, `runner`, `salience` and `website`. The installer does not reference them directly.

Only edit this repo unless the task explicitly spans siblings.

## fortytwo project context

This repository is part of **fortytwo**, a local-first personal-assistant spine built around existing agent runtimes and tool ecosystems.

The umbrella project is **fortytwo**. It is not intended to replace Claude Code, Codex, MCP servers, plugins, skills, or other agent runtimes. The project provides the durable personal-assistant infrastructure around them: memory, lifecycle, scheduling, channels, optional policy enforcement, and related supporting components.

Claude Code is currently the primary/reference runtime, but the architecture should avoid unnecessary coupling to a specific model provider. In particular, components should remain usable when Claude Code itself is configured against alternative compatible model providers.

The main bootstrap and lifecycle entry point is the **installer** repository (`justfortytwo/installer`).

### Canonical project locations

- Website: `forty-two.it`
- GitHub organization: `github.com/justfortytwo`
- Architecture/design documentation: `justfortytwo/docs`

### Repositories

The fortytwo project is intentionally split into small, focused repositories.

- **`justfortytwo/installer`**
  Main installer and lifecycle CLI (`create-fortytwo` / `fortytwo`). This is the primary bootstrap entry point for assembling a fortytwo installation.

- **`justfortytwo/runner`**
  Thin Claude Code process/session runtime. Owns process lifecycle and stream transport, including one-shot runs and persistent interactive sessions. It must not become an agent framework.

- **`justfortytwo/memory`**
  Durable semantic-memory MCP server backed by local storage and retrieval infrastructure.

- **`justfortytwo/scheduler`**
  Durable scheduling and proactive job execution. Owns *when* work should happen, not how the agent reasons about or performs that work.

- **`justfortytwo/telegram`**
  Telegram transport/channel adapter. Owns Telegram identity, pairing, message transport, attachment handling, and mapping chats to live agent sessions. It should delegate agent process lifecycle to `runner`.

- **`justfortytwo/persona`**
  Persona and context templates rendered by the installer into an individual fortytwo installation.

- **`justfortytwo/gate`**
  Optional external safety/policy enforcement layer for tool execution and approvals. Keep this separate from the agent runtime's own reasoning and permissions.

- **`justfortytwo/salience`**
  Optional model-driven salience extraction used to enrich durable memory.

- **`justfortytwo/marketplace`**
  Claude Code plugin marketplace and umbrella plugin used as a distribution surface for fortytwo components.

- **`justfortytwo/docs`**
  Cross-repository architecture, design, contracts, and project documentation.

- **`justfortytwo/website`**
  Public website for the project, served as `forty-two.it`.

- **`justfortytwo/.github`**
  GitHub organization metadata and shared organization-level project information.

### Cross-repository architecture

When changing one repository, treat the sibling repositories as parts of the same system.

The intended high-level ownership is:

```text
channels / scheduler
        |
        v
      runner
        |
        v
   agent runtime
  (Claude Code today)
        |
        +---- MCPs / plugins / skills / tools
        |
        +---- fortytwo memory

optional surrounding components:
- gate
- salience

bootstrap / distribution / documentation:
- installer
- persona
- marketplace
- docs
- website
```

A useful rule when deciding where code belongs:

> fortytwo should add continuity and infrastructure around an existing agent, not reimplement capabilities already owned by the agent runtime or its MCP/plugin ecosystem.

Examples:

- agent reasoning, planning, subagents, tools, MCP orchestration, and plugins belong to the agent runtime;
- Claude process/session lifecycle belongs to `runner`;
- durable memory belongs to `memory`;
- durable time and scheduled execution belong to `scheduler`;
- Telegram transport and Telegram identity belong to `telegram`;
- installation and lifecycle management belong to `installer`;
- browser automation should normally come from an existing MCP/plugin rather than a fortytwo-specific browser implementation.

Before introducing a new abstraction, check the relevant sibling repositories and the agent runtime's existing capabilities to avoid duplicating functionality elsewhere in the fortytwo stack.

<!-- openwolf:begin -->
# OpenWolf

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md at session start. Check .wolf/cerebrum.md before generating code. Grep .wolf/anatomy.md for a file's path before reading it (never read the whole index).
<!-- openwolf:end -->
