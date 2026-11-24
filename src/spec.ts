// The SEP-3415 (MCP Events) constants the SDK uses, in one place, matching
// Wakeshift's own (internal/mcpevents/event/spec.go, which a test checks
// these against): the accepted text may still be reworded before it
// merges, and its error codes are provisional.

import { CLIENT_TABLE } from "./clients.js";

interface ClientEntry {
  id: string;
  match: Record<string, readonly string[]>;
  without_push?: boolean;
  native: string;
  dialect: Dialect;
}

// The client table (clients.ts), typed for the evaluator below and codesFor.
const TABLE = CLIENT_TABLE as unknown as { dialects: Record<string, unknown>; entries: readonly ClientEntry[] };

/** The text these follow: SEP-3415 as merged, Final, on 2026-11-19 (8a18b4b). Where clients differ from it, Wakeshift follows each client (webhook-id per client, in the core; a missing Mcp-Name accepted, a mismatched one refused). */
export const REVISION = "SEP-3415 (2026-11-19, 8a18b4b)";

/** The delivery modes Wakeshift offers for every open event type (events/list's delivery): a webhook, or polls; PUSH is added, last, where push is served. */
export const DELIVERY: readonly string[] = ["webhook", "poll"];

/** The delivery mode events/list adds, last, where push (events/stream) is served: the core reports it, the transport can stream, and attach's push isn't false. */
export const PUSH = "push";

/** The _meta key on every notification of an events/stream: the request's JSON-RPC ID, as the client sent it. */
export const SUBSCRIPTION_ID_META = "io.modelcontextprotocol/subscriptionId";

/** Capability keys: the draft's extension, and the top-level key ChatGPT reads. A server advertises both; only the extension is exported. */
export const EXTENSION_KEY = "io.modelcontextprotocol/events";
export const TOP_LEVEL_KEY = "events";

/** On every events/* result. */
export const RESULT_TYPE = "complete";

/** The _meta key of an occurrence's rendered line (Wakeshift adds it on delivery). */
export const TEXT_META = "ai.wakeshift/text";

/** The Streamable HTTP header events/subscribe, events/unsubscribe, events/poll and events/stream carry: params.name. */
export const NAME_HEADER = "mcp-name";

/** The events/* methods that carry NAME_HEADER. */
export const NAMED_METHODS: readonly string[] = ["events/subscribe", "events/unsubscribe", "events/poll", "events/stream"];

/** events/stream's answer (Unsupported, with value "push") where push isn't served. */
export const STREAM_REFUSAL = "push delivery isn't offered: use a webhook (events/subscribe) or poll (events/poll)";

/** A dialect the client table names (clients.ts): what a client speaks. */
export type Dialect = "spec" | "draft" | "openclaw" | "chatgpt";

export interface Codes {
  notFound: number;
  forbidden: number;
  resourceExhausted: number;
  unsupported: number;
  callbackEndpoint: number;
}

export const INVALID_PARAMS = -32602;
export const HEADER_MISMATCH = -32020;
export const INTERNAL_ERROR = -32603;

/** A dialect's error codes (its errors in the client table): the spec's (provisional) or ChatGPT's. */
export function codesFor(dialect: string): Codes {
  if ((TABLE.dialects as Record<string, { errors: string } | undefined>)[dialect]?.errors === "chatgpt") {
    return { notFound: -32011, forbidden: -32012, resourceExhausted: INVALID_PARAMS, unsupported: INVALID_PARAMS, callbackEndpoint: -32015 };
  }
  return { notFound: -32023, forbidden: -32024, resourceExhausted: -32025, unsupported: -32026, callbackEndpoint: -32027 };
}

/**
 * A client name as the client table compares it: spaces and tabs trimmed, ASCII letters lowercased, anything else left
 * as it is. ASCII only, so every SDK and the core normalize a name the same way (Unicode case folding and whitespace
 * differ between languages: Turkish İ, NEL, BOM). The core's harnesses.ClientName.
 */
function clientName_(name: string): string {
  return name.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Whether a call is from ChatGPT's desktop app, which can't subscribe with MCP Events, rather than a Work chat on the
 * web, which can. Both send the same client name ("openai-mcp (Codex)"), User-Agent and _meta keys, and neither declares
 * MCP Events; the desktop app's capabilities (_meta's io.modelcontextprotocol/clientCapabilities) declare both the UI
 * extension's "text/html+skybridge" mime type and the openai/form extension, the web's neither. Both are required:
 * anything else, missing or malformed capabilities included, is ChatGPT's. Observed, not a published contract. The
 * core's harnesses.ChatGPTDesktop; the same rule in every SDK.
 */
export function chatgptDesktop(clientName: string, meta: Record<string, unknown> | undefined): boolean {
  if (clientName_(clientName) !== "openai-mcp (codex)") return false;
  const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const ext = obj(obj(meta?.["io.modelcontextprotocol/clientCapabilities"])?.extensions);
  if (!ext || !("openai/form" in ext)) return false;
  const types = obj(ext["io.modelcontextprotocol/ui"])?.mimeTypes;
  return Array.isArray(types) && types.includes("text/html+skybridge");
}

/**
 * Whether a call is from a regular chat in ChatGPT's desktop app (not Codex mode): ChatGPT's classic client name,
 * "openai-mcp", with _meta openai/userAgent starting "Codex Desktop/". It can't subscribe with MCP Events and has no
 * shell. The web's chats don't send that _meta. Observed, not a published contract. The core's
 * harnesses.ChatGPTDesktopChat; the same rule in every SDK.
 */
export function chatgptDesktopChat(clientName: string, meta: Record<string, unknown> | undefined): boolean {
  if (clientName_(clientName) !== "openai-mcp") return false;
  const ua = meta?.["openai/userAgent"];
  return typeof ua === "string" && ua.startsWith("Codex Desktop/");
}

/** Whether a ChatGPT call can't subscribe with MCP Events: the desktop app, in Codex mode or a regular chat. */
export function chatgptNotNative(clientName: string, meta: Record<string, unknown> | undefined): boolean {
  return chatgptDesktop(clientName, meta) || chatgptDesktopChat(clientName, meta);
}

/** A client's dialect by the client table, from its clientInfo name, User-Agent and the request's _meta. */
export function dialectOf(clientName: string, userAgent: string, meta?: Record<string, unknown>): Dialect {
  return evaluateClient(clientName, userAgent, meta, undefined).dialect;
}

// Canonical, padded standard Base64 (RFC 4648 §4).
const BASE64_CANONICAL = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

/**
 * Decodes an Mcp-Name header: plain ASCII, or SEP-2243's sentinel (=?base64?…?=) holding canonical, padded standard
 * Base64 of UTF-8 (the 2026-07-28 transport spec's examples; the official SDKs refuse anything else). null: a sentinel
 * that doesn't decode so (unpadded, non-canonical, not Base64, not UTF-8). The same rule in every SDK
 * (test/mcp-events-interop.json).
 */
export function headerValue(h: string): string | null {
  if (h.length < SENTINEL_PREFIX.length + SENTINEL_SUFFIX.length || !h.startsWith(SENTINEL_PREFIX) || !h.endsWith(SENTINEL_SUFFIX)) return h;
  const b64 = h.slice(SENTINEL_PREFIX.length, -SENTINEL_SUFFIX.length);
  if (!BASE64_CANONICAL.test(b64)) return null;
  const b = Buffer.from(b64, "base64");
  // Canonical also means the unused bits are zero: re-encoding gives the same text.
  if (b.toString("base64") !== b64) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

/** The JSON Schema annotation that mirrors an argument into an Mcp-Param-{Name} header (SEP-3415, custom headers from subscription arguments). */
export const PARAM_ANNOTATION = "x-mcp-header";

/** The prefix of the headers PARAM_ANNOTATION names, in lowercase (header names are case-insensitive). */
export const PARAM_HEADER_PREFIX = "mcp-param-";

/** @internal An annotated argument: its path (a chain of properties keys), the header's name ({Name} in Mcp-Param-{Name}), and its type. */
export interface ParamHeader {
  path: string[];
  name: string;
  type: "string" | "integer" | "boolean";
}

// RFC 9110 §5.6.2 token (1*tchar): what a header's name may hold.
const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PARAM_TYPES = new Set(["string", "integer", "boolean"]);
// The keywords whose subschemas aren't statically reachable (the transport's
// Schema Extension): an annotation under any of them is invalid. A single
// subschema, a list of them, or a map of them.
const OFF_CHAIN = new Set(["items", "prefixItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "not", "if", "then", "else", "contentSchema", "anyOf", "oneOf", "allOf", "patternProperties", "dependentSchemas", "dependencies", "$defs", "definitions"]);
const SCHEMA_MAPS = new Set(["patternProperties", "dependentSchemas", "dependencies", "$defs", "definitions"]);

function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * @internal The x-mcp-header annotations in an event's arguments' schema, or why one is invalid (problem): the 2026-07-28
 * Streamable HTTP transport's constraints, which SEP-3415 takes for event types. Each is a non-empty RFC 9110 token, on
 * a property typed "string", "integer" or "boolean" (one type: never number), reached from the root through properties
 * keys only, and unique in any case. A spec client drops an event type that breaks one from events/list, so defineEvent
 * refuses it. The same rule in every SDK (test/mcp-events-interop.json mcp_param_schema).
 */
export function paramHeadersOf(schema: unknown): { headers: ParamHeader[]; problem?: undefined } | { problem: string; headers?: undefined } {
  const headers: ParamHeader[] = [];
  const seen = new Map<string, string>();
  // An explicit stack, so any finite schema is walked; reachable: every step from the root was a properties key.
  const stack: { node: unknown; path: string[]; reachable: boolean }[] = [{ node: schema, path: [], reachable: true }];
  while (stack.length > 0) {
    const { node, path, reachable } = stack.pop()!;
    if (!plainObject(node)) continue;
    if (Object.prototype.hasOwnProperty.call(node, PARAM_ANNOTATION)) {
      const where = path.length ? path.join(".") : "the schema's root";
      if (!reachable || path.length === 0) return { problem: `${PARAM_ANNOTATION} on ${where}: only a property reached from the root through properties (not items, anyOf, oneOf, allOf, not, if/then/else, additionalProperties or $defs) can carry it` };
      const name = node[PARAM_ANNOTATION];
      if (typeof name !== "string" || !TCHAR.test(name)) return { problem: `${PARAM_ANNOTATION} on ${where}: ${JSON.stringify(name)} isn't a header name (letters, digits and !#$%&'*+-.^_\`|~, at least one)` };
      const type = node.type;
      if (typeof type !== "string" || !PARAM_TYPES.has(type)) return { problem: `${PARAM_ANNOTATION} on ${where}: only a string, integer or boolean property can carry it (its type is ${JSON.stringify(type ?? null)})` };
      const other = seen.get(name.toLowerCase());
      if (other !== undefined) return { problem: `${PARAM_ANNOTATION} on ${where}: ${name} is already ${other}'s (header names are case-insensitive)` };
      seen.set(name.toLowerCase(), where);
      headers.push({ path, name, type: type as ParamHeader["type"] });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "properties" && plainObject(v)) {
        for (const [prop, sub] of Object.entries(v)) stack.push({ node: sub, path: [...path, prop], reachable });
      } else if (OFF_CHAIN.has(k)) {
        const subs = Array.isArray(v) ? v : SCHEMA_MAPS.has(k) && plainObject(v) ? Object.values(v) : [v];
        for (const sub of subs) stack.push({ node: sub, path, reachable: false });
      }
    }
  }
  // The order they're checked in: by path, whatever order the schema has them.
  headers.sort((a, b) => (a.path.join("\u0000") < b.path.join("\u0000") ? -1 : a.path.join("\u0000") > b.path.join("\u0000") ? 1 : 0));
  return { headers };
}

// A plain (not Base64) header value: visible ASCII, spaces and tabs.
const PLAIN_HEADER = /^[\t\x20-\x7e]*$/;
// A header an integer is compared with as a number: a plain decimal, no sign or exponent.
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;

/** @internal An Mcp-Param header's value: trimmed of spaces and tabs, decoded (headerValue), and null if malformed (a bad sentinel, or a plain value with anything but visible ASCII, spaces and tabs). */
export function paramHeaderValue(h: string): string | null {
  const v = h.replace(/^[ \t]+|[ \t]+$/g, "");
  const decoded = headerValue(v);
  if (decoded === v && !PLAIN_HEADER.test(v)) return null;
  return decoded;
}

// headerText is a body value as a client writes it in a header, before
// encoding: a string as it is, a boolean as true or false, a number in
// decimal; undefined for anything else (an object, an array), which has none.
function headerText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

// valueAt is the value at path in args (own keys of plain objects only), or undefined.
function valueAt(args: unknown, path: string[]): unknown {
  let node = args;
  for (const k of path) {
    if (!plainObject(node) || !Object.prototype.hasOwnProperty.call(node, k)) return undefined;
    node = node[k];
  }
  return node;
}

/**
 * @internal Why an events/poll, events/stream, events/subscribe or events/unsubscribe over HTTP is refused for its
 * Mcp-Param-{Name} headers (HTTP 400, HeaderMismatch), or null. Strict, as the spec requires, unlike a
 * missing Mcp-Name: each annotated argument with a value other than null in the body needs its header, once, decoding
 * (paramHeaderValue) to the value as the client writes it (an integer compared as a number: 42.0 is 42), and a header
 * for an argument with no value or no header form is refused too. Headers no annotation names are ignored. values: a
 * header's fields by its lowercase name (undefined: none). The same rule in every SDK (test/mcp-events-interop.json
 * mcp_param).
 */
export function paramHeaderRefusal(annotated: readonly ParamHeader[], args: unknown, values: (name: string) => readonly string[] | undefined): string | null {
  for (const p of annotated) {
    const header = `Mcp-Param-${p.name}`;
    const where = `arguments.${p.path.join(".")}`;
    const got = values(PARAM_HEADER_PREFIX + p.name.toLowerCase()) ?? [];
    if (got.length > 1) return `Header mismatch: more than one ${header} header`;
    const value = valueAt(args, p.path);
    const text = value === undefined || value === null ? undefined : headerText(value);
    if (text === undefined) {
      if (got.length > 0) return `Header mismatch: ${header} is sent but ${where} has no value it mirrors`;
      continue;
    }
    if (got.length === 0) return `Header mismatch: ${header} is missing (${where} has a value)`;
    const decoded = paramHeaderValue(got[0]!);
    let same = decoded === text;
    if (decoded !== null && p.type === "integer" && typeof value === "number" && Number.isInteger(value) && DECIMAL.test(decoded)) {
      const [whole, fraction = ""] = decoded.split(".");
      same = !/[^0]/.test(fraction) && BigInt(whole!) === BigInt(value);
    }
    if (!same) return `Header mismatch: ${header} doesn't match ${where}`;
  }
  return null;
}

/** The Streamable HTTP transport's standard headers (2026-07-28, Server Validation), in lowercase. */
export const METHOD_HEADER = "mcp-method";
export const VERSION_HEADER = "mcp-protocol-version";

/** The first protocol whose requests carry their metadata (and the transport's standard headers) themselves. */
export const MODERN_PROTOCOL = "2026-07-28";

/** The events/* methods: each is refused for the transport's headers (transportHeaderRefusal) before anything else. */
export const EVENTS_METHODS: readonly string[] = ["events/list", ...NAMED_METHODS];

/**
 * Why an events/* request over HTTP is refused for the transport's standard headers (HTTP 400, HeaderMismatch), or
 * null: the 2026-07-28 Streamable HTTP transport's Server Validation, which SEP-3415's routing headers build on. A
 * request is 2026-07-28 when its MCP-Protocol-Version header or its _meta's io.modelcontextprotocol/protocolVersion
 * (metaVersion) names that protocol or a later one. When _meta names a version, MCP-Protocol-Version must be sent and
 * equal it; a 2026-07-28 request must send Mcp-Method; an Mcp-Method that's sent, on any request, must be the body's
 * method exactly. A legacy request (an initialize session's) may leave Mcp-Method out. headers: the header's value
 * (undefined: not sent), spaces and tabs at either end trimmed. The same rule in every SDK (test/mcp-events-interop.json
 * transport_headers).
 */
export function transportHeaderRefusal(method: string, headers: { version?: string; method?: string }, metaVersion: unknown): string | null {
  const trim = (v: string | undefined) => v?.replace(/^[ \t]+|[ \t]+$/g, "");
  const version = trim(headers.version);
  const sent = trim(headers.method);
  const meta = typeof metaVersion === "string" && metaVersion !== "" ? metaVersion : undefined;
  if (meta !== undefined && version === undefined) return "Header mismatch: MCP-Protocol-Version is missing, and _meta names a protocol version";
  if (meta !== undefined && version !== meta) return "Header mismatch: MCP-Protocol-Version doesn't match _meta's protocol version";
  const modern = (version ?? "") >= MODERN_PROTOCOL || (meta ?? "") >= MODERN_PROTOCOL;
  if (sent === undefined) return modern ? "Header mismatch: Mcp-Method is missing" : null;
  return sent === method ? null : "Header mismatch: Mcp-Method doesn't match the request's method";
}

/** Whether a request's _meta declares the MCP Events extension in its capabilities, as a 2026-07-28 client does on every request. */
export function declaresEventsExtension(meta: Record<string, unknown> | undefined): boolean {
  const caps = meta?.["io.modelcontextprotocol/clientCapabilities"];
  const ext = caps && typeof caps === "object" ? (caps as { extensions?: unknown }).extensions : undefined;
  return !!ext && typeof ext === "object" && !Array.isArray(ext) && EXTENSION_KEY in ext;
}

/**
 * Why an events/subscribe, events/unsubscribe, events/poll or events/stream over HTTP is refused for its Mcp-Name header
 * (HTTP 400, HeaderMismatch), or null if it isn't: one that's sent must decode (headerValue) to params.name, from any
 * client, whatever it claims to be. A missing one is accepted from every client: SEP-3415 and SEP-2243 say every client
 * must send it, but ChatGPT, OpenClaw, the Vercel AI SDK, Hermes and Mastra don't yet (a documented deviation). header:
 * the request's Mcp-Name (undefined: none). The same rule in every SDK (test/mcp-events-interop.json mcp_name).
 */
export function nameHeaderRefusal(header: string | undefined, name: unknown): string | null {
  if (header === undefined) return null;
  const v = headerValue(header.replace(/^[ \t]+|[ \t]+$/g, ""));
  return v === null || v !== name ? "Header mismatch: Mcp-Name doesn't match params.name" : null;
}

/**
 * The client table's "serves push" input where the caller doesn't say: false. attach passes whether push would be
 * listed for the request (events/list's rule); where it is, the table's without_push entries (opencode) don't apply,
 * and capabilities decide.
 */
export const SERVES_PUSH = false;

/** @internal The client table's answer for one request: native-ness, the dialect, and the matched entry's id ("" when none did: capabilities decided). */
export interface ClientVerdict {
  native: boolean;
  dialect: Dialect;
  entry: string;
}

/** A User-Agent's products: each token's text before its first "/", ASCII-lowercased, the tokens split on spaces and tabs only (clientName_ says why). */
export function uaProducts(userAgent: string): string[] {
  return userAgent
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .split(/[ \t]+/)
    .map((tok) => tok.split("/")[0] ?? "")
    .filter((p) => p !== "");
}

// The built-in checks an entry can name (match.detector): one function in each codebase.
const DETECTORS: Record<string, (clientName: string, meta: Record<string, unknown> | undefined) => boolean> = { chatgpt_desktop: chatgptNotNative };

function declares(meta: Record<string, unknown> | undefined, sessionExtensions: unknown): boolean {
  if (sessionExtensions && typeof sessionExtensions === "object" && !Array.isArray(sessionExtensions) && EXTENSION_KEY in sessionExtensions) return true;
  return declaresEventsExtension(meta);
}

// Every field holds (AND), each by any of its values (OR).
function matches(match: Record<string, readonly string[]>, client: string, raw: string, products: string[], meta: Record<string, unknown> | undefined): boolean {
  return Object.entries(match).every(([field, values]) =>
    values.some((v) => {
      switch (field) {
        case "client":
          return client === v;
        case "client_prefix":
          return client.startsWith(v);
        case "ua_product":
          return products.includes(v);
        case "meta_key": {
          const got = meta?.[v];
          return typeof got === "string" && got !== "";
        }
        case "detector":
          return DETECTORS[v]?.(raw, meta) ?? false;
        default:
          return false;
      }
    }),
  );
}

/**
 * @internal The client table's verdict (the semantics in mcp-events-clients.json's
 * _about): the first entry, in file order, whose match holds (a without_push entry doesn't apply when the server serves
 * push) decides native-ness and the dialect; with none, capabilities decide, in the spec dialect. The app's own
 * isNativeClient answers before this. The same evaluator in every SDK and the core (test/mcp-events-interop.json
 * native_client).
 */
export function evaluateClient(clientName: string, userAgent: string, meta: Record<string, unknown> | undefined, sessionExtensions: unknown, servesPush: boolean = SERVES_PUSH): ClientVerdict {
  const client = clientName_(clientName);
  const products = uaProducts(userAgent);
  for (const e of TABLE.entries) {
    if (e.without_push && servesPush) continue;
    if (!matches(e.match, client, clientName, products, meta)) continue;
    const native = e.native === "never" ? false : e.native === "undeclared" ? true : declares(meta, sessionExtensions);
    return { native, dialect: e.dialect, entry: e.id };
  }
  return { native: declares(meta, sessionExtensions), dialect: "spec", entry: "" };
}

/**
 * Whether a client subscribes with MCP Events itself: the one rule on every path (tools/list, events/list,
 * call.subscribe, after the app's isNativeClient) and in every SDK: the client table (evaluateClient). Its first
 * matching entry decides (ChatGPT's desktop app never; ChatGPT and OpenClaw without declaring; a harness Wakeshift wakes
 * itself never); otherwise a client that declares the extension, in the request's _meta or its session's initialize
 * (sessionExtensions, undefined without one). servesPush: the table's "serves push" input (SERVES_PUSH).
 */
export function nativeClient(clientName: string, userAgent: string, meta: Record<string, unknown> | undefined, sessionExtensions: unknown, servesPush: boolean = SERVES_PUSH): boolean {
  return evaluateClient(clientName, userAgent, meta, sessionExtensions, servesPush).native;
}

/**
 * @internal Whether the client table names this client in a without_push entry (opencode): one push wakes in the open
 * conversation, whose tools' subscribes the core decides (native push line, or the bridged path where Wakeshift's
 * plugin listens).
 */
export function pushClient(clientName: string, userAgent: string): boolean {
  const client = clientName_(clientName);
  const products = uaProducts(userAgent);
  return TABLE.entries.some((e) => e.without_push && matches(e.match, client, clientName, products, undefined));
}
