# Claude Code and other MCP clients

The engine's core under `src/` has no Pi imports and no npm dependencies. Besides
the Pi package, the repository therefore ships two more front ends:

- a **Claude Code plugin**: the repository root is the plugin and its own
  marketplace;
- a stdio **MCP server** (`mcp/server.mjs`) for any MCP client: Claude Code,
  Codex, Cursor, Gemini CLI and others.

Neither needs `npm install`; Node.js 22.19+ is enough. The bundled Pi companion
extensions (pi-knowledge, LSP, code mode, lean edit) are Pi-only and are not
part of this.

## What you get

| Pi extension | Claude Code plugin / MCP |
|---|---|
| `delegate_implementation`, `execute_delegated_implementation` | same tools over MCP, running the same workflows |
| `/offline-doctor`, `/offline-status`, `/offline-stats` | `offline_doctor`, `offline_status`, `offline_stats` MCP tools |
| dotnet build/test output compaction (`tool_result`) | `PostToolUse` hook on Bash/PowerShell (plugin only) |
| repository snapshot before agent runs | `SessionStart` hook (plugin only) |
| tool guidelines in the system prompt | the `bounded-delegation` skill (plugin only) |
| `/offline-tools`, edit providers, training capture commands | not ported (Pi-specific); `PI_OFFLINE_TRAINING_CAPTURE=1` still enables capture |

## Install in Claude Code

```text
/plugin marketplace add AndrewMoryakov/pi-offline-engine
/plugin install pi-offline-engine@pi-offline-engine
```

From a clone, without a marketplace, start Claude Code with the plugin loaded
from that directory (see `claude --help` for the plugin-directory flag of your
version).

The implementer endpoint and model resolve exactly as in Pi: environment
(`PI_OFFLINE_TINY_ENDPOINT`, `PI_OFFLINE_TINY_MODEL`, `PI_OFFLINE_TINY_API_KEY` /
`OPENROUTER_API_KEY`, `PI_OFFLINE_TINY_MAX_ATTEMPTS`), then the engine config file
written by Pi's `/offline-setup` (`~/.pi/agent/pi-offline-engine/config.json`,
`PI_CODING_AGENT_DIR` honoured), then the defaults. Without Pi, set the
environment variables before starting Claude Code. Run `offline_doctor` once.

## Use as a plain MCP server

```json
{
  "mcpServers": {
    "pi-offline-engine": {
      "command": "node",
      "args": ["/path/to/pi-offline-engine/mcp/server.mjs"],
      "env": {
        "PI_OFFLINE_TINY_ENDPOINT": "http://127.0.0.1:8080",
        "PI_OFFLINE_TINY_MODEL": "qwen2.5-coder-3b-instruct"
      }
    }
  }
}
```

## Workspace

The server writes only inside one workspace, chosen in this order:

1. `PI_OFFLINE_WORKSPACE`;
2. `CLAUDE_PROJECT_DIR`, which Claude Code sets for MCP servers;
3. the client's first MCP root.

It never falls back to its own working directory, because a plugin-launched
server may run from the plugin's install directory. For the same reason a
workspace inside the engine's own directory is refused, unless it is set
through `PI_OFFLINE_WORKSPACE`. Every result ends with `Workspace: <path>`.

Engine state goes to `<workspace>/.pi/offline-engine/`, which ignores itself
(it holds a `.gitignore` containing `*`), because other repositories do not
list it.

## Approval

In Pi, `execute_delegated_implementation` asks once before writing, naming the
model, files and attempts. The MCP server asks the same question through MCP
**elicitation**. A client that cannot elicit is refused, and a declined or
cancelled elicitation returns "cancelled by user" with nothing written.

`claude -p` (2.1.286) advertises elicitation but cancels every request without
a human. A delegated write therefore cannot happen in print mode by accident.
In a separately sandboxed headless workflow, set
`PI_OFFLINE_ALLOW_HEADLESS_APPLY=1` in the server's environment, the same
switch Pi uses for headless runs. With it set, the server does not ask at all,
in interactive sessions too.

The client's own tool-permission prompt is deliberately not treated as that
approval. Permission bypass modes, allow-lists and non-interactive runs skip
that prompt. `delegate_implementation` writes nothing and needs no approval.

## Differences from the Pi extension

- **No cross-process write queue.** Pi serializes the delegated write with its
  own edit tools; an MCP server cannot. The SHA-256 preimage check still
  refuses a candidate if a declared file changed while the implementer was
  working. Keep the guideline: make the execute call the only mutating call in
  its turn.
- **Progress.** When the client sends a progress token, each implementer
  attempt is reported as an MCP progress notification.
- **Long calls.** One execute call can take minutes: up to three implementer
  calls plus dotnet build/test. If your client limits tool-call time, raise
  the limit for this server.

## Frontier main model, cheap implementer

Nothing in the contract assumes a local main model. With Claude (or GPT,
Gemini) as the reasoner and a local llama.cpp / LM Studio / Ollama model, or a
hosted router model, as the implementer, delegation saves the frontier model
the output tokens of mechanical edits and their compile-fix loops. Your code
stays local when the implementer is local. With a hosted implementer,
`offline_doctor` reports an `endpoint_locality` warning naming the host that
receives your source excerpts.
