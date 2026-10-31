# claude-toolbox

Everything I build for Claude and Claude Code: mods now, and other Claude use cases as they come.

## What's here

| Folder | What it holds |
| --- | --- |
| `mods/` | Mods that change Claude Code's interface or behaviour |

Add each new kind of thing in its own top-level folder.

## Mods

| Mod | What it does | Command |
| --- | --- | --- |
| `api-cost` | Shows what a session, its subagents and its sub-sessions would have cost at Claude API prices | `/api-cost` |
| `session-timing` | On request, opens a side pane showing when each step started and how long it took | `/session-timing` |
| `skill-scoreboard` | Tracks which skills fire across sessions and which installed skills never fire | `/skill-scores` |

### Install

Type this at the prompt of a terminal session, using the mod's name:

```text
/plugin install session-timing --marketplace Vbmavani/claude-toolbox
```

Answer `y` to add the marketplace, then pick a scope.

## Contributing

Changes reach `main` only through a pull request. Each pull request must pass the secret scan and CodeQL checks in `.github/workflows/security.yml`.
