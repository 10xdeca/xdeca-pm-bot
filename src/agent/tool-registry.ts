import { tool, jsonSchema } from "ai";
import type { ToolSet } from "ai";
import type { Api } from "grammy";
import { mcpManager, type McpTool } from "./mcp-manager.js";

/**
 * A snapshot of system health observed before/after a tool runs.
 * Tools that mutate state can supply a `verify` callback returning one of these,
 * and the registry will detect regressions (pre healthy → post unhealthy).
 */
export interface HealthSnapshot {
  /** Was the relevant subsystem healthy at the moment of observation? */
  healthy: boolean;
  /** Optional structured detail (e.g. underlying status object) for logs. */
  details?: unknown;
}

/** Outcome of a verify pre/post comparison, attached to the tool result. */
export interface VerifyOutcome {
  pre: HealthSnapshot;
  post: HealthSnapshot;
  /** True when pre was healthy and post is not — i.e. the action regressed health. */
  regressed: boolean;
}

/** A custom (non-MCP) tool definition. */
export interface CustomToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
  /**
   * Optional safety wrapper. When present, the registry runs `verify(args)` immediately
   * before and after `handler(args)`, passing the same args the handler received so
   * verify can target the specific subject of the call (e.g. which MCP server). If
   * pre was healthy and post is not, the regression is logged and surfaced in the
   * tool's returned string. Rollback is not attempted here — that's a per-tool concern.
   *
   * Read-only tools should leave this undefined. Tools that intentionally tear down
   * the observer (e.g. self-restart) should also leave it undefined and document why.
   */
  verify?: (args: Record<string, unknown>) => Promise<HealthSnapshot>;
}

const customTools = new Map<string, CustomToolDef>();

/** Register a custom tool (called at startup from src/tools/*.ts). */
export function registerCustomTool(tool: CustomToolDef): void {
  customTools.set(tool.name, tool);
}

/** Test-only: clear the registry. Not exported via index — use sparingly. */
export function _clearCustomTools(): void {
  customTools.clear();
}

/** Test-only: read a registered tool. */
export function _getCustomTool(name: string): CustomToolDef | undefined {
  return customTools.get(name);
}

/**
 * Run a tool's handler wrapped in pre/post verify checks.
 * Exported so server-ops (and future tools) can be unit-tested without the AI SDK.
 *
 * Behaviour matrix:
 *   pre healthy  → post healthy   → success, no annotation
 *   pre healthy  → post unhealthy → REGRESSION: log + append warning to result
 *   pre unhealthy → post unhealthy → no false alarm (tool didn't cause it)
 *   pre unhealthy → post healthy → improvement, no flag
 *   verify throws → snapshot recorded as { healthy: false, details: error }
 */
export async function runWithVerify(
  toolName: string,
  args: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<string>,
  verify?: (args: Record<string, unknown>) => Promise<HealthSnapshot>,
): Promise<{ result: string; verify?: VerifyOutcome }> {
  if (!verify) {
    return { result: await handler(args) };
  }

  const pre = await safeVerify(verify, args);
  const result = await handler(args);
  const post = await safeVerify(verify, args);

  const regressed = pre.healthy && !post.healthy;
  const outcome: VerifyOutcome = { pre, post, regressed };

  if (regressed) {
    console.error(
      `[verify] ${toolName} regressed health: pre=${JSON.stringify(pre)} post=${JSON.stringify(post)}`,
    );
    const annotated =
      result +
      `\n\n[verify] WARNING: ${toolName} appears to have regressed system health. ` +
      `Pre: healthy. Post: unhealthy (${describe(post.details)}). ` +
      `Manual inspection recommended.`;
    return { result: annotated, verify: outcome };
  }

  return { result, verify: outcome };
}

async function safeVerify(
  verify: (args: Record<string, unknown>) => Promise<HealthSnapshot>,
  args: Record<string, unknown>,
): Promise<HealthSnapshot> {
  try {
    return await verify(args);
  } catch (err) {
    return {
      healthy: false,
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

function describe(details: unknown): string {
  if (details === undefined || details === null) return "no details";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

/** Fire-and-forget typing indicator. */
function sendTyping(api: Api, chatId: number): void {
  api.sendChatAction(chatId, "typing").catch(() => {
    // Typing indicator failures are not critical
  });
}

/**
 * Build the tools record for generateText().
 * Each tool has its execute function baked in — the SDK calls it automatically.
 * Typing indicators fire at the start of each tool execution.
 */
export function getTools(chatId: number, api: Api): ToolSet {
  const tools: ToolSet = {};

  // MCP tools — route execution through mcpManager
  for (const mcpTool of mcpManager.getAllTools()) {
    const name = mcpTool.name;
    tools[name] = tool({
      description: mcpTool.description,
      inputSchema: jsonSchema(mcpTool.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args: Record<string, unknown>) => {
        sendTyping(api, chatId);
        console.log(`Tool call: ${name}(${JSON.stringify(args)})`);
        return mcpManager.callTool(name, args);
      },
    });
  }

  // Custom tools — use their handler directly, with optional verify wrapper
  for (const custom of customTools.values()) {
    const name = custom.name;
    const handler = custom.handler;
    const verify = custom.verify;
    tools[name] = tool({
      description: custom.description,
      inputSchema: jsonSchema(custom.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args: Record<string, unknown>) => {
        sendTyping(api, chatId);
        console.log(`Tool call: ${name}(${JSON.stringify(args)})`);
        const { result } = await runWithVerify(name, args, handler, verify);
        return result;
      },
    });
  }

  return tools;
}
