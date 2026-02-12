# Overwatch

Self-organizing AI task system. Decomposes complex requests into focused, isolated agent sessions that run in parallel.

```
Telegram Bot ──writes──▶ SQLite ◀──reads── Daemon Manager
     ▲                      ▲                    │
     │                      │               fork / kill
     │                      │                    ▼
     └──reads events────────┴──read/write── Daemon (1 per project)
                                                 │
                                           ┌─────┼─────┐
                                         agent  agent  agent
```

Three independent processes, one SQLite database:

| Process | What it does |
|---------|-------------|
| **Telegram Bot** | Stateless relay. Writes commands to DB, reads events back. |
| **Daemon Manager** | Always-on. Scans DB, spawns daemon processes, health checks. |
| **Daemon** | One per project. Decomposes tasks, runs agents, sends results to Telegram. |

If the bot dies, daemons keep working. If the manager dies, running daemons keep working. Everything reconnects through SQLite.

## Prerequisites

- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com/)
- A Telegram bot token (see [Setting up Telegram](#setting-up-telegram) below)
- Your Telegram username (see [Setting up Telegram](#setting-up-telegram) below)

## Setup

```sh
git clone <repo> && cd overwatch
npm install
npm run build
```

Copy the example env file and fill in your values:

```sh
cp .env.example .env
```

Edit `.env`:

```sh
ANTHROPIC_API_KEY=sk-ant-...
OW_TELEGRAM_TOKEN=123456:ABC-DEF...
OW_ALLOWED_USERS=yourusername    # your Telegram username (without @) — REQUIRED for security
```

The bot rejects all messages if `OW_ALLOWED_USERS` is empty.

## Launch

```sh
source .env
npm start
```

That's it. This launches the daemon manager, Telegram bot, and TUI dashboard in a single process. Open Telegram and message your bot.

If a component crashes, it auto-restarts after 3 seconds. Ctrl+C stops everything.

For headless servers (no terminal UI):

```sh
npm run start:headless
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start <name> <description>` | Create a project and start working |
| `/status` | List all daemons with task progress and cost |
| `/tree <name>` | Show the task tree for a project |
| `/kill <name>` | Stop a daemon and all its agents |
| `/pause <name>` | Pause a daemon (no new agents spawn) |
| `/resume <name>` | Resume a paused daemon |
| `/retry <task-id>` | Retry a failed task |
| `/logs <task-id>` | View task output |
| `/answer <task-id> <text>` | Answer an agent's question |
| `/config` | List/manage MCP server configs |

## Example

```
You:   /start api Build a REST API with JWT auth and user CRUD
Bot:   Started project "api" (daemon: 01J...)
Bot:   [2 minutes later]
       Project "api" completed.
       Result:
       ## Auth System
       Created JWT middleware in src/middleware/auth.ts...
       ## User CRUD
       Added routes in src/routes/users.ts...
       ## Integration Tests
       All 12 tests passing...
```

## Skills

Overwatch automatically downloads the [Anthropic Skills](https://github.com/anthropics/skills) library on first run. During task decomposition, the system selects relevant skills (e.g. `frontend-design`, `webapp-testing`, `pdf`) and injects them into each agent's workspace. No setup required — it just works.

Skills are stored in `~/.overwatch/skill-library/`. To use a custom skill library, set `OW_SKILL_LIBRARY_DIR` to a directory containing a `skills/` folder with skill subdirectories.

See [SECURITY.md](SECURITY.md) for important information about external skill execution.

## How It Works

1. You send `/start api "Build a REST API"` to Telegram
2. Bot writes a daemon record + root task to SQLite
3. Manager detects the new daemon, forks a process
4. Daemon decomposes the prompt into subtasks via Claude (e.g., "Auth System", "User CRUD", "Tests")
5. Independent subtasks run in parallel, each in a fresh agent session
6. When all subtasks complete, results are aggregated and sent back to Telegram
7. Daemon goes idle. Manager leaves it alone until new work arrives.

## Setting up Telegram

### Getting your bot token from BotFather

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` to create a new bot
3. Follow the prompts to set a name and username for your bot
4. BotFather will reply with your bot token (looks like `123456:ABC-DEF...`) — copy it into `OW_TELEGRAM_TOKEN` in your `.env`

### Getting your username

Your Telegram username is the `@handle` shown in your profile (e.g. `@johndoe`). Add it to `OW_ALLOWED_USERS` in your `.env` without the `@` prefix. Multiple usernames can be comma-separated.

## Configuration

All config is via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Required. Anthropic API key. |
| `OW_TELEGRAM_TOKEN` | — | Required. Telegram bot token from [@BotFather](https://t.me/BotFather). See [Setting up Telegram](#setting-up-telegram). |
| `OW_ALLOWED_USERS` | `""` | Comma-separated Telegram usernames (without `@`). Empty = reject all. See [Setting up Telegram](#setting-up-telegram). |
| `OW_MODEL` | `sonnet` | Claude model for agents. |
| `OW_MAX_AGENTS` | `5` | Max concurrent agents per daemon. |
| `OW_AGENT_TIMEOUT_MS` | `600000` | Per-agent timeout (10 min). |
| `OW_BUDGET_CAP_USD` | `0` | Per-daemon spend cap. 0 = unlimited. |
| `OW_DB_PATH` | `.overwatch/orch.db` | SQLite database path. |
| `OW_SKILL_LIBRARY_DIR` | `~/.overwatch/skill-library/` | Directory containing external skills. Auto-downloaded on first run. |
| `OW_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

## Development

Run everything without building (uses tsx):

```sh
npm run dev
```

Or run individual components:

```sh
npm run dev:manager
npm run dev:telegram
npm run dev:tui
```

Run a single daemon directly (bypasses manager):

```sh
npm run dev:daemon -- --name test --prompt "list files in the current directory"
```

## Production (systemd)

Build the project first:

```sh
npm run build
```

Then set up systemd services:

```sh
sudo bash scripts/setup.sh
sudo systemctl enable --now overwatch-manager
sudo systemctl enable --now overwatch-telegram
```

Daemons are spawned automatically by the manager. To manually start one via systemd:

```sh
sudo systemctl start overwatch-daemon@myproject
```

## Architecture

```
src/
├── launch.ts         # Single entry point — spawns all components
├── daemon/           # Standalone process per project
│   ├── index.ts      # Entry point (parses args, sets up TG messaging)
│   ├── scheduler.ts  # Event loop: decompose → spawn → promote → aggregate
│   ├── agent-pool.ts # Concurrent SDK query() calls with timeout
│   ├── decomposer.ts # LLM-powered task decomposition
│   ├── hooks.ts      # SDK hooks (file tracking, session capture)
│   ├── budget.ts     # Per-daemon cost tracking
│   └── lifecycle.ts  # Signal handlers, PID file
├── manager/          # Always-on process that spawns daemons
│   └── index.ts      # Scans SQLite, forks daemons, health checks
├── telegram/         # Stateless Telegram bot
│   ├── index.ts      # Grammy bot setup, auth middleware
│   ├── commands.ts   # Command handlers (all DB-only)
│   └── router.ts     # Writes daemon/task records to DB
├── db/               # SQLite layer
│   ├── index.ts      # Connection, WAL mode, transactions
│   ├── schema.ts     # Tables, indexes, migrations
│   └── queries.ts    # Typed query functions
├── shared/           # Cross-process utilities
│   ├── types.ts      # TypeScript interfaces
│   ├── config.ts     # Validated env var config
│   └── logger.ts     # Structured logging (console + file)
├── skills/           # Role-based agent instructions
│   ├── index.ts      # Skill injection (role + library skills)
│   ├── library.ts    # Skill library scanner + auto-downloader
│   └── */SKILL.md    # Per-role system prompts
├── mcp/              # MCP server configuration
│   ├── defaults.ts   # Built-in server configs per role
│   └── registry.ts   # Merges DB + defaults with validation
└── tui/              # Terminal dashboard (React + Ink)
    ├── index.ts      # Main app
    ├── tree-view.ts  # Task tree renderer
    └── log-view.ts   # Event log
```
