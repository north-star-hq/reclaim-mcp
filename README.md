# reclaim-mcp

MCP server for Reclaim.ai 1.0: create and manage tasks that Reclaim schedules as named calendar blocks, pick the Hours (and so the calendar) each task lands on, and create, list or toggle habits. It calls only `https://api.app.reclaim.ai`.

Unofficial: not affiliated with or endorsed by Reclaim.ai. MIT licensed.

## Tools

| Tool | What it does |
|---|---|
| `list_hours` | Hours with their weekly windows and the calendar tasks land on |
| `update_hours` | Change the weekly windows of one Hours; only the days you pass change, an empty list removes a day |
| `list_tasks`, `get_task` | Tasks with durations and block sizes in minutes |
| `create_task`, `update_task` | Title, total minutes, min/max block minutes, Hours by name, Work/Personal, due, not-before, priority, notes |
| `complete_task`, `delete_task` | Mark done, or delete with its blocks |
| `list_task_blocks` | Scheduled blocks and which calendar each is on |
| `list_habits`, `set_habit_enabled` | Habits and whether they are on; turn one on or off |
| `create_habit` | Weekly habit: block length, days, ideal time, Hours by name; lands on the Hours' task calendar unless another is named |

## Local setup (macOS)

Requires Node 24 (runs the TypeScript directly, no build step).

```sh
npm install
security add-generic-password -s reclaim-api-key -a "$USER" -w   # paste the key from app.reclaim.ai/settings/developer
claude mcp add -s user reclaim -- "$(which node)" "$PWD/src/stdio.ts"
```

The server reads `RECLAIM_API_KEY` from the environment first, then the Keychain item `reclaim-api-key`. For Claude Desktop, add the same command under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`.

## Hosted (Vercel, for claude.ai web and mobile)

`api/mcp.ts` serves the same tools over HTTP. Every request needs `Authorization: Bearer <secret>`, where the secret is one of the comma-separated values in `MCP_SECRETS` (one per person, so each can be revoked alone). Production environment variables:

| Variable | Value |
|---|---|
| `RECLAIM_API_KEY` | Reclaim API key |
| `MCP_SECRETS` | Comma-separated connector secrets |

In claude.ai, add a custom connector with the URL `https://<deployment>/api/mcp` and a request header `Authorization: Bearer <your secret>`. It then appears in the mobile apps too.

## Checks

```sh
npm test
npm run typecheck
```
