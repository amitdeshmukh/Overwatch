# Security

## External Code Execution

Overwatch executes AI agents that can read, write, and run code on your machine. By design, agents operate with broad filesystem and shell access within their workspace directories.

**Use this software at your own risk.**

## Skills

On first startup, Overwatch automatically downloads the [Anthropic Skills](https://github.com/anthropics/skills) library from GitHub. Skills are markdown instructions and scripts that get injected into agent workspaces to guide their behavior.

### What this means

- Skills are **third-party code** fetched from the internet at runtime
- Skills may include executable scripts (Python, Bash, JavaScript) that agents can invoke
- Skills are downloaded once and cached locally at `~/.overwatch/skill-library/`
- There is no signature verification or integrity checking on downloaded skills
- A compromised or malicious skill could instruct an agent to execute arbitrary commands

### Mitigations

- Skills are sourced from Anthropic's official repository by default
- You can inspect all downloaded skills in `~/.overwatch/skill-library/skills/`
- You can point `OW_SKILL_LIBRARY_DIR` to a directory you control to use only vetted skills
- You can delete `~/.overwatch/skill-library/` and set `OW_SKILL_LIBRARY_DIR` to an empty directory to disable external skills entirely
- Agents run with the permissions of the user that started the daemon — do not run as root

### Recommendations

- Review the contents of `~/.overwatch/skill-library/` after first run
- Run Overwatch under a dedicated user account with limited permissions
- Do not run Overwatch on machines with access to sensitive credentials or production systems without understanding the risks
- Set `OW_BUDGET_CAP_USD` to limit API spend in case of runaway agents
- Monitor agent activity via the TUI dashboard or Telegram notifications

## Reporting Vulnerabilities

If you discover a security issue, please open an issue on the repository.
