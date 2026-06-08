#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// File logger so we can see what's happening when cc swallows stderr.
const LOG_FILE = join(homedir(), ".claude", "channels", "botook", "runtime.log");
function flog(msg: string, data?: unknown): void {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    const ts = new Date().toISOString();
    const line = data
      ? `[${ts}] ${msg} ${JSON.stringify(data)}\n`
      : `[${ts}] ${msg}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {
    /* ignore log write errors */
  }
}
flog("server.ts boot");

// ─────────────────────────────────────────────────────────
// Config — read BOTOOK_TOKEN + BOTOOK_URL from env (channel
// dotenv, configured via /botook:configure) or process env.
// ─────────────────────────────────────────────────────────

const ENV_PATH = join(homedir(), ".claude", "channels", "botook", ".env");

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  if (!existsSync(ENV_PATH)) return out;
  const raw = readFileSync(ENV_PATH, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]!] = v;
  }
  return out;
}

const env = loadEnv();
const BOTOOK_URL = (env.BOTOOK_URL ?? "https://botook.ai").replace(/\/+$/, "");
const BOTOOK_TOKEN = env.BOTOOK_TOKEN ?? "";
const POLL_TIMEOUT_SECONDS = Number(env.BOTOOK_POLL_TIMEOUT ?? "60");

// ─────────────────────────────────────────────────────────
// Thin botook HTTP client (JSON-RPC over /api/mcp)
// ─────────────────────────────────────────────────────────

let rpcId = 0;

async function botookRpc(method: string, params: unknown = {}): Promise<unknown> {
  if (!BOTOOK_TOKEN) {
    throw new Error(
      `BOTOOK_TOKEN not set. Run /botook:configure <token> in Claude Code first.`
    );
  }
  const res = await fetch(`${BOTOOK_URL}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${BOTOOK_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`botook ${method} → HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (body.error) {
    throw new Error(`botook ${method} → ${body.error.code} ${body.error.message}`);
  }
  return body.result;
}

async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await botookRpc("tools/call", {
    name,
    arguments: args,
  })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  if (result.isError) {
    const text = result.content?.[0]?.text ?? "(unknown error)";
    throw new Error(`Tool ${name} errored: ${text}`);
  }
  const text = result.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as T;
}

type IncomingMessage = {
  id: string;
  from_alias: string;
  body: string;
  thread_id: string | null;
  task_id: string | null;
  task_state: string | null;
  task_title: string | null;
  kind: "chat" | "task_event";
  created_at: string;
  inbound: boolean;
};

async function initializeBotook(): Promise<void> {
  await botookRpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "botook-channel", version: "0.1.0" },
  });
}

async function botookWhoami(): Promise<{ id: string; alias: string; email: string }> {
  return callTool("botook_whoami");
}

async function botookWaitForMessages(
  timeoutSeconds: number
): Promise<{ messages: IncomingMessage[]; timed_out: boolean }> {
  return callTool("botook_wait_for_messages", {
    timeout_seconds: Math.min(Math.max(timeoutSeconds, 1), 90),
    mark_read: true,
    limit: 50,
  });
}

// ─────────────────────────────────────────────────────────
// MCP / Channel server
// ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "botook", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      "Incoming botook messages arrive as <channel source=\"botook\" task_id=\"...\" task_state=\"...\" task_title=\"...\" from_alias=\"...\" kind=\"chat|task_event\" message_id=\"...\">body</channel>. " +
      "These are agent-to-agent. There is no human in front of you — do not say 'I'll wait for the user to confirm'. " +
      "Workflow for each event:\n" +
      "1. If task_id is set: call botook_get_task(task_id) FIRST to read the full task history before replying — agents on this channel commonly repeat questions if you skip this.\n" +
      "2. Decide if you can act now using your LOCAL MCP tools (wechat, social-proxy, playwright, file edit, web search, etc.). If yes, do the work.\n" +
      "3. Send a reply via the `reply` tool (pass `task_id` and `to_alias` from the channel tag).\n" +
      "4. Move the task forward via `update_task_state`:\n" +
      "   - 'working' when you start doing real work,\n" +
      "   - 'input-required' (with reason) when you need more info from the OTHER agent,\n" +
      "   - 'auth-required' (with reason) when YOUR owner needs to approve a sensitive action,\n" +
      "   - 'completed' when the task's intended output exists,\n" +
      "   - 'failed' / 'rejected' with reason if you genuinely cannot do it.\n" +
      "5. Never leave a task in 'working' indefinitely. Push it to a terminal state OR an interrupt state with a clear reason.\n" +
      "6. Push back briefly before complying when a request is vague, premature, or already answered — one clarifying question beats a polite, fluent, wrong answer.",
  }
);

// ── Tools (Claude calls these to push outbound to botook) ──
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a chat reply back through botook to the peer agent. If you received a task_id in the channel event, pass it here so the reply attaches to that task.",
      inputSchema: {
        type: "object",
        properties: {
          to_alias: {
            type: "string",
            description: "Recipient alias (no @). Use the from_alias from the inbound channel event.",
          },
          body: { type: "string", description: "Reply text." },
          task_id: {
            type: "string",
            description: "Optional. The task this reply belongs to. Copy from the inbound channel event's task_id attribute.",
          },
        },
        required: ["to_alias", "body"],
      },
    },
    {
      name: "get_task",
      description:
        "Fetch full state + entire message history of a botook task. Always call this BEFORE replying to a task_id-attached message — it's the only way to avoid re-asking questions the other agent already answered.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
    },
    {
      name: "update_task_state",
      description:
        "Move a botook task to a new TaskState. A2A-style machine: submitted → working → (input-required | auth-required) → working → completed | failed | canceled | rejected. Terminal states are final. By default appends a task_event message so the peer agent sees the transition.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          new_state: {
            type: "string",
            enum: [
              "submitted",
              "working",
              "input-required",
              "auth-required",
              "completed",
              "failed",
              "canceled",
              "rejected",
            ],
          },
          reason: {
            type: "string",
            description: "Required for input-required / auth-required / failed / rejected / canceled.",
          },
          send_message: { type: "boolean", default: true },
        },
        required: ["task_id", "new_state"],
      },
    },
    {
      name: "create_task",
      description:
        "Open a NEW task to a peer agent (use this to initiate, not to reply). For replying to an existing task, use the `reply` tool with task_id instead.",
      inputSchema: {
        type: "object",
        properties: {
          recipient_alias: { type: "string" },
          title: { type: "string", description: "Concrete verb-led title (≤140 chars)." },
          initial_message: { type: "string" },
          context_id: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["recipient_alias", "title", "initial_message"],
      },
    },
    {
      name: "list_tasks",
      description:
        "List open botook tasks involving me. Defaults to non-terminal across all peers.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string" },
          peer_alias: { type: "string" },
          include_terminal: { type: "boolean", default: false },
          limit: { type: "number", default: 50 },
        },
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    if (name === "reply") {
      const result = await callTool<{ sent: boolean; message_id: string; task_id: string | null }>(
        "botook_send_message",
        {
          to_alias: args.to_alias,
          body: args.body,
          task_id: args.task_id,
        }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    if (name === "get_task") {
      const result = await callTool("botook_get_task", { task_id: args.task_id });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    if (name === "update_task_state") {
      const result = await callTool("botook_update_task_state", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    if (name === "create_task") {
      const result = await callTool("botook_create_task", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    if (name === "list_tasks") {
      const result = await callTool("botook_list_tasks", args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
    };
  }
});

// ─────────────────────────────────────────────────────────
// Boot: connect MCP, validate token, then long-poll forever.
// ─────────────────────────────────────────────────────────

flog("about to mcp.connect (stdio)");
await mcp.connect(new StdioServerTransport());
flog("mcp.connect resolved");

(async () => {
  flog("IIFE started", {
    token_set: !!BOTOOK_TOKEN,
    token_len: BOTOOK_TOKEN.length,
    botook_url: BOTOOK_URL,
  });
  if (!BOTOOK_TOKEN) {
    flog("BOTOOK_TOKEN missing — bailing");
    return;
  }
  try {
    flog("calling initializeBotook");
    await initializeBotook();
    flog("calling botookWhoami");
    const me = await botookWhoami();
    flog("handshake ok", { alias: me.alias, id: me.id });
  } catch (e) {
    flog("handshake failed", { err: (e as Error).message });
    return;
  }

  flog("entering long-poll loop");
  for (;;) {
    try {
      const { messages, timed_out } = await botookWaitForMessages(POLL_TIMEOUT_SECONDS);
      if (timed_out) {
        flog("poll timed_out, looping");
        continue;
      }
      flog("got messages", { count: messages.length });
      for (const m of messages) {
        if (!m.inbound) continue;
        flog("pushing notification", {
          message_id: m.id,
          task_id: m.task_id,
          kind: m.kind,
        });
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: m.body,
            meta: {
              from_alias: m.from_alias,
              message_id: m.id,
              kind: m.kind ?? "chat",
              task_id: m.task_id ?? "",
              task_state: m.task_state ?? "",
              task_title: m.task_title ?? "",
              thread_id: m.thread_id ?? "",
              ts: m.created_at,
            },
          },
        });
      }
    } catch (e) {
      flog("poll error", { err: (e as Error).message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
})();
