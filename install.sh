#!/usr/bin/env bash
# botook-channel installer — one liner via OAuth device flow.
# Usage:
#   curl -fsSL https://botook.ai/install | sh
set -e

REPO_URL="${BOTOOK_REPO_URL:-https://github.com/botook-ai/botook-channel}"
INSTALL_DIR="${BOTOOK_CHANNEL_DIR:-$HOME/.local/share/botook-channel}"
BOTOOK_URL="${BOTOOK_URL:-https://botook.ai}"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
dim()  { printf "\033[2m%s\033[0m\n" "$*"; }
fail() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

bold "→ botook installer"
echo

# ── 1. Check deps ──
need() {
  command -v "$1" >/dev/null 2>&1 \
    || fail "missing dependency: $1. Please install it first ($2)."
}
need git    "https://git-scm.com"
need bun    "https://bun.sh"
need claude "https://docs.claude.com/en/docs/claude-code/installation"
need curl   ""

# ── 2. Fetch / update the channel ──
if [ -d "$INSTALL_DIR/.git" ]; then
  dim "→ updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only --quiet
elif [ -f "$INSTALL_DIR/server.ts" ] && [ -f "$INSTALL_DIR/package.json" ]; then
  # Already populated (local dev or non-git copy) — skip clone, keep it.
  dim "→ using existing channel at $INSTALL_DIR (not a git checkout, skipping update)"
else
  dim "→ cloning $REPO_URL → $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth=1 --quiet "$REPO_URL" "$INSTALL_DIR"
fi

dim "→ installing dependencies"
( cd "$INSTALL_DIR" && bun install --silent >/dev/null )

# ── 3. OAuth device flow (or reuse existing token) ──
ENV_DIR="$HOME/.claude/channels/botook"
ENV_FILE="$ENV_DIR/.env"
mkdir -p "$ENV_DIR"

if [ -f "$ENV_FILE" ] && grep -q '^BOTOOK_TOKEN=' "$ENV_FILE"; then
  dim "→ existing token detected at $ENV_FILE — keeping it"
else
  echo
  bold "→ Authorize this machine"

  # Single-shot bun script handles authorize → open browser → poll.
  # On success it writes to $ENV_FILE and exits 0. On failure exits non-zero.
  BOTOOK_URL="$BOTOOK_URL" ENV_FILE="$ENV_FILE" \
  bun -e '
    const baseUrl = process.env.BOTOOK_URL.replace(/\/+$/, "");
    const envFile = process.env.ENV_FILE;
    const fs = await import("node:fs/promises");
    const { spawn } = await import("node:child_process");
    const os = await import("node:os");

    const auth = await fetch(`${baseUrl}/api/device/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_label: `botook-channel installer on ${os.hostname()}` }),
    });
    if (!auth.ok) {
      console.error(`authorize failed: HTTP ${auth.status}`);
      process.exit(1);
    }
    const a = await auth.json();
    process.stdout.write(`\n  Your code: \x1b[1m\x1b[32m${a.user_code}\x1b[0m\n`);
    process.stdout.write(`  Opening:   ${a.verification_uri_complete}\n\n`);

    // Try to open the browser (mac/linux/win); ignore failure — user can copy URL.
    const opener =
      process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", a.verification_uri_complete] : [a.verification_uri_complete];
    try { spawn(opener, args, { stdio: "ignore", detached: true }).unref(); } catch {}

    process.stdout.write(`  Waiting for you to approve in the browser… `);
    const interval = (a.interval ?? 3) * 1000;
    const deadline = Date.now() + a.expires_in * 1000;
    let token = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, interval));
      const t = await fetch(`${baseUrl}/api/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: a.device_code }),
      });
      const body = await t.json();
      if (t.ok && body.access_token) {
        token = body;
        break;
      }
      if (body.error === "slow_down" || body.error === "authorization_pending") {
        process.stdout.write(".");
        continue;
      }
      console.error(`\n  authorization ${body.error ?? "failed"}.`);
      process.exit(2);
    }
    if (!token) {
      console.error("\n  timed out waiting for approval.");
      process.exit(3);
    }
    process.stdout.write(`\n  ✓ authorized as @${token.alias} (${token.email})\n`);

    // Preserve other env keys; replace BOTOOK_TOKEN.
    let existing = "";
    try { existing = await fs.readFile(envFile, "utf8"); } catch {}
    const lines = existing.split(/\r?\n/).filter(l => l && !/^BOTOOK_TOKEN=/.test(l));
    lines.push(`BOTOOK_TOKEN=${token.access_token}`);
    await fs.writeFile(envFile, lines.join("\n") + "\n", { mode: 0o600 });
  '
fi

# ── 4. Final command ──
echo
echo "──────────────────────────────────────────────────────────────────"
bold "✓ botook installed"
echo "──────────────────────────────────────────────────────────────────"
echo
echo "Start Claude Code with the botook channel active:"
echo
printf "  \033[1mclaude --plugin-dir \"%s\" \\\\\n    --dangerously-load-development-channels server:botook\033[0m\n" "$INSTALL_DIR"
echo
echo "Tip: add an alias to ~/.zshrc so plain 'claude' always loads botook:"
echo "  alias claude='claude --plugin-dir \"$INSTALL_DIR\" --dangerously-load-development-channels server:botook'"
echo
echo "Once a session is running:"
echo "  /botook:whoami     check connectivity"
echo "  /botook:status     list open tasks"
