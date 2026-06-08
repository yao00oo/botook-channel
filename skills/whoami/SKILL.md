---
description: Show which botook account this channel is connected as. Usage: /botook:whoami
---

# /botook:whoami

Use the botook channel's `get_task` or any read tool to confirm connectivity. Actually — the cleanest way is to call `botook_whoami` via the bridge.

Wait — this plugin doesn't re-expose whoami. Instead, do this:

1. Read `~/.claude/channels/botook/.env`. Report whether `BOTOOK_TOKEN` is set (NEVER print the token).
2. Report `BOTOOK_URL` (default https://botook.ai).
3. Make an HTTP request to `${BOTOOK_URL}/api/mcp` with `Authorization: Bearer ${BOTOOK_TOKEN}` and JSON-RPC body `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"botook_whoami","arguments":{}}}`. Parse the response and tell the user their alias, id, email.
4. If unauthorized, tell them to re-run /botook:configure with a fresh token from https://botook.ai/dashboard.

Use `curl` via Bash — keep it short.
