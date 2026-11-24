// Client requests: the core's
// /calls/addition answer can carry one request for the SDK to make of the
// MCP client during a Wakeshift subscribing call. The first kind is an
// elicitation form (Codex's install offer, in Codex's own dialog). The SDK
// knows no wording and no policy: it offers the kinds it can run in this
// call (call.client_requests), runs a request only within fixed bounds it
// enforces itself, whatever the core sends, uses the core's text for the
// outcome, and reports the outcome. test/client-requests.json pins the
// bounds, the outcome keys and the offer for every SDK.

import type { Host, Req } from "./host.js";
import { redactSecrets } from "./secrets.js";

/** @internal The kind of request this SDK can run. */
export const ELICIT_FORM = "elicit.form";

/** @internal The bounds (test/client-requests.json bounds). */
export const CLIENT_REQUEST_BOUNDS = {
  messageMax: 1200,
  messageLinesMax: 20,
  titleMax: 80,
  fieldsMax: 2,
  optionsMax: 4,
  outcomeTextMax: 4000,
  timeoutMs: 120_000,
  reportWaitMs: 2_000,
  sessionWindowMs: 600_000,
} as const;

/** @internal The outcome keys besides an accepted answer's <field>=<value>. */
export const OUTCOME_KEYS = ["decline", "cancel", "timeout", "unsupported"] as const;

/** @internal One outcome's result: the core's text in place of Wakeshift's own, where it goes, and the beacon. */
export interface RequestOutcome {
  text: string;
  placement: "before" | "after";
  beacon: "keep" | "drop";
}

/** @internal A request as the core describes it. */
export interface ClientRequest {
  token: string;
  kind: string;
  message: string;
  schema: { type: string; required?: string[]; properties: Record<string, RequestField> };
  outcomes: Record<string, RequestOutcome>;
}

interface RequestField {
  type: string;
  title: string;
  oneOf?: { const: string; title: string }[];
}

// The protocols a request pushed during a call works on: an allowlist, so a
// revision this SDK doesn't know (2026-07-28 replaced the push with
// inputRequired) gets none. "": none on the request (stdio).
const PUSH_PROTOCOLS = new Set(["", "2025-06-18", "2025-11-25"]);
const VERSION_META = "io.modelcontextprotocol/protocolVersion";

/** @internal The message's first line, which the SDK writes itself: Wakeshift and the app, always. */
export function requestPrefix(app: string): string {
  const name = [...app.trim()].slice(0, CLIENT_REQUEST_BOUNDS.titleMax).join("") || "an app";
  return `Wakeshift, for ${name}:`;
}

/** @internal The message the client is sent: the SDK's line, then the core's message. */
export function requestMessage(r: Pick<ClientRequest, "message">, app: string): string {
  return requestPrefix(app) + "\n" + r.message;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** @internal The values an answer to the request can have, as outcome keys (<field>=<value>). */
function answerKeys(r: ClientRequest): string[] {
  const out: string[] = [];
  for (const [name, f] of Object.entries(r.schema.properties)) {
    if (f.type === "boolean") out.push(`${name}=true`, `${name}=false`);
    else for (const o of f.oneOf ?? []) out.push(`${name}=${o.const}`);
  }
  return out;
}

/**
 * @internal "" if the SDK may run the request for app, else the first bound
 * it breaks (test/client-requests.json validate: kind, message, lines,
 * secret, schema, fields, field, options, title, outcomes, outcome_text,
 * placement, beacon).
 */
export function validateRequest(raw: unknown, app: string): string {
  const b = CLIENT_REQUEST_BOUNDS;
  if (!isObj(raw) || raw.kind !== ELICIT_FORM || typeof raw.token !== "string" || !raw.token) return "kind";
  if (typeof raw.message !== "string") return "message";
  const message = requestMessage({ message: raw.message }, app);
  if ([...message].length > b.messageMax) return "message";
  if (message.split("\n").length > b.messageLinesMax) return "lines";
  if (redactSecrets(message) !== message) return "secret";
  const schema = raw.schema;
  if (!isObj(schema) || schema.type !== "object" || !isObj(schema.properties)) return "schema";
  const fields = Object.entries(schema.properties);
  if (fields.length === 0 || fields.length > b.fieldsMax) return "fields";
  for (const [, f] of fields) {
    if (!isObj(f)) return "field";
    if (f.type === "boolean") {
      if (f.oneOf !== undefined || f.enum !== undefined) return "field";
    } else if (f.type === "string" && Array.isArray(f.oneOf) && f.enum === undefined && f.format === undefined) {
      if (f.oneOf.length === 0 || f.oneOf.length > b.optionsMax) return "options";
      for (const o of f.oneOf) {
        if (!isObj(o) || typeof o.const !== "string" || !o.const || typeof o.title !== "string") return "field";
        if ([...o.title].length > b.titleMax) return "title";
      }
    } else {
      return "field";
    }
    if (typeof f.title !== "string" || [...f.title].length > b.titleMax) return "title";
  }
  const outcomes = raw.outcomes;
  if (!isObj(outcomes)) return "outcomes";
  const r = raw as unknown as ClientRequest;
  for (const k of [...answerKeys(r), ...OUTCOME_KEYS]) if (!isObj(outcomes[k])) return "outcomes";
  for (const o of Object.values(outcomes)) {
    if (!isObj(o) || typeof o.text !== "string" || [...o.text].length > b.outcomeTextMax) return "outcome_text";
    if (o.placement !== "before" && o.placement !== "after") return "placement";
    if (o.beacon !== "keep" && o.beacon !== "drop") return "beacon";
  }
  return "";
}

/** @internal The outcome key for the client's elicitation result to a valid request (test/client-requests.json outcome). */
export function outcomeKey(result: unknown, r: ClientRequest): string {
  if (!isObj(result)) return "unsupported";
  if (result.action === "decline" || result.action === "cancel") return result.action;
  if (result.action !== "accept" || !isObj(result.content)) return "unsupported";
  // The first field answered with one of its values names the outcome.
  for (const [name, f] of Object.entries(r.schema.properties)) {
    const v = result.content[name];
    if (f.type === "boolean" && typeof v === "boolean") return `${name}=${v}`;
    if (f.type === "string" && typeof v === "string" && (f.oneOf ?? []).some((o) => o.const === v)) return `${name}=${v}`;
  }
  return "unsupported";
}

/** @internal What the SDK sees of a call, for the offer (test/client-requests.json offer). */
export interface OfferInput {
  capabilities: Record<string, unknown> | undefined;
  protocol: string;
  http: boolean;
  session: string;
  off?: boolean;
  recent?: boolean;
}

/** @internal Whether the SDK offers an elicitation form for this call. */
export function offersForm(o: OfferInput): boolean {
  if (o.off || o.recent) return false;
  const e = o.capabilities?.elicitation;
  // 2025-06-18 declared elicitation as {}: forms. Later revisions say form.
  if (!isObj(e) || (Object.keys(e).length > 0 && !("form" in e))) return false;
  if (!PUSH_PROTOCOLS.has(o.protocol)) return false;
  // Over HTTP, only a stateful session carries the client's answer back to this process.
  return !o.http || !!o.session;
}

// The sessions a form was shown in, per attached server (so other clients
// and servers in the process never share one), by session ("stdio" for the
// server's one stdio connection), with when: at most one per session per
// window. Each server's map is bounded: the oldest go first.
let windows = new WeakMap<object, Map<string, number>>();
const RECENT_MAX = 10_000;

function windowOf(host: Host): Map<string, number> {
  const key = host.server as object;
  let w = windows.get(key);
  if (!w) windows.set(key, (w = new Map()));
  return w;
}

function sessionOf(raw: unknown, req: Req): string {
  const id = (raw as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof id === "string" && id ? id : req.http ? "" : "stdio";
}

/** @internal The kinds this call can run, for call.client_requests: [ELICIT_FORM] or []. */
export function offeredKinds(host: Host, raw: unknown, req: Req, off: boolean): string[] {
  // MCP SDK 2.x's ctx.mcpReq.elicitInput sends the request during the call.
  // 1.x hosts and frameworks without it get none in this release.
  const elicit = (raw as { mcpReq?: { elicitInput?: unknown } } | undefined)?.mcpReq?.elicitInput;
  if (host.version !== 2 || typeof elicit !== "function") return [];
  const session = sessionOf(raw, req);
  const at = windowOf(host).get(session);
  const recent = at !== undefined && Date.now() - at < CLIENT_REQUEST_BOUNDS.sessionWindowMs;
  const protocol = String(req.meta?.[VERSION_META] ?? req.header("mcp-protocol-version") ?? "");
  return offersForm({ capabilities: host.clientCapabilities(), protocol, http: !!req.http, session: req.http ? session : "stdio", off, recent }) ? [ELICIT_FORM] : [];
}

/** @internal What running a request gives: the outcome key, and its result. */
export interface RanRequest {
  outcome: string;
  result: RequestOutcome;
}

/**
 * @internal Runs a request (already validated) for the call: shows the form
 * through the call's own context and maps the answer. Never throws: an
 * error is unsupported, a timeout timeout, the call ending cancel.
 */
export async function runForm(raw: unknown, req: Req, r: ClientRequest, app: string): Promise<RanRequest> {
  let outcome: string;
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), CLIENT_REQUEST_BOUNDS.timeoutMs);
  timeout.unref?.();
  const signal = req.signal ? AbortSignal.any([req.signal, timer.signal]) : timer.signal;
  try {
    const elicit = (raw as { mcpReq: { elicitInput: (p: unknown, o?: unknown) => Promise<unknown> } }).mcpReq.elicitInput.bind((raw as { mcpReq: object }).mcpReq);
    const result = await elicit({ mode: "form", message: requestMessage(r, app), requestedSchema: r.schema }, { signal, timeout: CLIENT_REQUEST_BOUNDS.timeoutMs });
    outcome = outcomeKey(result, r);
  } catch {
    // The MCP SDK sends notifications/cancelled for a request aborted or timed out.
    outcome = req.signal?.aborted ? "cancel" : timer.signal.aborted ? "timeout" : "unsupported";
  } finally {
    clearTimeout(timeout);
  }
  return { outcome, result: r.outcomes[outcome] ?? r.outcomes.unsupported! };
}

/**
 * @internal Claims the call's session's one form per window, just before
 * showing it (the offer checked it too, but the call may have waited):
 * false if a form was shown in it within the window.
 */
export function claimSession(host: Host, raw: unknown, req: Req): boolean {
  const recentForms = windowOf(host);
  const session = sessionOf(raw, req);
  // No session (HTTP without one): nothing can carry a form, and an empty
  // key would be shared, so it's never claimed.
  if (!session) return false;
  const at = recentForms.get(session);
  if (at !== undefined && Date.now() - at < CLIENT_REQUEST_BOUNDS.sessionWindowMs) return false;
  if (recentForms.size >= RECENT_MAX) recentForms.delete(recentForms.keys().next().value!);
  recentForms.set(session, Date.now());
  return true;
}

/** @internal Forgets the sessions forms were shown in (tests). */
export function resetRecentForms(): void {
  windows = new WeakMap();
}
