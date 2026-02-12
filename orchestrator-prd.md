# Orchestrator PRD

**Product Requirements Document**
Version 1.0 — February 2026

---

## 1. Problem Statement

LLMs lose up to 39% of their effectiveness in long conversations. Context pollution, assumption drift, and inability to recover from mistakes degrade output quality as conversations grow. Current workflows force users into single monolithic chat sessions, making complex multi-step projects unreliable.

## 2. Vision

Orchestrator is a self-organizing AI task system that decomposes complex requests into focused, isolated agent sessions. Each agent maintains a short, clean context window operating at peak performance. A central daemon coordinates agents, manages lifecycle, and communicates with the user over Telegram — all running on a cheap cloud VM.

The core insight: **a chat that creates chats.**

## 3. System Overview

```
                         ┌─────────────────────┐
                         │    TELEGRAM BOT      │
                         │   (always-on proc)   │
                         │                      │
                         │  /start "build api"  │
                         │  /status             │
                         │  /tree api           │
                         │  /kill mobile        │
                         │  /answer 42 "yes"    │
                         └──────────┬───────────┘
                                    │
                              SQLite (WAL)
                              orch.db
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
     ┌────────▼─────────┐ ┌────────▼─────────┐          ...N
     │  DAEMON "api"     │ │ DAEMON "mobile"  │
     │                   │ │                  │
     │  ┌──────────────┐ │ │  ┌────────────┐ │
     │  │ async query()│ │ │  │async query()│ │
     │  │ LEAD         │ │ │  │LEAD        │ │
     │  ├──────────────┤ │ │  ├────────────┤ │
     │  │ async query()│ │ │  │async query()│ │
     │  │ WORKER       │ │ │  │WORKER      │ │
     │  ├──────────────┤ │ │  └────────────┘ │
     │  │ async query()│ │ └──────────────────┘
     │  │ WORKER       │ │
     │  └──────────────┘ │
     └───────────────────┘
```

## 4. Core Principles

**Context isolation** — each task runs in its own agent session. No information bleed between siblings. Parent tasks can access child results; siblings remain independent.

**Parallel by default** — independent tasks execute concurrently as separate `asyncio` tasks. Dependencies are tracked in the task tree and block until resolved.

**Focused sessions** — agents get a tight prompt scoped to one job. Skills and MCP servers are injected per-role, not globally.

**User in the loop, not in the way** — autonomous tasks run without intervention. When an agent hits uncertainty, it escalates questions via Telegram. The user jumps in only when their judgment is needed.

## 5. Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Language | **TypeScript** (Node.js 20+) | Primary language for daemon, bot, TUI |
| Agent runtime | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | Programmatic agent spawning with native MCP, hooks, skills, session resume |
| Database | **SQLite** (WAL mode, via `better-sqlite3`) | Single-file, concurrent reads, zero ops |
| Telegram | **grammy** or **telegraf** | Async Telegram bot framework for Node |
| TUI dashboard | **blessed** or **ink** (React for CLI) | Terminal overwatch UI when SSH'd in |
| Process isolation | **tmux** | Optional — for interactive agent-teams sessions |
| VM | Ubuntu 22.04+, 2 vCPU, 4GB RAM | Cheap cloud VM (Hetzner/Contabo) |
| CLI agent | **Claude Code** (`@anthropic-ai/claude-code` npm) | For interactive/agent-teams when user SSH's in |

## 6. Architecture

### 6.1 Component Breakdown

**Telegram Bot** — a single always-on process. Receives user commands, routes them to the correct daemon by project name, forwards agent questions to the user, sends completion/failure alerts. Stateless relay — all truth lives in SQLite.

**Daemon** — one process per project. Owns the full agent lifecycle: decomposes tasks, spawns agents via SDK `query()`, watches for events, reaps finished agents, promotes blocked tasks, and shuts itself down when complete. Multiple daemons run concurrently, each with its own `daemon_id` in the database.

**Agent Pool** — each agent is an `async` SDK `query()` call running as a concurrent task within the daemon's event loop. Each agent gets its own MCP config, skills, and hooks injected at spawn time. No tmux needed for headless agents.

**Task Tree** — persistent in SQLite. Tree structure with parent/child relationships, dependency tracking, status, and results. The daemon reads and writes it; the Telegram bot and TUI read it.

**Hooks (as callbacks)** — SDK hooks replace shell-script-based hooks. `PostToolUse`, `Stop`, and custom callbacks feed events directly into the daemon's event loop. No file polling, no indirection.

**Overwatch TUI** — optional terminal dashboard for when the user SSH's into the VM. Shows task tree, agent status, logs. Can attach to tmux panes for interactive agents.

### 6.2 Agent Spawning

Each agent is a `query()` call with per-agent configuration:

```typescript
import { query, ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: taskPrompt,
  options: {
    cwd: agentWorkdir,
    allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep", "Skill", "Task"],
    settingSources: ["project"],
    mcpServers: {
      // injected per agent role
      postgres: { command: "npx", args: ["-y", "@bytebase/dbhub", "--dsn", DB_URL] },
      github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
    },
    hooks: {
      Stop: [{ matcher: "", hooks: [onAgentStop] }],
      PostToolUse: [{ matcher: "Edit|Write", hooks: [onFileChange] }],
    },
    permissionMode: "bypassPermissions",
  },
})) {
  handleMessage(message);
}
```

### 6.3 Skills Per Role

Each agent type gets a `SKILL.md` that shapes its behavior. Skills live in `.claude/skills/<role>/SKILL.md` within the project workspace.

| Role | Skill focus | MCP servers |
|------|------------|-------------|
| `lead` | Task decomposition, delegation, result synthesis | github, slack |
| `backend-dev` | API design, DB migrations, server code | postgres, sentry |
| `frontend-dev` | Components, styling, client state | figma, storybook |
| `reviewer` | Code review, security, test coverage | github, sentry |
| `researcher` | Web search, documentation, best practices | web-search |
| `db-admin` | Schema design, queries, migrations | postgres |
| `tester` | Test writing, CI validation | github |

### 6.4 MCP Configuration

MCP server configs are stored in the database or a `configs/` directory. When spawning an agent, the daemon injects the relevant MCP servers as a TypeScript object passed to `mcpServers` in the SDK options. No temp files, no `.mcp.json` on disk.

Supported transports: `stdio` (local CLI tools), `http` (remote services like GitHub, Sentry, Notion).

### 6.5 Interactive Agents (Agent Teams)

When the user SSH's into the VM and wants hands-on collaboration, the daemon can optionally spawn agents using Claude Code CLI with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` in a tmux session. This provides split-pane visibility and direct typing into any agent.

```
tmux: "orch-api"
┌──────────┬──────────┬──────────┐
│ LEAD     │ WORKER 1 │ WORKER 2 │
│ (teams)  │ backend  │ frontend │
└──────────┴──────────┴──────────┘
```

This is an escape hatch, not the default path. Most work runs headless via the SDK.

## 7. Database Schema

```sql
CREATE TABLE daemons (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  pid         INTEGER,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | idle | error
  tmux_session TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  daemon_id   TEXT NOT NULL REFERENCES daemons(id),
  parent_id   TEXT REFERENCES tasks(id),
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | blocked | running | done | failed
  exec_mode   TEXT NOT NULL DEFAULT 'auto',     -- auto | hybrid
  agent_role  TEXT,
  agent_session_id TEXT,
  deps        TEXT DEFAULT '[]',                -- JSON array of task IDs
  result      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  daemon_id   TEXT NOT NULL REFERENCES daemons(id),
  task_id     TEXT REFERENCES tasks(id),
  type        TEXT NOT NULL,     -- task_started | task_done | task_failed
                                 -- needs_input | agent_stop | file_changed
  payload     TEXT DEFAULT '{}', -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mcp_configs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT,              -- NULL = available to all roles
  transport   TEXT NOT NULL,     -- stdio | http
  config      TEXT NOT NULL,     -- JSON: {command, args, env} or {url, headers}
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE skills (
  id          TEXT PRIMARY KEY,
  role        TEXT NOT NULL,
  skill_path  TEXT NOT NULL,     -- path to SKILL.md
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 8. Task Lifecycle

```
User sends message via Telegram
        │
        ▼
Telegram bot → finds/creates daemon → inserts root task
        │
        ▼
Daemon picks up root task
        │
        ▼
Decomposition: daemon runs a meta-prompt via SDK query()
  "Given this request, decompose into subtasks.
   For each: title, prompt, role, dependencies."
        │
        ▼
Subtasks inserted into tasks table
        │
        ▼
Daemon event loop:
  ┌─────────────────────────────────┐
  │  for each task where            │
  │    status = 'pending'           │
  │    AND all deps are 'done':     │
  │                                 │
  │    mark as 'running'            │
  │    resolve MCP config for role  │
  │    resolve skill for role       │
  │    spawn query() as async task  │
  │                                 │
  │  on agent Stop hook:            │
  │    mark task 'done'             │
  │    store result                 │
  │    check: children all done?    │
  │      → aggregate into parent    │
  │    check: unblocked tasks?      │
  │      → spawn them               │
  │                                 │
  │  on needs_input:                │
  │    insert event                 │
  │    telegram.send(question)      │
  │    wait for /answer             │
  │    resume session via SDK       │
  │                                 │
  │  if all tasks done:             │
  │    set daemon status = 'idle'   │
  │    telegram.send("✅ done")     │
  └─────────────────────────────────┘
```

## 9. Execution Modes

| Mode | Behavior | When to use |
|------|----------|------------|
| **auto** | Agent runs to completion. No user input. Results stored in DB. | Research, boilerplate, testing, validation |
| **hybrid** | Starts as auto. Escalates to user via Telegram if agent hits uncertainty. | Most real tasks — lets easy parts fly, catches hard parts |

## 10. Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start <description>` | Create a new daemon + root task |
| `/status` | List all daemons and their state |
| `/tree <daemon-name>` | Show task tree with status indicators |
| `/kill <daemon-name>` | Shut down a daemon and all its agents |
| `/pause <daemon-name>` | Pause a daemon (no new agents spawned) |
| `/resume <daemon-name>` | Resume a paused daemon |
| `/answer <task-id> <response>` | Reply to an agent's question |
| `/retry <task-id>` | Re-run a failed task |
| `/logs <task-id>` | Get recent output from a task's agent |
| `/config` | Show/edit MCP and skill configs |

## 11. Overwatch TUI

Optional terminal dashboard when SSH'd into the VM. Built with `blessed` or `ink`.

```
┌─────────────────────────┬───────────────────────┐
│                         │                       │
│     Task Tree View      │    Agent Logs /       │
│                         │    Live Output        │
│  [api project]          │                       │
│    ├─[✓] decompose      │  Task: backend-api    │
│    ├─[●] backend-api ◄──│                       │
│    │  ├─[●] auth        │  Agent: writing       │
│    │  └─[ ] routes      │  auth middleware...    │
│    ├─[ ] frontend       │                       │
│    └─[ ] tests          │  [streaming output]   │
│                         │                       │
├─────────────────────────┤                       │
│  Daemons:               │                       │
│  api     ● running (3)  │                       │
│  mobile  ○ idle         │                       │
└─────────────────────────┴───────────────────────┘
  [q]uit [t]ree [l]ogs [j]ump-to-tmux [r]efresh
```

Status indicators: `[ ]` pending, `[●]` running, `[✓]` done, `[✗]` failed.

## 12. VM Requirements

```
Hardware:   2 vCPU, 4GB RAM, 40GB disk
OS:         Ubuntu 22.04+ / Debian 12+
```

| Package | Purpose |
|---------|---------|
| `node 20+` / `npm` | Runtime for daemon, bot, TUI, SDK |
| `claude-code` (npm global) | Interactive agent-teams via CLI |
| `tmux` | Interactive split-pane sessions |
| `git` | Agents commit, branch, create PRs |
| `gh` (GitHub CLI) | PR creation, issue management |
| `jq` | JSON parsing in shell hooks |
| `ripgrep` (`rg`) | Fast code search for agents |
| `sqlite3` | Manual DB queries, debugging |
| `docker` (optional) | Sandbox agent code execution |

Process management via `systemd`:
- `orchestrator-telegram.service` — always on
- `orchestrator-daemon@.service` — template unit, one instance per project

## 13. Project Structure

```
orchestrator/
├── package.json
├── tsconfig.json
├── src/
│   ├── daemon/
│   │   ├── index.ts           # daemon entry point
│   │   ├── decomposer.ts      # meta-prompt task decomposition
│   │   ├── scheduler.ts       # event loop, dep resolution, agent spawning
│   │   ├── agent-pool.ts      # manages async query() tasks
│   │   └── lifecycle.ts       # reap, cleanup, shutdown
│   ├── telegram/
│   │   ├── index.ts           # bot entry point
│   │   ├── commands.ts        # /start, /status, /tree, /answer, etc.
│   │   └── router.ts          # routes messages to correct daemon
│   ├── tui/
│   │   ├── index.ts           # overwatch dashboard entry
│   │   ├── tree-view.ts       # task tree renderer
│   │   └── log-view.ts        # agent output viewer
│   ├── db/
│   │   ├── schema.ts          # table definitions + migrations
│   │   ├── queries.ts         # typed query helpers
│   │   └── index.ts           # connection setup (WAL mode)
│   ├── skills/
│   │   ├── lead/SKILL.md
│   │   ├── backend-dev/SKILL.md
│   │   ├── frontend-dev/SKILL.md
│   │   ├── reviewer/SKILL.md
│   │   ├── researcher/SKILL.md
│   │   └── tester/SKILL.md
│   ├── mcp/
│   │   ├── registry.ts        # load/resolve MCP configs per role
│   │   └── defaults.ts        # default MCP server definitions
│   └── shared/
│       ├── types.ts           # shared type definitions
│       ├── config.ts          # env vars, paths, constants
│       └── logger.ts          # structured logging
├── scripts/
│   ├── setup.sh               # VM provisioning script
│   └── systemd/               # service unit files
└── .claude/
    ├── settings.json          # hooks, permissions
    └── skills/                # symlink to src/skills/
```

## 14. Implementation Phases

### Phase 1: Foundation
- SQLite schema + typed query layer
- Single daemon process that can decompose a task via SDK `query()`
- Spawn one agent, watch it complete, store result
- Basic Telegram bot with `/start` and `/status`

### Phase 2: Full Lifecycle
- Task tree with dependencies and parallel execution
- Daemon event loop: spawn, watch, reap, promote
- Execution modes (auto, hybrid)
- Telegram `/tree`, `/answer`, `/kill`, `/retry`
- MCP config registry — per-role injection

### Phase 3: Skills + Polish
- Role-based SKILL.md files for each agent type
- Overwatch TUI dashboard
- Multi-daemon support (concurrent projects)
- Session resume for interrupted agents

### Phase 4: Agent Teams Integration
- Optional tmux-based interactive mode
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` for collaborative work
- Jump-in from TUI to tmux pane
- Hybrid handoff: headless → interactive escalation

### Phase 5: Hardening
- Error recovery and retry strategies
- Token budget tracking per daemon
- Rate limiting and backpressure
- Logging, metrics, and alerting
- Decomposition prompt library with success tracking

## 15. Key Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Agent teams feature is experimental, may break | Core path uses SDK `query()` headless. Agent teams are optional escape hatch. |
| SQLite contention with many concurrent daemons | WAL mode supports concurrent readers. Only one daemon writes its own rows. |
| Agents produce conflicting file edits | Each agent works in a scoped directory. Lead aggregates results. |
| Runaway token costs | Track tokens per daemon via SDK message metadata. Set per-daemon budget caps. |
| Agent stalls or infinite loops | `Stop` hook + timeout per `query()` call. Daemon kills stalled agents. |
| Telegram latency for escalated questions | Hybrid mode — only escalate when truly needed. Most tasks run auto. |

## 16. Success Criteria

- A user can describe a multi-step project via Telegram and have it decomposed, executed in parallel, and delivered — without SSH'ing into the VM.
- Each agent session stays under 20 messages on average.
- Task completion rate > 85% without human intervention on auto-mode tasks.
- Adding a new agent role requires only a `SKILL.md` file and an MCP config entry.
- System runs stable on a $10/month VM.
