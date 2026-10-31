// What attach needs of an MCP server, for each MCP TypeScript SDK it takes:
// @modelcontextprotocol/sdk 1.x and @modelcontextprotocol/server 2.x. The
// rest of the SDK (events.ts, toolcall.ts, tasks.ts, discover.ts) is
// written once against Host, and neither MCP SDK is imported here: hostOf
// tells them apart by the server object it's given.
//
// Where the two differ:
//   - a request's context: 1.x's `extra` (_meta, requestInfo.headers,
//     authInfo, signal), 2.x's `ctx` (mcpReq._meta without the reserved
//     io.modelcontextprotocol/* keys, which it lifts into mcpReq.envelope;
//     http.req's Headers; http.authInfo; mcpReq.signal). req() reads either
//     into one shape, putting the envelope's keys back into _meta, so
//     Wakeshift gets the same call from both (test/mcp-tasks-wire.json);
//   - custom methods (events/*): a zod request schema on 1.x, a method name
//     and a params schema on 2.x;
//   - tasks/get and tasks/cancel: 2.x answers them on protocol 2026-07-28
//     only for a handler registered with a params schema (the tasks
//     extension's methods), so setTaskMethod registers them that way;
//   - protocol 2026-07-28: 1.x doesn't speak it, so discover.ts teaches it;
//     2.x speaks it itself (server/discover, resultType, ttlMs and
//     cacheScope).
//
// Both keep their request handlers in a private Map (_requestHandlers),
// which tools/list, tools/call, server/discover and tasks/* are wrapped
// through (neither has public middleware for a method it answers itself),
// and their tools in _registeredTools, which wrapped tools are checked
// against. Unit tests pin both against each SDK the CI installs.

import { z } from "zod";
import * as z4 from "zod/v4";
import type { AuthInfo, CallToolResult, McpServerLike } from "./mcp.js";
import { normalizeObjectSchema, safeParseAsync, type AnySchema, type ZodRawShapeCompat } from "./zod.js";

/** @internal A request handler as both SDKs keep them: the request, and the SDK's own context. */
export type Handler = (request: any, raw: any) => Promise<any>;

/** @internal One request's context, read the same way from either SDK. */
export interface Req {
  /** The request's _meta, with 2.x's lifted envelope keys put back. */
  meta: Record<string, unknown> | undefined;
  /** An HTTP header of the request ("" if none, or not over HTTP). */
  header(name: string): string;
  authInfo: AuthInfo | undefined;
  signal: AbortSignal | undefined;
}

/** @internal A registered tool as the wrapper reads it. */
export interface RegisteredToolInternal {
  inputSchema?: unknown;
  outputSchema?: unknown;
  handler?: unknown;
  callback?: unknown;
}

/** @internal One of attach's own tools' registration. */
export interface ToolRegistration {
  description: string;
  /** A zod shape, in the API host.zod gives. */
  inputSchema: ZodRawShapeCompat;
  annotations?: Record<string, unknown>;
}

/** @internal The zod API attach's own tool schemas are written in. */
export type ZodApi = { string(): any; record(k: any, v: any): any; any(): any; enum(values: readonly [string, ...string[]]): any };

/** @internal What attach needs of an MCP server. */
export interface Host {
  /** The MCP SDK's major version: 1 (@modelcontextprotocol/sdk) or 2 (@modelcontextprotocol/server). */
  readonly version: 1 | 2;
  readonly server: McpServerLike;
  /** The zod attach's own tools are written with: zod 4 for 2.x, which takes only zod 4. */
  readonly zod: ZodApi;
  /** A request's context, from the SDK's own (extra or ctx), or one already read. */
  req(raw: unknown): Req;
  registerCapabilities(capabilities: Record<string, unknown>): void;
  registerTool(name: string, config: ToolRegistration, cb: (args: Record<string, unknown>, raw: unknown) => Promise<CallToolResult>): { enable(): void; disable(): void };
  /** A JSON-RPC method of Wakeshift's own (events/*): its handler gets the request's params. */
  setMethod(method: string, handler: (params: Record<string, any>, raw: unknown) => Promise<unknown>): void;
  /** Makes the SDK route tasks/get or tasks/cancel on every protocol revision; the caller then sets its handler in handlers(). */
  setTaskMethod(method: string): void;
  /** The SDK's request handlers, or null if this SDK keeps them where Wakeshift can't wrap them. */
  handlers(): Map<string, Handler> | null;
  /** The client's name from initialize (or, on 2.x, the request's envelope). */
  clientName(): string | undefined;
  /** The client's capabilities from initialize (or, on 2.x, the request's envelope). */
  clientCapabilities(): Record<string, unknown> | undefined;
  /** Runs fn after a client's initialized notification, after any earlier hook. */
  onInitialized(fn: () => void): void;
  /** A registered tool (undefined: none by that name; null: the SDK keeps them where Wakeshift can't read them). */
  registeredTool(name: string): RegisteredToolInternal | undefined | null;
  /** Whether a tools/call result passes the tool's output schema, as the SDK checks it after the callback returns. */
  validOutput(outputSchema: unknown, result: CallToolResult | string): Promise<boolean>;
}

const VERSION_META = "io.modelcontextprotocol/protocolVersion";

function lowOf(server: McpServerLike): any {
  return (server as { server?: unknown }).server;
}

/**
 * @internal The Host for an McpServer from either SDK. 2.x's low-level
 * Server has projectCallToolResult, which 1.x's lacks.
 */
export function hostOf(server: unknown): Host {
  const low = (server as { server?: any } | null)?.server;
  if (!low || typeof low.setRequestHandler !== "function" || typeof (server as { registerTool?: unknown }).registerTool !== "function") {
    throw new Error(
      "wakeshift: attach takes an McpServer, from @modelcontextprotocol/server 2.x or @modelcontextprotocol/sdk 1.x (@modelcontextprotocol/sdk/server/mcp.js)",
    );
  }
  return typeof low.projectCallToolResult === "function" ? new V2Host(server as McpServerLike) : new V1Host(server as McpServerLike);
}

// headerOf reads a header from a plain record (1.x's requestInfo.headers).
function headerOf(headers: Record<string, string | string[] | undefined> | undefined, name: string): string {
  if (!headers) return "";
  const v = headers[name] ?? headers[name.toLowerCase()];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** @internal A context already read (req's output). */
function isReq(raw: unknown): raw is Req {
  return !!raw && typeof (raw as Req).header === "function" && "meta" in (raw as object);
}

/**
 * @internal A request's context read the 1.x way: extra's _meta,
 * requestInfo.headers, authInfo and signal. Also what a plain
 * `{ _meta, requestInfo }` (ToolExtra) reads as.
 */
export function v1Req(raw: unknown): Req {
  if (isReq(raw)) return raw;
  const e = (raw ?? {}) as { _meta?: Record<string, unknown>; requestInfo?: { headers?: Record<string, string | string[] | undefined> }; authInfo?: AuthInfo; signal?: AbortSignal };
  return { meta: e._meta, header: (name) => headerOf(e.requestInfo?.headers, name), authInfo: e.authInfo, signal: e.signal };
}

/** @internal A request's context read the 2.x way (ctx), putting the envelope's keys back into _meta. */
export function v2Req(raw: unknown): Req {
  if (isReq(raw)) return raw;
  const c = (raw ?? {}) as {
    mcpReq?: { _meta?: Record<string, unknown>; envelope?: Record<string, unknown>; signal?: AbortSignal };
    http?: { authInfo?: AuthInfo; req?: { headers?: { get(name: string): string | null } } };
    // A 1.x-shaped context (a test's, or one passed through by hand) reads too.
    _meta?: Record<string, unknown>;
    requestInfo?: { headers?: Record<string, string | string[] | undefined> };
  };
  if (!c.mcpReq) return v1Req(raw);
  const own = c.mcpReq._meta;
  const env = c.mcpReq.envelope;
  const meta = env && Object.keys(env).length > 0 ? { ...env, ...own } : own;
  const headers = c.http?.req?.headers;
  return {
    meta,
    header: (name) => (headers && typeof headers.get === "function" ? (headers.get(name) ?? "") : ""),
    authInfo: c.http?.authInfo,
    signal: c.mcpReq.signal,
  };
}

abstract class BaseHost {
  constructor(readonly server: McpServerLike) {}
  protected get low(): any {
    return lowOf(this.server);
  }
  registerCapabilities(capabilities: Record<string, unknown>): void {
    this.low.registerCapabilities(capabilities);
  }
  handlers(): Map<string, Handler> | null {
    const h = this.low._requestHandlers;
    return h instanceof Map ? (h as Map<string, Handler>) : null;
  }
  clientName(): string | undefined {
    return this.low.getClientVersion?.()?.name || undefined;
  }
  clientCapabilities(): Record<string, unknown> | undefined {
    return this.low.getClientCapabilities?.() as Record<string, unknown> | undefined;
  }
  onInitialized(fn: () => void): void {
    const low = this.low;
    const prev = low.oninitialized as (() => void) | undefined;
    low.oninitialized = () => {
      fn();
      prev?.();
    };
  }
  registeredTool(name: string): RegisteredToolInternal | undefined | null {
    const tools = (this.server as unknown as { _registeredTools?: Record<string, RegisteredToolInternal> })._registeredTools;
    if (!tools || typeof tools !== "object") return null;
    return Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined;
  }
}

class V1Host extends BaseHost implements Host {
  readonly version = 1 as const;
  readonly zod: ZodApi = z as unknown as ZodApi;
  req(raw: unknown): Req {
    return v1Req(raw);
  }
  registerTool(name: string, config: ToolRegistration, cb: (args: Record<string, unknown>, raw: unknown) => Promise<CallToolResult>) {
    return (this.server as any).registerTool(name, config, cb);
  }
  setMethod(method: string, handler: (params: Record<string, any>, raw: unknown) => Promise<unknown>): void {
    const schema = z.object({ method: z.literal(method), params: z.any().optional() });
    this.low.setRequestHandler(schema, (request: { params?: Record<string, any> }, extra: unknown) => handler(request.params ?? {}, extra));
  }
  setTaskMethod(_method: string): void {
    // Nothing to register: 1.x routes whatever is in its handler map. (Its
    // setRequestHandler would ask for its own tasks capability, an older
    // revision's, never advertised.)
  }
  async validOutput(outputSchema: unknown, result: CallToolResult | string): Promise<boolean> {
    // McpServer 1.x's validateToolOutput: an object schema, and structured content that parses.
    if (!outputSchema) return true;
    if (typeof result === "string" || !result.structuredContent) return false;
    const obj = normalizeObjectSchema(outputSchema);
    if (!obj) return true;
    return (await safeParseAsync(obj as AnySchema, result.structuredContent)).success;
  }
}

class V2Host extends BaseHost implements Host {
  readonly version = 2 as const;
  readonly zod: ZodApi = z4 as unknown as ZodApi;
  req(raw: unknown): Req {
    return v2Req(raw);
  }
  registerTool(name: string, config: ToolRegistration, cb: (args: Record<string, unknown>, raw: unknown) => Promise<CallToolResult>) {
    // 2.x takes an object schema (a bare shape is deprecated there).
    return (this.server as any).registerTool(name, { ...config, inputSchema: objectFromV4Shape(config.inputSchema) }, cb);
  }
  setMethod(method: string, handler: (params: Record<string, any>, raw: unknown) => Promise<unknown>): void {
    this.low.setRequestHandler(method, { params: z4.looseObject({}) }, (params: Record<string, any>, ctx: unknown) => handler(params ?? {}, ctx));
  }
  setTaskMethod(method: string): void {
    // Registered with a params schema, so 2.x serves it on protocol
    // 2026-07-28 too, as the tasks extension's method (SEP-2663). The
    // caller replaces the handler that leaves in the map.
    this.low.setRequestHandler(method, { params: z4.looseObject({}) }, async () => {
      throw Object.assign(new Error("Method not found"), { code: -32601 });
    });
  }
  async validOutput(outputSchema: unknown, result: CallToolResult | string): Promise<boolean> {
    // McpServer 2.x's validateToolOutput: structured content (any JSON
    // value) that the output schema (a Standard Schema) accepts.
    if (!outputSchema) return true;
    if (typeof result === "string" || result.structuredContent === undefined) return false;
    const std = (outputSchema as { "~standard"?: { validate(v: unknown): unknown } })["~standard"];
    if (!std || typeof std.validate !== "function") return true;
    const out = (await std.validate(result.structuredContent)) as { issues?: unknown };
    return !out.issues;
  }
}

// objectFromV4Shape is a zod 4 object of attach's own tool shapes (written
// with zod/v4: host.zod).
function objectFromV4Shape(shape: ZodRawShapeCompat): unknown {
  const values = Object.values(shape);
  if (values.length === 0) return z4.object({});
  return z4.object(shape as Record<string, z4.ZodType>);
}

/** The protocol revision that has server/discover, MCP Events and the tasks extension. */
export const STATELESS_VERSION = "2026-07-28";

/** @internal Whether a request is protocol 2026-07-28: its _meta names it, or its MCP-Protocol-Version header does. */
export function is2026(req: Req): boolean {
  if (req.meta?.[VERSION_META] === STATELESS_VERSION) return true;
  return req.header("mcp-protocol-version") === STATELESS_VERSION;
}
