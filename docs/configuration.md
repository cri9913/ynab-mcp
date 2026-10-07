# Configuration

How to give the server a YNAB token and connect it to an MCP client.

## 1. Get a token

Create a personal access token in YNAB under Account Settings, then Developer Settings. Treat it like a password. Never paste it into an assistant prompt or commit it.

## 2. Store the token

The server reads the token in this order.

1. `YNAB_ACCESS_TOKEN` in the environment of the process that starts the server.
2. On Windows, a DPAPI encrypted file at `YNAB_SECRET_PATH`, or `%LOCALAPPDATA%\LocalSecrets\ynab api key.xml` by default.
3. On other platforms the server exits and asks you to set `YNAB_ACCESS_TOKEN`.

### Linux, macOS and WSL

Keep the token in a private file and load it from your shell profile.

```sh
mkdir -p ~/.config/ynab && chmod 700 ~/.config/ynab
read -rsp "YNAB token: " t && printf 'export YNAB_ACCESS_TOKEN=%s\n' "$t" > ~/.config/ynab/env && chmod 600 ~/.config/ynab/env; unset t
echo '[ -f ~/.config/ynab/env ] && . ~/.config/ynab/env' >> ~/.bashrc
```

Open a new terminal, then confirm without printing the value.

```sh
echo "${YNAB_ACCESS_TOKEN:+set}"
```

### Windows

Store the token with a local masked dialog. It writes a DPAPI encrypted CLIXML file that only your Windows account on this computer can read.

```powershell
powershell.exe -NoProfile -STA -File .\scripts\credential.ps1 -Action Set
```

Do not commit that file. Never run the script's `Get` action through an assistant terminal tool. It is the server's internal interface.

## 3. Connect a client

The server speaks stdio. Any client needs the command `node`, the argument `src/index.js` as an absolute path, and a call timeout above the server's 35 second API timeout. Writes stay off unless you set `YNAB_ALLOW_WRITES=true`.

### Copilot CLI or Claude Code on demand

An agent file carries the server, so it starts only while that agent runs. [Necromancer](https://github.com/cri9913/necromancer) generates this file as `mcp-ynab`. You can also write it by hand at `~/.copilot/agents/mcp-ynab.agent.md`.

```markdown
---
name: "mcp-ynab"
description: "Runs tasks that need the ynab MCP server. Delegate to this agent."
mcp-servers:
  "ynab":
    type: "local"
    command: "node"
    args: ["/absolute/path/to/ynab-mcp/src/index.js"]
    tools: ["*"]
---

You are the ynab specialist. Use the ynab MCP tools to complete the delegated task, then report the result.
If a tool fails for missing credentials, stop and name the variable to set. Never ask for, print or store secret values.
```

Start `copilot` from a shell that already has `YNAB_ACCESS_TOKEN`, then ask in plain language.

```text
use the mcp-ynab agent to summarize my budget for this month
```

The `/agent` command only selects an agent by name. The CLI reads any text after the name as part of the name, so the lookup fails with "Custom agent not found".

### OpenCode

Merge this into your configuration and replace the path.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ynab": {
      "type": "local",
      "command": ["node", "C:/path/to/ynab-mcp/src/index.js"],
      "enabled": true,
      "timeout": 45000
    }
  },
  "permission": { "ynab_*": "ask" }
}
```

Restart OpenCode after changing configuration. Add `"environment": { "YNAB_ALLOW_WRITES": "true" }` only when you want writes.

## 4. Verify

```sh
npm run smoke
```

Smoke performs one `GET /user` through the real stdio connection and prints pass or fail and the tool count. It changes nothing.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `MCP for YNAB could not start. Check dependencies and the local credential` | The server found no token, or `npm ci --ignore-scripts` has not run. A client only reads its environment when it starts, so exit it, open a new shell that has `YNAB_ACCESS_TOKEN`, and start the client again. `/restart` does not reload the environment. |
| `MCP server process exited before completing the MCP initialize handshake` | Same startup failure seen from the client. Run `node src/index.js < /dev/null` in the shell you launched the client from to see the message. |
| `Custom agent not found: mcp-ynab tell me ...` | `/agent` accepts only a name. Run `/agent mcp-ynab`, then send the question as a normal prompt. |
| `maximum sub-agent depth was reached` | A sub-agent cannot start another agent. Delegate from the main session. |
| Writes are rejected | Writes are off by default. Set `YNAB_ALLOW_WRITES=true` and pass `confirm: true` with a concrete plan ID. |
| The agent is missing in a new session | Check that the file exists in the client's agents directory, then restart the client. |
