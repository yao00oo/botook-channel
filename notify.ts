// ─────────────────────────────────────────────────────────
// macOS message-event reminder. See "botook 核心功能设计" §3.4:
// when a chat-kind event arrives, the resident session proactively
// nudges its owner with a native notification —
//   「@<sender> 给你发来消息:<摘要>」
//
// osascript is invoked with argv (no shell), so message text can't
// break out into shell metacharacters. It can still break the
// AppleScript string literal, so we escape quotes/backslashes.
// ─────────────────────────────────────────────────────────

const SUMMARY_MAX = 80;

/** Collapse whitespace and clip a message body to a short summary. */
export function summarize(body: string, max: number = SUMMARY_MAX): string {
  const flat = (body ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

/** Build the notification title + message for a chat event. */
export function buildChatNotification(
  fromAlias: string,
  body: string
): { title: string; message: string } {
  const alias = fromAlias.replace(/^@/, "").trim();
  return {
    title: `@${alias} 给你发来消息`,
    message: summarize(body) || "(空消息)",
  };
}

/** Escape a string for embedding inside an AppleScript "…" literal. */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The argv passed to `osascript` for a notification. */
export function buildOsascriptArgs(title: string, message: string): string[] {
  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
  return ["-e", script];
}

// Runner is injected so tests can assert on the argv without
// actually spawning osascript.
export type NotifyRunner = (cmd: string, args: string[]) => void;

const defaultRunner: NotifyRunner = (cmd, args) => {
  // Fire-and-forget; a failed notification must never crash the loop.
  Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
};

/** Pop a macOS notification. No-op-safe: swallows any failure. */
export function notifyMacOS(
  title: string,
  message: string,
  runner: NotifyRunner = defaultRunner
): void {
  try {
    runner("osascript", buildOsascriptArgs(title, message));
  } catch {
    /* notifications are best-effort */
  }
}

/** Convenience: notify for an inbound chat event in one call. */
export function notifyChat(
  fromAlias: string,
  body: string,
  runner: NotifyRunner = defaultRunner
): void {
  const { title, message } = buildChatNotification(fromAlias, body);
  notifyMacOS(title, message, runner);
}
