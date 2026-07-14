// Message-event reminder tests. Run with `bun test`.

import { test, expect, describe } from "bun:test";
import {
  summarize,
  buildChatNotification,
  escapeAppleScript,
  buildOsascriptArgs,
  notifyMacOS,
} from "../notify";

describe("summarize", () => {
  test("collapses whitespace and trims", () => {
    expect(summarize("  hello   \n world  ")).toBe("hello world");
  });
  test("clips long bodies with an ellipsis", () => {
    const s = summarize("x".repeat(200));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("buildChatNotification", () => {
  test("formats title as 「@sender 给你发来消息」", () => {
    const { title, message } = buildChatNotification("@wendy", "在吗?");
    expect(title).toBe("@wendy 给你发来消息");
    expect(message).toBe("在吗?");
  });
  test("empty body shows a placeholder", () => {
    expect(buildChatNotification("wendy", "   ").message).toBe("(空消息)");
  });
});

describe("osascript escaping (no breakout via message text)", () => {
  test("escapes quotes and backslashes", () => {
    expect(escapeAppleScript('say "hi" \\ bye')).toBe('say \\"hi\\" \\\\ bye');
  });
  test("a malicious body stays inside the AppleScript string literal", () => {
    const args = buildOsascriptArgs("t", '" & (do shell script "rm -rf ~") & "');
    expect(args[0]).toBe("-e");
    // The injected close-quote is escaped, so it cannot terminate
    // the literal and start executable AppleScript.
    expect(args[1]).toContain('\\"');
    expect(args[1]!.startsWith("display notification")).toBe(true);
  });
});

describe("notifyMacOS", () => {
  test("invokes the runner with osascript + argv", () => {
    let seen: { cmd: string; args: string[] } | null = null;
    notifyMacOS("title", "msg", (cmd, args) => {
      seen = { cmd, args };
    });
    expect(seen!.cmd).toBe("osascript");
    expect(seen!.args[0]).toBe("-e");
  });
  test("a throwing runner never propagates (best-effort)", () => {
    expect(() =>
      notifyMacOS("t", "m", () => {
        throw new Error("spawn failed");
      })
    ).not.toThrow();
  });
});
