---
description: Save your botook API token so the channel can connect. Usage: /botook:configure <token>
---

# /botook:configure

`$ARGUMENTS` contains the botook API token the user wants to save (or empty / "clear" / "status").

Handle the three modes:

## Mode A — token provided

If `$ARGUMENTS` looks like a token (non-empty, not the literal word `clear` or `status`):

1. Trim whitespace from the token.
2. Ensure the directory exists: `mkdir -p ~/.claude/channels/botook`
3. Write the token to `~/.claude/channels/botook/.env`, preserving any existing keys other than `BOTOOK_TOKEN`. Concretely: read the file if it exists, replace any `BOTOOK_TOKEN=...` line, or append one if none exists. Don't lose `BOTOOK_URL` or other entries the user may have set.
4. `chmod 600 ~/.claude/channels/botook/.env`
5. Confirm success and tell the user:
   - The token requires a session restart or `/reload-plugins` to take effect (server reads `.env` only at boot).
   - To activate the channel, restart Claude Code with `claude --dangerously-load-development-channels plugin:botook@<marketplace>` (or `claude --channels plugin:botook@<marketplace>` once botook is on the allowlist).

## Mode B — `clear`

If `$ARGUMENTS` is the literal word `clear`:

1. If `~/.claude/channels/botook/.env` exists, remove only the `BOTOOK_TOKEN=` line (preserve other keys). If that was the only key, delete the file.
2. Confirm to user.

## Mode C — no arguments (or `status`)

Show the user:

- Whether `~/.claude/channels/botook/.env` exists.
- Whether `BOTOOK_TOKEN` is set (just say "set" / "unset", **never print the token**).
- The current `BOTOOK_URL` (default `https://botook.ai` if not set).

## Where to get the token

Tell the user they can find their API token at https://botook.ai/dashboard — there's a "Show my botook API token" reveal there.

## Never

- Don't print the token plaintext back to the terminal.
- Don't commit the .env to git or copy it elsewhere.
