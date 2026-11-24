// MCP Events push (SEP-3415 events/stream), served by attach as a relay.
// The client holds an events/stream request
// open on the vendor's server; the SDK opens one upstream stream to
// Wakeshift for it (POST /api/apps/v1/events/stream, NDJSON) and writes each
// frame to the client as a notification related to the request, stamped
// with the request's ID. Wakeshift keeps the subscription, its queue,
// cursors, heartbeats, consent and limits; the SDK keeps nothing that has to
// outlive the request:
//
//   - the client's abort ends the upstream, and gets no result; an explicit
//     cancel over stdio (notifications/cancelled) also ends the
//     subscription (POST /events/stream/end);
//   - Wakeshift ending the stream (terminated, close) ends the client's,
//     with the final result, and so does an upstream silent for three
//     heartbeat intervals, the app's maxStreamMs passing, or identify and
//     authorize failing (not refusing) for maxUncheckedMs: the client
//     reconnects with its cursor;
//   - the upstream has no client-wide timeout, no retries and no breaker:
//     a stream that fails to open answers the client with an error, and the
//     client retries;
//   - frames, cursors, arguments and vouchers are never logged.

import { RpcError } from "./mcp.js";
import { APIError } from "./errors.js";
import { INTERNAL_ERROR, INVALID_PARAMS, RESULT_TYPE, STREAM_REFUSAL, SUBSCRIPTION_ID_META, type Codes } from "./spec.js";
import { UsageError } from "./errors.js";
import { fill, rpcErrorOf } from "./events.js";
import type { Host, Req } from "./host.js";
import type { Wakeshift } from "./wakeshift.js";

/**
 * attach's push option: false serves no push (events/stream answers
 * Unsupported, and events/list doesn't list it), for a host that can't hold
 * a response open or drops notifications sent before the result. An object
 * tunes it for the host: maxStreamMs ends each stream gracefully before the
 * host's request duration cap (the client reconnects with its cursor);
 * maxHeartbeatMs asks Wakeshift for heartbeats at least this often, under a
 * load balancer's idle timeout (Wakeshift grants between 10 and 45 seconds);
 * reauthorizeMs is how often an open stream asks identify and the event's
 * authorize again (default 5 minutes, between 1 and 50 minutes): a refusal
 * ends the stream.
 */
export type PushOptions = false | { maxStreamMs?: number; maxHeartbeatMs?: number; reauthorizeMs?: number };

/** @internal attach's push option, read: off, or on with its limits. */
export interface PushConfig {
  on: boolean;
  maxStreamMs?: number;
  maxHeartbeatMs?: number;
  /** How often an open stream asks identify and authorize again (on only). */
  reauthorizeMs?: number;
}

/** @internal reauthorizeMs's default and bounds: never longer than the core's 50-minute stream age. */
export const REAUTHORIZE_MS = { default: 300_000, min: 60_000, max: 3_000_000 } as const;

/**
 * @internal How long an open stream goes on while identify or authorize
 * fail (an error, not a refusal) at its rechecks: once its last successful
 * check (or its open) is this old, a failed recheck ends it with the final
 * result, and the client reconnects with its cursor (retrying while the
 * checks fail: CHECK_FAILED). 15 minutes: three failed rechecks at the default interval.
 */
export const MAX_UNCHECKED_MS = 15 * 60_000;

/**
 * @internal The bound for a stream rechecked every reauthorizeMs: at least
 * MAX_UNCHECKED_MS, and at least three intervals, so a longer interval
 * still allows three failed rechecks. Over about 17 minutes the core's
 * 50-minute stream age ends the stream first.
 */
export function maxUncheckedMs(reauthorizeMs: number): number {
  return Math.max(MAX_UNCHECKED_MS, 3 * reauthorizeMs);
}

const PUSH_KEYS = ["maxStreamMs", "maxHeartbeatMs", "reauthorizeMs"];

// Where the SDK can tell it runs on a host with a request duration cap, each
// stream ends this long after it opened, under the cap.
const HOST_MAX_STREAM_MS: [env: string, ms: number, host: string][] = [
  ["VERCEL", 280_000, "Vercel"],
  ["AWS_LAMBDA_FUNCTION_NAME", 14 * 60_000, "AWS Lambda"],
  ["K_SERVICE", 55 * 60_000, "Cloud Run"],
];

/** @internal attach's push option, checked, with maxStreamMs defaulted by the host it runs on (env). */
export function pushConfig(wake: Wakeshift, push: unknown, env: Record<string, string | undefined> = process.env, what = "attach"): PushConfig {
  if (push === false) return { on: false };
  if (push !== undefined && (!push || typeof push !== "object" || Array.isArray(push))) {
    throw new UsageError("config", `${what}'s push is false (no push), or { maxStreamMs, maxHeartbeatMs, reauthorizeMs }`);
  }
  const o = (push ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!PUSH_KEYS.includes(k)) throw new UsageError("config", `${what}'s push has no ${k}: its keys are maxStreamMs, maxHeartbeatMs and reauthorizeMs`);
    const v = o[k];
    if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v > 0)) throw new UsageError("config", `${what}'s push.${k} is a whole number of milliseconds over 0`);
  }
  const re = (o.reauthorizeMs as number | undefined) ?? REAUTHORIZE_MS.default;
  const out: PushConfig = { on: true, reauthorizeMs: Math.min(REAUTHORIZE_MS.max, Math.max(REAUTHORIZE_MS.min, re)) };
  if (o.maxHeartbeatMs !== undefined) out.maxHeartbeatMs = o.maxHeartbeatMs as number;
  if (o.maxStreamMs !== undefined) out.maxStreamMs = o.maxStreamMs as number;
  else {
    const found = HOST_MAX_STREAM_MS.find(([k]) => !!env[k]);
    if (found) {
      out.maxStreamMs = found[1];
      wake.log.log("push_max_stream", `this server runs on ${found[2]}, so each events/stream ends after ${found[1] / 1000} seconds and its client reconnects`);
    }
  }
  return out;
}

/**
 * @internal Whether the server's transport answers a request with a stream
 * (SSE, or stdio), so notifications sent before the result reach the
 * client: not the MCP SDK 1.x's enableJsonResponse, nor 2.x's responseMode
 * "json", which drop them. Read from the transport the server is connected
 * to now (a server made per request has its own).
 */
export function transportStreams(host: Host): boolean {
  const low = (host.server as unknown as { server?: unknown }).server ?? host.server;
  let t: Record<string, unknown> | undefined;
  try {
    t = (low as { transport?: Record<string, unknown> } | undefined)?.transport;
  } catch {
    return true;
  }
  if (!t || typeof t !== "object") return true;
  const inner = (t._webStandardTransport && typeof t._webStandardTransport === "object" ? t._webStandardTransport : t) as Record<string, unknown>;
  if (inner._enableJsonResponse === true || t._enableJsonResponse === true) return false;
  if (inner._responseMode === "json" || t._responseMode === "json") return false;
  return true;
}

/**
 * @internal Turns off the host transport's SSE keep-alive comments (": keepalive")
 * for an events/stream, where the transport is this request's alone: the MCP
 * SDK 2.x's per-request transport (createMcpHandler), which arms them when
 * the response becomes a stream. A transport shared by a session's requests
 * (1.x, 2.x's Streamable HTTP with sessions) arms them per response before
 * the handler runs and keeps no handle to them: those stay.
 */
export function quietKeepAlive(host: Host | undefined, id: string | number): void {
  if (!host) return;
  try {
    const low = (host.server as unknown as { server?: unknown }).server ?? host.server;
    const t = (low as { transport?: Record<string, any> } | undefined)?.transport;
    if (!t || typeof t !== "object" || !("_responseMode" in t) || t._requestId !== id) return;
    t._keepAliveMs = 0;
    if (t._sse?.keepAliveTimer !== undefined) {
      clearInterval(t._sse.keepAliveTimer);
      t._sse.keepAliveTimer = undefined;
    }
  } catch {
    // a transport shaped otherwise: its keep-alives stay
  }
}

// The events/stream requests a web-standard transport (headerMismatchAs400's
// hook) is answering, by transport and request ID: aborted when the client
// cancels the response's stream.
const answering = new WeakMap<object, Map<string | number, AbortController>>();

/** @internal The transport a server is connected to now, as headerMismatchAs400 hooks it (the Node one's web-standard transport inside). */
export function hookedTransport(host: Host | undefined): object | undefined {
  try {
    const low = (host?.server as unknown as { server?: unknown } | undefined)?.server ?? host?.server;
    const t = (low as { transport?: Record<string, unknown> } | undefined)?.transport;
    if (!t || typeof t !== "object") return undefined;
    const inner = t._webStandardTransport;
    return inner && typeof inner === "object" ? inner : t;
  } catch {
    return undefined;
  }
}

/** @internal The signal that aborts when the client cancels the response stream of the events/stream request id on the host's transport, where the hook answers it. */
export function responseCancelled(host: Host | undefined, id: string | number): AbortSignal | undefined {
  const t = hookedTransport(host);
  return t ? answering.get(t)?.get(id)?.signal : undefined;
}

// A frame that's an SSE comment and nothing else (": keepalive\n\n").
const COMMENT_FRAME = /^(?::[^\n]*\n)+\n$/;

/** @internal An events/stream request the hook (headerMismatchAs400) is answering on a web-standard transport. */
export interface Answering {
  /** The client cancelled the response's stream: the relay ends. */
  cancel(): void;
  /** The request is answered: dropped from the transport's list. */
  forget(): void;
}

/** @internal Registers an events/stream request the hook is about to answer, before its handler runs, so the relay finds its signal (responseCancelled). */
export function answeringStream(transport: object, id: string | number): Answering {
  let open = answering.get(transport);
  if (!open) answering.set(transport, (open = new Map()));
  const list = open;
  const ctl = new AbortController();
  list.set(id, ctl);
  return {
    cancel: () => ctl.abort(new Error("client")),
    forget: () => {
      if (list.get(id) === ctl) list.delete(id);
    },
  };
}

/**
 * @internal An events/stream's SSE response, as the hook answers it on a web-standard transport whose keep-alive
 * comments it can't turn off (the MCP SDK 1.x's, 2.x's with sessions): their comment-only frames left out, since
 * SEP-3415's heartbeats are data frames and "the SSE comment form is not used". The client cancelling it (a dropped
 * connection) ends the relay at once (a.cancel): 1.x only forgets the stream, and the relay would otherwise learn it at
 * its next write. Anything but an SSE response is returned as it is.
 */
export function pushResponse(res: Response, a: Answering): Response {
  if (!res.body || !(res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    a.forget();
    return res;
  }
  const reader = res.body.getReader();
  const text = new TextDecoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(out) {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          a.forget();
          out.error(err);
          return;
        }
        if (chunk.done) {
          a.forget();
          out.close();
          return;
        }
        if (COMMENT_FRAME.test(text.decode(chunk.value))) continue;
        out.enqueue(chunk.value);
        return;
      }
    },
    cancel(reason) {
      a.cancel();
      a.forget();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

const cancelsOf = new WeakMap<object, Map<string | number, { cancelled: boolean }>>();

/** @internal One stream's explicit-cancel watch (watchCancels). */
export interface CancelWatch {
  /** The client cancelled this request explicitly (notifications/cancelled). */
  readonly cancelled: boolean;
  /** The stream is done: the watch is dropped. */
  done(): void;
}

/** @internal Watches the requests in flight for an explicit cancel: track(id) while a stream is open. */
export type CancelWatcher = (id: string | number | undefined) => CancelWatch;

const NO_CANCEL: CancelWatch = { cancelled: false, done: () => undefined };

/**
 * @internal Tells an explicit cancel (notifications/cancelled), which a
 * dropped connection never is, on either MCP SDK: their protocol layer's
 * _oncancel, wrapped on the instance. Only a stream open now is marked, and
 * its mark goes with it, so a request ID reused later is never taken for one
 * cancelled before.
 */
export function watchCancels(host: Host): CancelWatcher {
  const low = ((host.server as unknown as { server?: unknown }).server ?? host.server) as { _oncancel?: (n: unknown) => unknown } | undefined;
  if (!low || typeof low !== "object" || typeof low._oncancel !== "function") return () => NO_CANCEL;
  let live = cancelsOf.get(low);
  if (!live) {
    const open = new Map<string | number, { cancelled: boolean }>();
    live = open;
    cancelsOf.set(low, open);
    const inner = low._oncancel;
    low._oncancel = function (this: unknown, n: unknown) {
      const id = (n as { params?: { requestId?: unknown } } | undefined)?.params?.requestId;
      if (typeof id === "string" || typeof id === "number") {
        const w = open.get(id);
        if (w) w.cancelled = true;
      }
      return inner.call(this, n);
    };
  }
  const open = live;
  return (id) => {
    if (id === undefined) return NO_CANCEL;
    const w: CancelWatch & { cancelled: boolean } = {
      cancelled: false,
      done: () => {
        if (open.get(id) === w) open.delete(id);
      },
    };
    open.set(id, w);
    return w;
  };
}

/** @internal What events/stream relays for one request: everything already checked. */
export interface PushRun {
  wake: Wakeshift;
  event: string;
  args: unknown;
  /** The call as Wakeshift takes it (poll's). */
  call: Record<string, unknown>;
  voucher: string | undefined;
  cursor: string | null;
  maxAgeMs: number | null;
  /** The client's heartbeatMs, if it suggested one. */
  heartbeatMs: number | null;
  codes: Codes;
  req: Req;
  /** The server's host, for its transport. */
  host?: Host;
  config: PushConfig;
  /** Watches the request for an explicit cancel (notifications/cancelled). */
  cancels: CancelWatcher;
  /** The first active frame said the stream created its subscription. */
  onCreated(frame: Record<string, unknown>): void;
  /** Asks identify and authorize again for the open stream: true, false (refused: the stream ends), or "error" (it goes on). */
  reauthorize?(): Promise<boolean | "error">;
}

/**
 * @internal What an events/stream gets when identify or authorize failed
 * (threw, rejected or timed out) as it opened, which reconnects do: a
 * retryable error (Internal error, as when Wakeshift can't be reached),
 * never Forbidden, which tells the client to stop. The client retries, and
 * the stream opens once the app's check answers. A refusal is still
 * Forbidden.
 */
export const CHECK_FAILED = "this app couldn't check access to this event just now: try again shortly";

/** @internal events/stream's retryable error (-32603) when Wakeshift is at its stream limit (a 503), after its Retry-After. */
export const STREAM_BUSY = "Wakeshift can't open this stream just now: try again shortly";

/** @internal events/stream's retryable error (-32603) when Wakeshift can't be reached, or its stream ended before it opened. */
export const UNREACHABLE = "Wakeshift couldn't be reached";

/** @internal The retryable error for an events/stream whose identify or authorize failed as it opened (CHECK_FAILED), logged as push_open_check_failed with the event's name only. */
export function checkFailed(wake: Wakeshift, event: string): RpcError {
  wake.log.log("push_open_check_failed", `identify or authorize failed when an events/stream of ${event} opened, so the client was answered with a retryable error`, { event });
  return new RpcError(INTERNAL_ERROR, CHECK_FAILED);
}

/** @internal The terminated notification's error (before its code) when the open stream's reauthorization refuses: as a revocation. */
export function reauthorizeRefusal(event: string): { message: string; data: Record<string, unknown> } {
  return { message: fill("native_refused", { event }), data: { reason: "revoked" } };
}


// Before the first active frame says what Wakeshift granted, the grant is
// the spec's default.
const DEFAULT_HEARTBEAT_MS = 30_000;
// The longest line read from the upstream: an occurrence is at most 256 KiB.
const MAX_LINE = 1024 * 1024;

type Ending = "client" | "silent" | "max_stream" | "unchecked" | "notify_failed" | "revoked";

/**
 * @internal Serves one events/stream: opens the upstream and relays it until
 * either end closes. Resolves with the final result when Wakeshift (or the
 * SDK, for silence or maxStreamMs) ends the stream; after the client's
 * abort its result goes nowhere. Throws the client's JSON-RPC error when the
 * upstream refuses before it opens.
 */
export async function relayPush(r: PushRun): Promise<Record<string, unknown>> {
  const { wake, req } = r;
  const id = req.id!;
  // The stream's open, where identify and authorize allowed it.
  let checkedAt = Date.now();
  const notify = req.notify!;
  const meta = (more?: Record<string, unknown>) => ({ ...(more ?? {}), [SUBSCRIPTION_ID_META]: id });
  // The final result (StreamEventsResult): Wakeshift ended the stream, and
  // the client reconnects with its cursor (or, after terminated, stops). It
  // carries the subscription ID too.
  const STREAM_RESULT = { resultType: RESULT_TYPE, _meta: meta() };
  // The host's own SSE keep-alive comments aren't heartbeats: off where the
  // transport is this request's alone.
  quietKeepAlive(r.host, id);
  const ctl = new AbortController();
  let ending: Ending | undefined;
  const end = (why: Ending) => {
    ending ??= why;
    ctl.abort(new Error(why));
  };
  const cancel = r.cancels(id);
  let explicitCancel = false;
  const onClientAbort = () => {
    explicitCancel = cancel.cancelled;
    end("client");
  };
  const clientSignal = req.signal;
  if (clientSignal?.aborted) onClientAbort();
  else clientSignal?.addEventListener("abort", onClientAbort, { once: true });
  // Where the hook answers the request (pushResponse), the client cancelling
  // the response's stream, which the MCP SDK 1.x doesn't pass on.
  const responseSignal = responseCancelled(r.host, id);
  if (responseSignal?.aborted) onClientAbort();
  else responseSignal?.addEventListener("abort", onClientAbort, { once: true });
  // Whether notifications/events/active went out: until it has, the stream
  // can only end with an error (SEP-3415: an immediate error, or active
  // first), never the final result.
  let opened = false;
  const finished = (): Record<string, unknown> => {
    if (!opened && ending !== "client") throw new RpcError(INTERNAL_ERROR, UNREACHABLE);
    return STREAM_RESULT;
  };

  // The heartbeat asked for: the client's suggestion, at most the app's maxHeartbeatMs.
  const asked = r.config.maxHeartbeatMs !== undefined ? Math.min(r.heartbeatMs ?? Infinity, r.config.maxHeartbeatMs) : r.heartbeatMs;
  const body: Record<string, unknown> = {
    call: r.call,
    name: r.event,
    arguments: r.args,
    cursor: r.cursor,
    max_age_ms: r.maxAgeMs,
    heartbeat_ms: asked,
  };
  if (r.voucher !== undefined) body.voucher = r.voucher;

  let cursor: string | null = r.cursor;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let recheck: ReturnType<typeof setInterval> | undefined;
  let grant = asked ?? DEFAULT_HEARTBEAT_MS;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => end("silent"), 3 * grant);
  };
  try {
    let resp: Response;
    try {
      resp = await wake.openStream("/events/stream", body, ctl.signal);
    } catch (err) {
      if (ending) return finished();
      upstreamFailed(wake, "unreachable");
      throw new RpcError(INTERNAL_ERROR, UNREACHABLE);
    }
    if (resp.status === 503) {
      // The core is at its stream limit: after Retry-After (at most 10
      // seconds) and up to a second of jitter, so reconnects don't loop
      // straight back into a full instance, the client gets a retryable
      // error (the stream never opened).
      await resp.body?.cancel().catch(() => undefined);
      await pause(retryAfterMs(resp.headers.get("retry-after")) + Math.random() * MAX_JITTER_MS, ctl.signal);
      if (ending) return finished();
      throw new RpcError(INTERNAL_ERROR, STREAM_BUSY);
    }
    if (!resp.ok) {
      let text = "";
      try {
        text = await resp.text();
      } catch {
        // no body: the status alone
      }
      throw refusalOf(resp.status, text, r.codes, r.event, wake);
    }
    if (!resp.body) {
      upstreamFailed(wake, "ended");
      return finished();
    }
    arm();
    if (r.config.maxStreamMs !== undefined) lifetime = setTimeout(() => end("max_stream"), r.config.maxStreamMs);
    if (r.reauthorize && r.config.reauthorizeMs) {
      // Access is asked again while the stream is open, one check at a time.
      // A failing check (an error, not a refusal) keeps the stream, until
      // the last successful one is maxUncheckedMs old: then the stream ends
      // for its client to reconnect, as maxStreamMs ends it.
      const limit = maxUncheckedMs(r.config.reauthorizeMs);
      const failed = () => {
        if (ending) return;
        wake.log.log("push_recheck_failed", `identify or authorize failed when an open events/stream of ${r.event} was checked again, so the stream goes on`, { event: r.event });
        if (Date.now() - checkedAt >= limit) {
          wake.log.log(
            "push_recheck_stale",
            `an open events/stream of ${r.event} went ${Math.round(limit / 60_000)} minutes without a successful check of identify and authorize, so it was ended for its client to reconnect`,
            { event: r.event },
          );
          end("unchecked");
        }
      };
      let checking = false;
      recheck = setInterval(() => {
        if (checking || ending) return;
        checking = true;
        const started = Date.now();
        void r
          .reauthorize!()
          .then(
            (ok) => {
              if (ok === false) end("revoked");
              else if (ok === true) checkedAt = started;
              else failed();
            },
            () => failed(),
          )
          .finally(() => (checking = false));
      }, r.config.reauthorizeMs);
    }
    let first = true;
    for await (const line of lines(resp.body, ctl.signal)) {
      arm();
      let frame: Record<string, any>;
      try {
        frame = JSON.parse(line);
      } catch {
        frame = {};
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) frame = {};
      const send = async (method: string, params: Record<string, unknown>) => {
        try {
          await notify({ method, params });
        } catch {
          end("notify_failed");
          throw ctl.signal.reason;
        }
      };
      switch (frame.type) {
        case "active": {
          if (typeof frame.heartbeat_ms === "number" && frame.heartbeat_ms > 0) {
            grant = frame.heartbeat_ms;
            arm();
          }
          if (typeof frame.cursor === "string") cursor = frame.cursor;
          if (first && frame.created === true) r.onCreated(frame);
          first = false;
          const params: Record<string, unknown> = { cursor: frame.cursor ?? null, truncated: !!frame.truncated };
          if (typeof frame.heartbeat_ms === "number") params.heartbeatMs = frame.heartbeat_ms;
          await send("notifications/events/active", { ...params, _meta: meta() });
          opened = true;
          break;
        }
        case "event": {
          const o = frame.occurrence && typeof frame.occurrence === "object" ? (frame.occurrence as Record<string, unknown>) : {};
          if (typeof o.cursor === "string") cursor = o.cursor;
          const own = o._meta && typeof o._meta === "object" && !Array.isArray(o._meta) ? (o._meta as Record<string, unknown>) : undefined;
          await send("notifications/events/event", { ...o, _meta: meta(own) });
          break;
        }
        case "heartbeat":
          if (typeof frame.cursor === "string") cursor = frame.cursor;
          await send("notifications/events/heartbeat", { cursor: frame.cursor ?? cursor, _meta: meta() });
          break;
        case "terminated": {
          const e = frame.error && typeof frame.error === "object" ? (frame.error as Record<string, unknown>) : {};
          const error: Record<string, unknown> = { code: terminatedCode(e.name, r.codes), message: typeof e.message === "string" ? e.message : "" };
          if (e.data !== undefined) error.data = e.data;
          // Before active, the stream never opened: the error is the answer.
          if (!opened) throw new RpcError(error.code as number, error.message as string, error.data);
          await send("notifications/events/terminated", { error, _meta: meta() });
          return STREAM_RESULT;
        }
        case "close":
          return finished();
        default:
          // A frame this SDK doesn't know: skipped, so a newer core can add one.
          break;
      }
    }
    // The upstream ended without close: the client reconnects with its cursor.
    if (!ending) upstreamFailed(wake, "ended");
    return finished();
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (ending === "revoked") {
      // As a revocation: terminated (Forbidden), then the final result. The
      // core's subscription stays: a reconnect asks again, and is refused.
      const refusal = reauthorizeRefusal(r.event);
      if (!opened) throw new RpcError(r.codes.forbidden, refusal.message, refusal.data);
      try {
        await notify({ method: "notifications/events/terminated", params: { error: { code: r.codes.forbidden, ...refusal }, _meta: meta() } });
      } catch {
        // the client is gone: nothing to tell it
      }
      return STREAM_RESULT;
    }
    if (ending === "client") {
      // An explicit cancel ends the subscription; over HTTP an abort can't
      // be told from a dropped connection, so the subscription lapses.
      if (explicitCancel && !req.http && cursor !== null) await endSubscription(r, cursor);
      return STREAM_RESULT;
    }
    if (ending === "silent" || !ending) upstreamFailed(wake, ending ?? "broken");
    return finished();
  } finally {
    clearTimeout(watchdog);
    clearTimeout(lifetime);
    clearInterval(recheck);
    clientSignal?.removeEventListener("abort", onClientAbort);
    responseSignal?.removeEventListener("abort", onClientAbort);
    cancel.done();
    if (!ctl.signal.aborted) ctl.abort(new Error("done"));
  }
}

// upstreamFailed logs push_upstream_failed with its category (reason), nothing else.
function upstreamFailed(wake: Wakeshift, reason: string): void {
  wake.log.log("push_upstream_failed", `an events/stream's upstream to Wakeshift failed (${reason})`, { reason });
}

// endSubscription ends the stream's subscription after the client's explicit
// cancel (stdio): the core audits it as unsubscribed.
async function endSubscription(r: PushRun, cursor: string): Promise<void> {
  try {
    await r.wake.requestApp("POST", "/events/stream/end", { call: r.call, name: r.event, arguments: r.args, cursor }, { maxRetries: 0 });
  } catch {
    upstreamFailed(r.wake, "end_failed");
  }
}

// terminatedCode is a terminated frame's error name as the client's dialect's code.
function terminatedCode(name: unknown, codes: Codes): number {
  switch (name) {
    case "Forbidden":
      return codes.forbidden;
    case "NotFound":
      return codes.notFound;
    case "Unsupported":
      return codes.unsupported;
    case "ResourceExhausted":
      return codes.resourceExhausted;
    case "InvalidParams":
      return INVALID_PARAMS;
  }
  return INTERNAL_ERROR;
}

/**
 * @internal The client's JSON-RPC error for Wakeshift refusing an
 * events/stream before it opens (status and body), in the client's
 * dialect's codes, as events/poll maps them, with the limits' data.
 */
export function refusalOf(status: number, text: string, codes: Codes, event: string, wake?: Wakeshift): RpcError {
  let e: Record<string, unknown> = {};
  try {
    const json = JSON.parse(text);
    if (json?.error && typeof json.error === "object" && !Array.isArray(json.error)) e = json.error;
  } catch {
    // not JSON: the status alone
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const code = str(e.code);
  // Never the body itself when it isn't Wakeshift's JSON (a proxy's page).
  const message = str(e.message) || "push upstream failed";
  const max = typeof e.max === "number" ? e.max : undefined;
  switch (code) {
    case "not_found":
    case "unknown_event":
      return new RpcError(codes.notFound, message || fill("native_unknown_event", { event: JSON.stringify(event) }), { kind: "event" });
    case "tools_only":
      return new RpcError(codes.forbidden, fill("native_tools_only", { event }));
    case "subscription_limit":
    case "stream_limit": {
      const limit = code === "stream_limit" || e.limit === "streams" ? "streams" : "subscriptions";
      return new RpcError(codes.resourceExhausted, message, max === undefined ? { limit } : { limit, max });
    }
    case "unsupported":
      return new RpcError(codes.unsupported, STREAM_REFUSAL, { feature: "deliveryMode", value: "push" });
  }
  if (code === "" && status >= 500) {
    if (wake) upstreamFailed(wake, "status");
    return new RpcError(INTERNAL_ERROR, "Wakeshift couldn't be reached");
  }
  return rpcErrorOf(new APIError({ status, code, message, reason: str(e.reason) || undefined }), codes, event);
}

// The most a 503's Retry-After holds a client's stream, and the jitter added to it.
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_JITTER_MS = 1_000;

/** @internal A Retry-After header (seconds, or an HTTP date) in milliseconds, at most 10 seconds; 0 without a usable one. */
export function retryAfterMs(h: string | null, now = Date.now()): number {
  if (!h) return 0;
  const v = h.trim();
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : 0;
}

/** @internal Waits ms, or until signal aborts (a 503's wait ends with the client's abort). */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

// lines reads an NDJSON body one line at a time, until it ends or signal
// aborts (whether or not the body follows the signal itself).
async function* lines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let aborted: Promise<never> | undefined;
  const stop = () =>
    (aborted ??= new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
  stop().catch(() => undefined);
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stop()]);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) yield line;
      }
      if (buf.length > MAX_LINE) throw new Error("line too long");
    }
    buf += decoder.decode();
    if (buf.trim()) yield buf.trim();
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
