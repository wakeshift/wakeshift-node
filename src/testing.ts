// @wakeshift/sdk/testing: unit-test the tools that subscribe, without a
// Wakeshift core, a key or the network.
//
//   import { createTestClient, createToolCall, withCall } from "@wakeshift/sdk/testing"
//
//   const wake = createTestClient()            // enabled and offline: records what the SDK would send
//   const crawlFinished = wake.defineEvent(…)
//   const call = createToolCall()              // a ToolCall for a handler you call directly
//   await handler({ url }, ctx, call)
//   call.subscriptions                         // [{ event: "crawl.finished", args: { job }, options: { once: true } }]
//   await withCall(wake, call, () => handlerThatUsesCurrentCall())   // wake.currentCall() returns call
//   wake.emits                                 // [{ event, args, payload, text, id, to }]
//   wake.failNext("subscribe", "unreachable")  // the next subscribe fails, as when Wakeshift is down
//   await wake.redeem(voucher, webhookUrl)     // ChatGPT subscribing with the voucher a tool handed it
//   await wake.close()                         // waits for watch checks in flight and their emits, then stops
//
// The test client serves MCP Events push too: a client's events/stream to a
// server attached with it gets active, then an event for each matching emit.

import { randomBytes } from "node:crypto";
import { Wakeshift, type Recognized, type Recipient } from "./wakeshift.js";
import { APIConnectionError, APIError, UsageError } from "./errors.js";
import { callLimitOf, made, runWithTestCall, skipsWait, subscribeBody, type AnyEvent, type EventArgs, type SubscribeOptions, type Subscription } from "./toolcall.js";
import { subscribeNatively } from "./events.js";
import { rememberVouchers } from "./voucherctx.js";
import { drainWatches, onSubscribeSettled } from "./watch.js";
import type { Logger, LogLevel } from "./log.js";
import type { AnySchema, SchemaInput } from "./zod.js";
import type { WakeEvent } from "./events.js";

/** A test value, not a credential: the shared fixtures' app key (app-keys.json). */
const TEST_KEY = "wst_1116qJFWMMHFy3xDdLmvUeyc2S6FrWRhJP51HsvDYdz9fWXzSV";
const TEST_CORE = "https://wakeshift.test";
const TEST_SESSION = "wsc_test_session";
const RECOGNIZED: Recognized = { harness: "claude-code", via: "client", claimed: null };

/** One emit the test client received. */
export interface TestEmit {
  event: string;
  args: Record<string, unknown>;
  payload: unknown;
  /** The line the agent would read. */
  text: string;
  id?: string;
  to?: string | (string | Recipient)[];
}

/** One subscription the test client made: through a tool, subscribe_events, or natively. */
export interface TestSubscription {
  id: string;
  event: string;
  args: Record<string, unknown>;
  /** The subscribing tool (subscribe_events for that path), or undefined for a native subscription. */
  tool: string | undefined;
  user: string | undefined;
  once: boolean;
  replay?: number;
  ttl?: number;
  via: "tool" | "subscribe_events" | "native";
}

/** One unsubscribe the test client received. */
export interface TestUnsubscribe {
  event: string;
  args: Record<string, unknown>;
  ended: boolean;
}

/** One publish URL the test client minted. */
export interface TestPublishUrl {
  id: string;
  event: string;
  args: Record<string, unknown>;
  to?: string;
}

/** What failNext makes the next subscribe or unsubscribe do: no answer (unreachable), or Wakeshift refusing it (refused: 401 unauthenticated, as for a refused key). */
export type TestFailure = "unreachable" | "refused";

/** A voucher a stand-in call (createToolCall with client) handed out. */
export interface TestVoucher {
  event: string;
  args: Record<string, unknown>;
  /** The voucher, wsv_ and 32 characters, as the tool's result would carry it. */
  voucher: string;
}

/** What wake.redeem gives: the subscription's id, and whether it was created (false: a refresh). */
export interface TestRedeemed {
  id: string;
  created: boolean;
}

// The core's answer to any refused voucher (internal/appapi/vouchers.go).
const BAD_VOUCHER = "This voucher can't subscribe to this event: it was used, it expired, or it's for other arguments.";
const VOUCHER_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// newVoucher is a voucher in the core's form: wsv_ and 32 lowercase base32 characters.
function newVoucher(): string {
  return "wsv_" + [...randomBytes(32)].map((b) => VOUCHER_ALPHABET[b % 32]).join("");
}

// compact is arguments as the core writes them in a voucher line: compact JSON, keys sorted.
function compact(args: unknown): string {
  return JSON.stringify(sortKeys(args ?? {}));
}

/** @internal The core's line for a handed-out voucher (internal/appapi/vouchers.go voucherLine). */
function voucherLine(event: string, args: unknown, voucher: string): string {
  return `To be woken by ${event} with ${compact(args)}, subscribe to it (MCP Events) with wakeshift_voucher set to ${voucher} in its arguments. It works once, for these arguments.`;
}

interface MintedVoucher {
  event: string;
  args: Record<string, unknown>;
  tool: string;
  user?: string;
  once: boolean;
  webhook?: string;
  sub?: TestSubscription;
}

// One push stream the fake core holds open.
interface PushStream {
  sub: TestSubscription;
  timer?: ReturnType<typeof setInterval>;
  write(frame: Record<string, unknown>): void;
  deliver(occurrence: Record<string, unknown>): void;
  close(): void;
  end(): void;
}

const FAILURE_PATHS: Record<"subscribe" | "unsubscribe", string> = { subscribe: "/event-subscriptions", unsubscribe: "/event-subscriptions/unsubscribe" };

function checkFailure(op: unknown, error: unknown): void {
  if (op !== "subscribe" && op !== "unsubscribe") throw new UsageError("bad_arguments", `failNext's op is "subscribe" or "unsubscribe"`);
  if (error !== "unreachable" && error !== "refused") throw new UsageError("bad_arguments", `failNext's error is "unreachable" or "refused"`);
}

// failureError is the error a call gets for failNext's error, as the SDK throws it.
function failureError(error: TestFailure): APIError {
  if (error === "unreachable") return new APIConnectionError({ code: "unreachable", message: "wakeshift: couldn't reach Wakeshift (the test client's failNext)" });
  return new APIError({ status: 401, code: "unauthenticated", message: "the app key was refused (the test client's failNext)" });
}

/** createTestClient's options. */
export interface TestClientOptions {
  /** The app's name, as the console would give it (the subscribes sentence uses it). Default "Test app". */
  app?: string;
  /**
   * Whether the fake Wakeshift confirms it can wake the conversations its
   * subscribes name: call.wakes on the tool calls of a server attached with
   * this client. Default true; false tests your tool's fallback (its own
   * polling or waiting, as without Wakeshift) through a real server.
   */
  wakes?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
}

const key = (event: string, args: unknown) => event + "\u0000" + JSON.stringify(sortKeys(args ?? {}));
function sortKeys(v: unknown): unknown {
  return Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
}

// FakeCore answers the app API the SDK calls, from memory, and records it.
class FakeCore {
  emits: TestEmit[] = [];
  subscriptions: TestSubscription[] = [];
  unsubscribes: TestUnsubscribe[] = [];
  publishUrls: TestPublishUrl[] = [];
  private live = new Map<string, TestSubscription>();
  private ids = new Map<string, string>();
  private n = 0;
  private fails = new Map<string, TestFailure>();
  readonly vouchers = new Map<string, MintedVoucher>();
  /** Whether an event is tools-only (only the app's tools subscribe to it): set by the TestClient. */
  toolsOnly: (event: string) => boolean = () => false;
  /** What a subscribe answers for wakes (TestClientOptions.wakes). */
  wakes = true;

  constructor(private readonly app: string) {}

  failNext(op: "subscribe" | "unsubscribe", error: TestFailure): void {
    this.fails.set(FAILURE_PATHS[op], error);
  }

  /** A new voucher for a tools-only event, as the core hands one out. */
  mint(event: string, args: Record<string, unknown>, tool: string, user: string | undefined, once: boolean): string {
    const voucher = newVoucher();
    this.vouchers.set(voucher, { event, args, tool, user, once });
    return voucher;
  }

  clear(): void {
    this.emits.length = 0;
    this.subscriptions.length = 0;
    this.unsubscribes.length = 0;
    this.publishUrls.length = 0;
    this.live.clear();
    this.ids.clear();
    this.fails.clear();
    this.vouchers.clear();
    this.closeStreams();
    this.pushSubs.clear();
  }

  fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url instanceof Request ? url.url : url));
    const path = u.pathname.replace(/^\/api\/apps\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const fail = this.fails.get(path);
    // failNext: the next such request fails (never a failed call's rollback, which isn't an unsubscribe).
    if (fail && method === "POST" && body?.reason !== "rolled_back") {
      this.fails.delete(path);
      if (fail === "unreachable") throw new TypeError("fetch failed (the test client's failNext)");
      return new Response(JSON.stringify({ error: { code: "unauthenticated", message: "the app key was refused (the test client's failNext)" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/events/stream" && method === "POST") return this.stream(body, init?.signal ?? undefined);
    const [status, json] = this.answer(method, path, body);
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  // ── Push (events/stream) ──────────────────────────────────────────────
  // The upstream as Wakeshift serves it: NDJSON frames, active first, an
  // event for each matching emit, heartbeats at the grant, and close when
  // the test client closes. Cursors are the fake's own (c2.test.<sub>.<seq>).

  private readonly streams = new Set<PushStream>();
  private readonly pushSubs = new Map<string, { sub: TestSubscription; seq: number }>();

  private stream(b: any, signal: AbortSignal | undefined): Response {
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    let voucherSub: MintedVoucher | undefined;
    if (typeof b.voucher === "string") {
      const v = this.vouchers.get(b.voucher);
      const refused = json(403, { error: { code: "bad_voucher", message: BAD_VOUCHER } });
      if (!v || v.event !== b.name || compact(v.args) !== compact(b.arguments ?? {})) return refused;
      if (v.user && v.user !== b.call?.user) return refused;
      if (v.sub && (b.cursor == null || !this.pushSubs.has(String(b.cursor).split(".")[2] ?? ""))) return refused;
      voucherSub = v;
    } else if (this.toolsOnly(b.name)) {
      return json(403, { error: { code: "tools_only", message: `${b.name} can be subscribed only through this app's tools` } });
    }
    const grant = Math.min(45_000, Math.max(10_000, typeof b.heartbeat_ms === "number" ? b.heartbeat_ms : 30_000));
    const id = typeof b.cursor === "string" ? (b.cursor.split(".")[2] ?? "") : "";
    let held = this.pushSubs.get(id);
    let created = false;
    let truncated = false;
    if (!held) {
      // A null cursor (or one whose subscription is gone): a new subscription.
      truncated = b.cursor != null;
      created = true;
      const sub: TestSubscription = voucherSub
        ? { id: `sub_test_${++this.n}`, event: b.name, args: b.arguments ?? {}, tool: voucherSub.tool, user: voucherSub.user, once: voucherSub.once, via: "tool" }
        : { id: `sub_test_${++this.n}`, event: b.name, args: b.arguments ?? {}, tool: undefined, user: b.call?.user, once: false, via: "native" };
      held = { sub, seq: 0 };
      this.pushSubs.set(sub.id, held);
      this.subscriptions.push(sub);
      if (voucherSub) voucherSub.sub = sub;
    }
    const h = held;
    const cursor = () => `c2.test.${h.sub.id}.${h.seq}`;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const s: PushStream = {
      sub: h.sub,
      write: (frame) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
        } catch {
          // closed already
        }
      },
      deliver: (occurrence) => {
        h.seq++;
        s.write({ type: "event", occurrence: { ...occurrence, cursor: cursor() } });
      },
      close: () => {
        s.write({ type: "close" });
        s.end();
      },
      end: () => {
        clearInterval(s.timer);
        this.streams.delete(s);
        try {
          controller.close();
        } catch {
          // closed already
        }
      },
    };
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
      cancel: () => s.end(),
    });
    this.streams.add(s);
    s.write({ type: "active", cursor: cursor(), truncated, heartbeat_ms: grant, created, ...(voucherSub ? { via: "tool:" + voucherSub.tool, tool: voucherSub.tool } : {}) });
    s.timer = setInterval(() => s.write({ type: "heartbeat", cursor: cursor() }), grant);
    (s.timer as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", () => s.end(), { once: true });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }

  /** An emit, to the push streams it matches. */
  private push(e: TestEmit): void {
    const tos = e.to === undefined ? undefined : (Array.isArray(e.to) ? e.to : [e.to]).map((r) => (typeof r === "string" ? r : "user" in r ? r.user : r.native));
    for (const s of this.streams) {
      if (key(s.sub.event, s.sub.args) !== key(e.event, e.args)) continue;
      if (tos && !tos.includes(s.sub.user ?? "")) continue;
      s.deliver({ eventId: `evt_test_${++this.n}`, name: e.event, timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), data: e.payload, _meta: { "ai.wakeshift/text": e.text } });
    }
  }

  /** Ends every push stream as Wakeshift does on a deploy: close, and the clients reconnect. */
  closeStreams(): void {
    for (const s of [...this.streams]) s.close();
  }

  private subscribe(event: string, args: Record<string, unknown>, s: Omit<TestSubscription, "id" | "event" | "args">): { sub: TestSubscription; created: boolean } {
    const k = key(event, args) + "\u0000" + (s.via === "native" ? "native:" + (s.user ?? "") : "conversation");
    const known = this.live.get(k);
    if (known) return { sub: known, created: false };
    const sub: TestSubscription = { id: `sub_test_${++this.n}`, event, args, ...s };
    this.live.set(k, sub);
    this.subscriptions.push(sub);
    return { sub, created: true };
  }

  // redeem is a voucher's events/subscribe, as the core answers it: the
  // first use subscribes (the handing-out tool's subscription); the same
  // webhook again refreshes it; anything else is refused, with one answer.
  private redeem(b: any): [number, unknown] {
    const refused: [number, unknown] = [403, { error: { code: "bad_voucher", message: BAD_VOUCHER } }];
    const v = this.vouchers.get(b.voucher);
    const url = b.delivery?.url;
    if (!v || v.event !== b.name || compact(v.args) !== compact(b.arguments ?? {}) || typeof url !== "string" || !url) return refused;
    if (v.user && v.user !== b.call?.user) return refused;
    const refresh = { refresh_before: new Date(Date.now() + 3_600_000).toISOString(), cursor: "c0", truncated: false, via: "tool:" + v.tool, tool: v.tool };
    if (v.sub) {
      if (v.webhook !== url) return refused;
      return [200, { id: v.sub.id, created: false, ...refresh }];
    }
    const sub: TestSubscription = { id: `sub_test_${++this.n}`, event: v.event, args: v.args, tool: v.tool, user: v.user, once: v.once, via: "tool" };
    this.live.set(key(v.event, v.args) + "\u0000voucher:" + b.voucher, sub);
    this.subscriptions.push(sub);
    v.sub = sub;
    v.webhook = url;
    return [200, { id: sub.id, created: true, ...refresh }];
  }

  private answer(method: string, path: string, b: any): [number, unknown] {
    switch (path) {
      case "/app":
        return [200, { id: "test-app", name: this.app, key: { key_id: "test", name: "test" } }];
      case "/manifest":
      case "/manifest/merge":
        // A core that hands out subscribe vouchers and serves push.
        return [200, method === "GET" ? { description: "" } : { ...b, features: ["subscribe_vouchers", "push"] }];
      case "/events/emit": {
        const e: TestEmit = { event: b.name, args: b.arguments ?? {}, payload: b.payload, text: b.text };
        if (b.id) e.id = b.id;
        if (b.to !== undefined) e.to = b.to;
        // An id makes a retry emit once; the same id on a different emit is refused.
        const sameAs = b.id ? this.ids.get(b.id) : undefined;
        const content = JSON.stringify(sortKeys({ n: b.name, a: b.arguments, p: b.payload, t: b.to }));
        if (sameAs !== undefined) {
          if (sameAs !== content) return [409, { error: { code: "id_reused", message: "that id was used for another emit" } }];
          return [200, { matched: 0, duplicate: true }];
        }
        if (b.id) this.ids.set(b.id, content);
        this.emits.push(e);
        this.push(e);
        const matched = [...this.live.values()].filter((s) => s.event === b.name && key(s.event, s.args) === key(b.name, b.arguments)).length;
        return [200, { matched }];
      }
      case "/event-subscriptions": {
        const via = b.call?.tool === "subscribe_events" ? "subscribe_events" : "tool";
        const { sub, created } = this.subscribe(b.name, b.arguments ?? {}, { tool: b.call?.tool, user: b.call?.user, once: !!b.once, replay: b.replay, ttl: b.ttl, via });
        return [
          200,
          {
            event_subscription: { id: sub.id, user: b.call?.user ?? "", event: b.name, arguments: b.arguments ?? {}, created },
            session: TEST_SESSION,
            pending: b.pending || "pa_test",
            agent: { harness: RECOGNIZED.harness, via: RECOGNIZED.via },
            wakes: this.wakes,
            addition: { text: "(Wakeshift test client: the conversation's wake instructions go here.)" },
          },
        ];
      }
      case "/event-subscriptions/unsubscribe": {
        const k = key(b.name, b.arguments ?? {}) + "\u0000conversation";
        const ended = this.live.delete(k);
        if (b.reason !== "rolled_back") this.unsubscribes.push({ event: b.name, args: b.arguments ?? {}, ended });
        return [200, { ended }];
      }
      case "/event-subscriptions/list":
        return [200, { subscriptions: [...this.live.values()].map((s) => ({ id: s.id, event: s.event, arguments: s.args, destination: s.via === "native" ? "webhook" : "conversation" })) }];
      case "/event-subscriptions/end": {
        for (const [k, s] of this.live) {
          if (s.id === b.id) {
            this.live.delete(k);
            return [200, { ended: true }];
          }
        }
        return [200, { ended: false }];
      }
      case "/calls/session":
        return [200, { session: TEST_SESSION, pending: "pa_test", agent: { harness: RECOGNIZED.harness, via: RECOGNIZED.via } }];
      case "/calls/addition": {
        // A native call's lines, as the core writes them: a tools-only event's with a voucher.
        if (Array.isArray(b.native) && b.native.length > 0) {
          const lines = b.native.map((n: { name: string; arguments?: Record<string, unknown>; once?: boolean }) => {
            const args = n.arguments ?? {};
            if (!this.toolsOnly(n.name)) return `To be woken by ${n.name} with ${compact(args)}, subscribe to it (MCP Events).`;
            return voucherLine(n.name, args, this.mint(n.name, args, b.call?.tool ?? "", b.call?.user, !!n.once));
          });
          return [200, { text: lines.join("\n") }];
        }
        return [200, { text: "(Wakeshift test client: the conversation's wake instructions go here.)" }];
      }
      case "/events/publish-urls": {
        const id = `pub_test_${++this.n}`;
        const p: TestPublishUrl = { id, event: b.name, args: b.arguments ?? {} };
        if (b.to) p.to = b.to;
        this.publishUrls.push(p);
        return [200, { id, event: b.name, url: `${TEST_CORE}/p/wsp_test_${this.n}` }];
      }
      case "/events/status": {
        if (Array.isArray(b.subscriptions)) return [200, { subscriptions: [] }];
        const n = [...this.live.values()].filter((s) => key(s.event, s.args) === key(b.name, b.arguments)).length;
        return [200, { subscriptions: n, connected: 0 }];
      }
      case "/events/subscribe": {
        if (typeof b.voucher === "string") return this.redeem(b);
        const { sub, created } = this.subscribe(b.name, b.arguments ?? {}, { tool: undefined, user: b.call?.user, once: false, via: "native" });
        return [200, { id: sub.id, refresh_before: new Date(Date.now() + 3_600_000).toISOString(), cursor: "c0", truncated: false, created }];
      }
      case "/events/unsubscribe": {
        const ended = this.live.delete(key(b.name, b.arguments ?? {}) + "\u0000native:" + (b.call?.user ?? ""));
        return [200, { ended }];
      }
      case "/events/poll": {
        const { created } = b.cursor ? { created: false } : this.subscribe(b.name, b.arguments ?? {}, { tool: undefined, user: b.call?.user, once: false, via: "native" });
        return [200, { events: [], cursor: "c0", truncated: false, has_more: false, next_poll_ms: 10_000, created }];
      }
      case "/events/stream/end": {
        // An explicit cancel (stdio) ends the stream's subscription.
        const id = typeof b.cursor === "string" ? (b.cursor.split(".")[2] ?? "") : "";
        const held = this.pushSubs.get(id);
        if (!held) return [200, { ended: false }];
        this.pushSubs.delete(id);
        for (const s of [...this.streams]) if (s.sub === held.sub) s.end();
        this.unsubscribes.push({ event: held.sub.event, args: held.sub.args, ended: true });
        return [200, { ended: true }];
      }
      case "/users/forget":
        return [200, { forgotten: false }];
    }
    if (method === "DELETE" && path.startsWith("/events/publish-urls/")) return [200, {}];
    return [404, { error: { code: "unsupported", message: `the test client doesn't answer ${method} ${path}` } }];
  }
}

const CORES = new WeakMap<TestClient, FakeCore>();

/**
 * A Wakeshift client for unit tests: enabled (tools/list carries
 * Wakeshift's arguments and sentence, calls subscribe) and offline (it
 * answers from memory, never reads WAKESHIFT_KEY, never touches the
 * network). It records what the SDK would have sent.
 */
export class TestClient extends Wakeshift {
  constructor(opts: TestClientOptions = {}) {
    const core = new FakeCore(opts.app ?? "Test app");
    core.wakes = opts.wakes ?? true;
    super({ key: TEST_KEY, core: TEST_CORE, fetch: core.fetch, logger: opts.logger, logLevel: opts.logLevel, maxRetries: 0 });
    const events = (this as unknown as { events: Map<string, AnyEvent> }).events;
    core.toolsOnly = (name) => events.get(name)?.access === "tools";
    CORES.set(this, core);
  }

  /**
   * Makes the next subscribe (a tool's call.subscribe) or unsubscribe fail:
   * "unreachable", as when Wakeshift doesn't answer (an APIConnectionError,
   * code unreachable), or "refused", as when Wakeshift refuses the app's key
   * (an APIError, status 401, code unauthenticated; the client logs
   * key_refused). Once: the request after it succeeds.
   */
  failNext(op: "subscribe" | "unsubscribe", error: TestFailure): void {
    checkFailure(op, error);
    CORES.get(this)!.failNext(op, error);
  }

  /**
   * Subscribes with a voucher, as ChatGPT does with the one a tool's result
   * handed it (events/subscribe with wakeshift_voucher and a webhook),
   * through the SDK's own redemption: the subscription is the handing-out
   * tool's, and the event's onSubscribe runs with that call's context.
   * Reusing it behaves as Wakeshift does: the same webhook refreshes the
   * subscription (created false); anything else is refused (an APIError,
   * code bad_voucher).
   */
  async redeem(voucher: string, webhookUrl: string): Promise<TestRedeemed> {
    const core = CORES.get(this)!;
    const v = core.vouchers.get(voucher);
    const events = (this as unknown as { events: Map<string, AnyEvent> }).events;
    const ev = v ? events.get(v.event) : undefined;
    if (!v || !ev) throw new APIError({ status: 403, code: "bad_voucher", message: BAD_VOUCHER });
    const body = {
      call: { client: "openai-mcp", meta: {}, ...(v.user ? { user: v.user } : {}) },
      name: v.event,
      arguments: v.args,
      delivery: { mode: "webhook", url: webhookUrl, secret: "whsec_dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQtdGVzdA==" },
      dialect: "chatgpt",
      voucher,
    };
    const { result, created } = await subscribeNatively(this, ev as never, body, v.args, v.user, voucher);
    return { id: String(result.id), created };
  }

  /**
   * Waits for the watch checks in flight, and the emits they lead to, and
   * for onSubscribe work, then stops every watch: after it, emits holds
   * what a check that was already done emitted.
   */
  async close(): Promise<void> {
    await drainWatches(this);
    // Open push streams end as on a deploy (close): their clients get the final result.
    CORES.get(this)!.closeStreams();
    await super.close();
  }

  /** Every emit, in order (a duplicate retry with the same id isn't counted twice). */
  get emits(): TestEmit[] {
    return CORES.get(this)!.emits;
  }

  /** Every subscription made (renewals aren't repeated). */
  get subscriptions(): TestSubscription[] {
    return CORES.get(this)!.subscriptions;
  }

  /** Every unsubscribe (a failed call's rollback isn't one). */
  get unsubscribes(): TestUnsubscribe[] {
    return CORES.get(this)!.unsubscribes;
  }

  /** Every publish URL minted. */
  get publishUrls(): TestPublishUrl[] {
    return CORES.get(this)!.publishUrls;
  }

  /** Forgets everything recorded, and every subscription. */
  clear(): void {
    CORES.get(this)!.clear();
  }
}

/** A TestClient: a Wakeshift client for unit tests, enabled and offline, that records subscribes and emits. */
export function createTestClient(opts: TestClientOptions = {}): TestClient {
  return new TestClient(opts);
}

/** createToolCall's options. */
export interface TestToolCallOptions<C> {
  /** The tool being called. Default "test_tool". */
  tool?: string;
  /** Who identify says is calling. Default none. */
  user?: string;
  /** A native client (MCP Events): subscribe answers state "native". */
  native?: boolean;
  /** The request context your handler gets (ctx / extra). */
  ctx?: C;
  /** The events the tool declares: subscribe refuses others (undeclared_subscribe), as a real call does. Default: any. */
  events?: readonly AnyEvent[];
  /**
   * A test client, for a native call (a ChatGPT-shaped one): a subscribe to
   * a tools-only event hands out a voucher there (call.vouchers), which
   * client.redeem subscribes with, the subscribe's context remembered.
   */
  client?: TestClient;
  /**
   * Whether Wakeshift can wake the conversation: call.wakes is this once a
   * subscribe holds a subscription. Default true; false tests your tool's
   * fallback (its own polling or waiting, as without Wakeshift).
   */
  wakes?: boolean;
  /**
   * The program's per-call limit in seconds a subscribe sets (call.callLimit),
   * as Wakeshift gives it for Claude Code (60) or Codex (300). Default
   * undefined, as for a program whose limit isn't known; a native call never
   * has one.
   */
  callLimit?: number;
}

/** One subscribe or unsubscribe a stand-in call received. */
export interface TestCallRecord {
  event: string;
  args: Record<string, unknown>;
  /** The options as given, context included. */
  options: SubscribeOptions;
}

/**
 * A stand-in ToolCall for a handler you call directly in a unit test:
 * subscribe checks the event and arguments as a real call does, answers a
 * full Subscription (created, then renewed for the same arguments; native
 * for a native call), and records it. session is null until a subscribe or
 * resolveSession, as on a real call.
 */
export class TestToolCall<C = unknown> {
  readonly user: string | undefined;
  readonly tool: string;
  readonly native: boolean;
  readonly nativeConversation: string | null = null;
  session: string | null = null;
  recognized: Recognized | null = null;
  readonly ctx: C;
  /** What subscribe received, in order (renewals too). */
  readonly subscriptions: TestCallRecord[] = [];
  /** What unsubscribe received, in order. */
  readonly unsubscribes: TestCallRecord[] = [];
  /** The vouchers a native call with a client handed out, in order: what the tool's result would carry. */
  readonly vouchers: TestVoucher[] = [];
  private readonly events?: readonly AnyEvent[];
  private readonly client?: TestClient;
  private readonly live = new Map<string, string>();
  // The subscriptions the call created, with their context: finish's onSubscribe.
  private readonly created = new Map<string, { event: AnyEvent; args: Record<string, unknown>; context: unknown }>();
  private readonly fails = new Map<string, TestFailure>();
  private finished = false;
  private n = 0;
  private readonly wakePath: boolean;

  /** As on a real call: true once a subscribe holds a subscription (a native call: once one answered native), unless the call was made with wakes: false. */
  get wakes(): boolean {
    return this.wakePath && !this.subscribeFailed && (this.native ? this.nativeHeld.size > 0 : this.live.size > 0);
  }
  private readonly nativeHeld = new Set<string>();
  private subscribeFailed = false;
  private readonly limit: number | undefined;
  #callLimit: number | undefined;

  /** As on a real call: the callLimit option once a subscribe made or renewed a subscription; undefined before, and for a native call. */
  get callLimit(): number | undefined {
    return this.#callLimit;
  }

  /** As on a real call: true only when wakes is true and seconds reaches callLimit. */
  shouldSkipWait(seconds: number | undefined): boolean {
    return skipsWait(this.wakes, this.#callLimit, seconds);
  }

  constructor(opts: TestToolCallOptions<C> = {}) {
    this.wakePath = opts.wakes ?? true;
    this.limit = callLimitOf(opts.callLimit);
    this.tool = opts.tool ?? "test_tool";
    this.user = opts.user;
    this.native = !!opts.native;
    this.ctx = opts.ctx as C;
    this.events = opts.events;
    this.client = opts.client;
    Object.defineProperty(this, "client", { enumerable: false });
  }

  /** Makes this call's next subscribe or unsubscribe fail, as TestClient.failNext does: "unreachable" or "refused". Once. */
  failNext(op: "subscribe" | "unsubscribe", error: TestFailure): void {
    checkFailure(op, error);
    this.fails.set(op, error);
  }

  private failure(op: "subscribe" | "unsubscribe"): void {
    const f = this.fails.get(op);
    if (!f) return;
    this.fails.delete(op);
    throw failureError(f);
  }

  async subscribe<Ev extends AnyEvent>(event: Ev, args: EventArgs<Ev>, opts: SubscribeOptions = {}): Promise<Subscription> {
    if (this.events && !this.events.includes(event)) throw new UsageError("undeclared_subscribe", `${this.tool} subscribed to ${event.name}, which isn't in its subscribes`);
    const parsed = event.parseArgs(args) as Record<string, unknown>;
    subscribeBody(opts);
    try {
      this.failure("subscribe");
    } catch (err) {
      this.subscribeFailed = true; // as on a real call: any failed subscribe makes wakes false
      throw err;
    }
    this.subscriptions.push({ event: event.name, args: parsed, options: { ...opts } });
    if (this.native) {
      if (this.client && event.access === "tools") {
        // A ChatGPT-shaped call: its result hands out a voucher, remembered with the context.
        const core = CORES.get(this.client)!;
        const voucher = core.mint(event.name, parsed, this.tool, this.user, !!opts.once);
        rememberVouchers(this.client, voucherLine(event.name, parsed, voucher), [{ name: event.name, arguments: parsed, context: opts.context }]);
        this.vouchers.push({ event: event.name, args: parsed, voucher });
      }
      this.nativeHeld.add(key(event.name, parsed));
      return { state: "native", user: this.user ?? "", recognized: RECOGNIZED };
    }
    if (event.personal && !this.user) throw new UsageError("bad_arguments", `${event.name} is personal: call.subscribe needs a user (attach's identify), who the subscription belongs to`);
    const k = key(event.name, parsed);
    const known = this.live.get(k);
    const id = known ?? `sub_test_${++this.n}`;
    this.live.set(k, id);
    const c = this.created.get(k);
    if (!known) this.created.set(k, { event, args: parsed, context: opts.context });
    else if (c) c.context = opts.context;
    this.session = TEST_SESSION;
    this.recognized = RECOGNIZED;
    this.#callLimit = this.limit;
    return made(known ? "renewed" : "created", id, this.user ?? "", TEST_SESSION, RECOGNIZED);
  }

  async unsubscribe<A extends AnySchema>(event: WakeEvent<string, A, any, any>, args: SchemaInput<A>): Promise<boolean> {
    const parsed = event.parseArgs(args) as Record<string, unknown>;
    this.failure("unsubscribe");
    this.unsubscribes.push({ event: event.name, args: parsed, options: {} });
    this.created.delete(key(event.name, parsed));
    this.nativeHeld.delete(key(event.name, parsed));
    return this.live.delete(key(event.name, parsed));
  }

  /**
   * The call succeeded: runs each event's onSubscribe for the subscriptions
   * the call created and still holds (via "tool", this tool, its user and
   * the subscribe's context), as the SDK does after a tool returns, and
   * waits for them. withCall runs it when its function resolves. Once.
   */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const owners = new Set<Wakeshift>();
    for (const [k, c] of this.created) {
      if (!this.live.has(k)) continue;
      c.event.subscribed(c.context === undefined ? { args: c.args, user: this.user, via: "tool", tool: this.tool } : { args: c.args, user: this.user, via: "tool", tool: this.tool, context: c.context });
      owners.add(c.event.owner());
    }
    for (const w of owners) await onSubscribeSettled(w);
  }

  async resolveSession(): Promise<string | null> {
    this.session = TEST_SESSION;
    this.recognized = RECOGNIZED;
    return TEST_SESSION;
  }
}

/** A stand-in ToolCall for unit tests (TestToolCall). */
export function createToolCall<C = unknown>(opts: TestToolCallOptions<C> = {}): TestToolCall<C> {
  return new TestToolCall<C>(opts);
}

/**
 * Runs fn with call as what wake.currentCall() returns, inside fn's whole
 * async chain: for tools named in attach's wrap, whose handlers find their
 * call themselves. Returns what fn returns.
 */
export function withCall<R>(wake: Wakeshift, call: TestToolCall<any>, fn: () => R): R {
  const out = runWithTestCall(wake, call, fn);
  // A function that resolves: the call succeeded, so onSubscribe runs (finish).
  if (out && typeof (out as { then?: unknown }).then === "function") {
    return (out as unknown as Promise<unknown>).then(async (v) => {
      await call.finish();
      return v;
    }) as R;
  }
  return out;
}
