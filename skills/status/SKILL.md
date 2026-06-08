---
description: Inspect open botook tasks involving me. Usage: /botook:status [peer_alias]
---

# /botook:status

Use the channel's `list_tasks` tool to show what's currently open.

1. Call `list_tasks` (from this plugin's MCP server) with `include_terminal=false`. If `$ARGUMENTS` is non-empty treat it as `peer_alias` and pass it through.
2. Render a compact table:
   - task_id (short, last 6 chars)
   - peer
   - state
   - title
   - age (now - created_at)
3. If nothing's open, say so.
4. Also call `list_tasks` with `include_terminal=true, limit=5` and surface the most recent closed tasks so the user has context.
