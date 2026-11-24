// MCP Events push (events/stream) through attach,
// against a fake core's upstream, on the MCP SDK 1.x and 2.x: their
// session transports (in memory, as stdio is: no HTTP) and their stateless
// HTTP endpoints (1.x's web-standard Streamable HTTP transport without
// sessions, 2.x's createMcpHandler), with the shared push cases of
// test/mcp-events-wire.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer as V1McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport as V1Memory } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport as V1WebHttp } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as v2server from "@modelcontextprotocol/server";
import { z } from "zod";
import { Wakeshift } from "../src/index.js";
import { createTestClient } from "../src/testing.js";
import { CHECK_FAILED, MAX_UNCHECKED_MS, maxUncheckedMs, pause, pushConfig, retryAfterMs } from "../src/push.js";
import { captureLog } from "./logs.js";

const KEY = "wst_1116qJFWMMHFy3xDdLmvUeyc2S6FrWRhJP51HsvDYdz9fWXzSV";
const SUB = "io.modelcontextprotocol/subscriptionId";
const EXT = "io.modelcontextprotocol/events";
const g = JSON.parse(readFileSync(new URL("../../test/mcp-events-wire.json", import.meta.url), "utf8")).push;
const SDKS = ["1.x", "2.x"] as const;
type Sdk = (typeof SDKS)[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// performance.now, not Date.now: some tests mock Date.
async function until(pred: () => boolean, ms = 3000, what = "the condition"): Promise<void> {
  const end = performance.now() + ms;
  while (!pred()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ── The fake core ───────────────────────────────────────────────────────

/** One upstream stream the fake core holds: the test writes frames to it. */
interface Upstream {
  body: any;
  aborted: boolean;
  write(frame: unknown): void;
  end(): void;
}

interface CoreOptions {
  features?: string[];
  /** How the core answers an events/stream: frames (then the body ends), a refusal, or held open for the test (undefined). */
  stream?: (body: any) => { frames: unknown[] } | { status: number; error: unknown; headers?: Record<string, string>; raw?: string } | undefined;
  replies?: Record<string, (body: any) => unknown>;
}

function fakeCore(opts: CoreOptions = {}) {
  const reqs: { path: string; body: any }[] = [];
  const upstreams: Upstream[] = [];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://core.test/api/apps/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    reqs.push({ path, body });
    if (path.startsWith("/manifest")) return json({ features: opts.features ?? ["subscribe_vouchers", "push"] });
    if (path === "/app") return json({ id: "next", name: "Next" });
    if (path === "/events/stream") {
      const how = opts.stream?.(body);
      if (how && "status" in how) {
        return new Response(how.raw ?? JSON.stringify(how.error), { status: how.status, headers: { "Content-Type": how.raw ? "text/html" : "application/json", ...how.headers } });
      }
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const enc = new TextEncoder();
      const u: Upstream = {
        body,
        aborted: false,
        write: (f) => {
          try {
            controller.enqueue(enc.encode(JSON.stringify(f) + "\n"));
          } catch {
            // closed
          }
        },
        end: () => {
          try {
            controller.close();
          } catch {
            // closed
          }
        },
      };
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
        cancel: () => {
          u.aborted = true;
        },
      });
      init?.signal?.addEventListener("abort", () => {
        u.aborted = true;
        try {
          controller.error(init.signal!.reason);
        } catch {
          // closed
        }
      });
      upstreams.push(u);
      if (how && "frames" in how) {
        for (const f of how.frames) u.write(f);
        u.end();
      }
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    const r = opts.replies?.[path]?.(body);
    if (r !== undefined) return json(r);
    if (path === "/event-subscriptions") return json({ event_subscription: { id: "sub-1", created: true }, session: "wsc_s1", pending: "pa_1" });
    if (path === "/calls/addition") return json({ text: Array.isArray(body?.native) ? body.native.map((n: any) => `NATIVE ${n.name}`).join("\n") : "BRIDGED block." });
    return json({});
  }) as typeof fetch;
  return { fetchFn, reqs, upstreams, streamReqs: () => reqs.filter((r) => r.path === "/events/stream") };
}

// nextApp is mcp-events-wire.json next's events, on a client with a fake core.
function nextApp(core: ReturnType<typeof fakeCore>) {
  const log = captureLog();
  const wake = new Wakeshift({ key: KEY, core: "https://core.test", fetch: core.fetchFn, logger: log.logger, logLevel: "debug" });
  const events = {
    crawl: wake.defineEvent("crawl.finished", { description: "A crawl finished", args: z.object({ job: z.string() }), payload: z.object({ pages: z.number() }) }),
    chat: wake.defineEvent("chat.message", { description: "A new message", args: z.object({ channel: z.string() }), payload: z.object({ from: z.string(), text: z.string() }), public: true }),
    deploy: wake.defineEvent("deploy.finished", { description: "A deploy finished", args: z.object({ env: z.string() }), payload: z.object({ status: z.string() }), authorize: (s) => s.user === "u1" }),
  };
  return { wake, events, log };
}

function newServer(sdk: Sdk): any {
  return sdk === "1.x" ? new V1McpServer({ name: "next", version: "1.0.0" }) : new v2server.McpServer({ name: "next", version: "1.0.0" });
}

// ── A raw client over an in-memory session (as stdio: no HTTP) ─────────

async function session(sdk: Sdk, server: any, clientName: string, capabilities: Record<string, unknown> = {}) {
  const [a, b] = sdk === "1.x" ? V1Memory.createLinkedPair() : (v2server.InMemoryTransport.createLinkedPair() as unknown as ReturnType<typeof V1Memory.createLinkedPair>);
  const msgs: any[] = [];
  b.onmessage = (m: any) => void msgs.push(m);
  await server.connect(a);
  await b.start();
  const send = (m: unknown) => b.send(m as any);
  await send({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities, clientInfo: { name: clientName, version: "1" } } });
  await until(() => msgs.some((m) => m.id === "init"), 3000, "initialize");
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const responseOf = (id: unknown) => msgs.find((m) => m.id === id && ("result" in m || "error" in m));
  return {
    msgs,
    send,
    request(id: string | number, method: string, params: Record<string, unknown> = {}) {
      void send({ jsonrpc: "2.0", id, method, params });
    },
    async response(id: string | number, ms = 3000): Promise<any> {
      await until(() => !!responseOf(id), ms, `response ${id}`);
      return responseOf(id);
    },
    hasResponse: (id: unknown) => !!responseOf(id),
    notificationsFor: (id: unknown) => msgs.filter((m) => m.method?.startsWith("notifications/events/") && m.params?._meta?.[SUB] === id).map((m) => ({ method: m.method, params: m.params })),
    close: () => b.close(),
  };
}

// ── A stateless HTTP endpoint, a server made per request ───────────────

const as2026 = (client: string, declares = true) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: client, version: "1" },
  "io.modelcontextprotocol/clientCapabilities": declares ? { extensions: { [EXT]: {} } } : {},
});

function statelessEndpoint(sdk: Sdk, make: () => any, json = false) {
  const v2handler = sdk === "2.x" ? v2server.createMcpHandler(() => make(), { onerror: () => {}, ...(json ? { responseMode: "json" as const } : {}) }) : undefined;
  const open: { close(): Promise<void> }[] = [];
  return {
    open,
    async post(id: string | number, method: string, params: Record<string, any>, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
      const h: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        ...headers,
      };
      const req = new Request("http://mcp.test/mcp", { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal });
      if (v2handler) return v2handler.fetch(req);
      const server = make();
      const transport = new V1WebHttp({ sessionIdGenerator: undefined, enableJsonResponse: json });
      await server.connect(transport);
      open.push({ close: () => transport.close() });
      return transport.handleRequest(req);
    },
  };
}

// withoutMeta is a result without the _meta key 2.x adds on 2026-07-28 (serverInfo).
function withoutMeta(r: any): any {
  if (!r || typeof r !== "object" || !r._meta) return r;
  const { "io.modelcontextprotocol/serverInfo": _s, ...meta } = r._meta;
  const { _meta: _m, ...rest } = r;
  return Object.keys(meta).length > 0 ? { ...rest, _meta: meta } : rest;
}

// finalOf is the final result an events/stream with this id ends with.
const finalOf = (id: string | number) => ({ resultType: "complete", _meta: { [SUB]: id } });

// messagesOf reads every JSON-RPC message from an SSE or JSON body.
async function messagesOf(res: Response): Promise<any[]> {
  const text = (await res.text()).trim();
  if (text.startsWith("{")) return [JSON.parse(text)];
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

const events = (ms: any[], id: unknown) => ms.filter((m) => m.method?.startsWith("notifications/events/")).map((m) => ({ method: m.method, params: m.params })).filter((n) => n.params?._meta?.[SUB] === id);

// ── The shared cases (test/mcp-events-wire.json push) ───────────────────

for (const sdk of SDKS) {
  test(`${sdk} session: the push streams of mcp-events-wire.json (notifications, subscription ID, final result, what Wakeshift is asked)`, async () => {
    for (const c of g.streams) {
      const core = fakeCore({ stream: () => ({ frames: c.frames }) });
      const { wake } = nextApp(core);
      const server = newServer(sdk);
      wake.attach(server, { identify: () => (c.user ? { user: c.user } : undefined) });
      const s = await session(sdk, server, "some-draft-client");
      s.request(c.id, "events/stream", c.params);
      const res = await s.response(c.id);
      assert.deepEqual(res.result, c.result, `${c.name}: result`);
      assert.deepEqual(s.notificationsFor(c.id), c.notifications, `${c.name}: notifications`);
      const [{ body }] = core.streamReqs();
      const { call, ...rest } = body;
      assert.deepEqual(rest, c.core_request, `${c.name}: what Wakeshift is asked`);
      assert.equal(call.user ?? null, c.call_user, `${c.name}: the caller`);
      await s.close();
    }
  });

  test(`${sdk} stateless HTTP (2026-07-28): the push streams of mcp-events-wire.json`, async () => {
    for (const c of g.streams) {
      const core = fakeCore({ stream: () => ({ frames: c.frames }) });
      const { wake } = nextApp(core);
      const ep = statelessEndpoint(sdk, () => {
        const server = newServer(sdk);
        wake.attach(server, { identify: () => (c.user ? { user: c.user } : undefined) });
        return server;
      });
      const res = await ep.post(c.id, "events/stream", { ...c.params, _meta: as2026("some-draft-client") });
      assert.equal(res.headers.get("content-type")?.split(";")[0], "text/event-stream", `${c.name}: an SSE response`);
      const ms = await messagesOf(res);
      assert.deepEqual(events(ms, c.id), c.notifications, `${c.name}: notifications`);
      assert.deepEqual(withoutMeta(ms.at(-1)?.result), c.result, `${c.name}: the final result, last`);
      const { call: _call, ...rest } = core.streamReqs()[0]!.body;
      assert.deepEqual(rest, c.core_request, `${c.name}: what Wakeshift is asked`);
      for (const o of ep.open) await o.close();
    }
  });

  test(`${sdk}: a terminated frame's error name is the client's dialect's code (mcp-events-wire.json terminated_codes)`, async () => {
    for (const t of g.terminated_codes) {
      for (const [dialect, client] of [["draft", "some-draft-client"], ["chatgpt", "openai-mcp"]] as const) {
        const core = fakeCore({ stream: () => ({ frames: [{ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 }, { type: "terminated", error: { name: t.name, message: "ended" } }] }) });
        const { wake } = nextApp(core);
        const server = newServer(sdk);
        wake.attach(server, { identify: () => ({ user: "u1" }) });
        const s = await session(sdk, server, client);
        s.request(1, "events/stream", { name: "chat.message", arguments: { channel: "eng" } });
        await s.response(1);
        const term = s.notificationsFor(1).find((n) => n.method === "notifications/events/terminated");
        assert.equal(term?.params.error.code, t.code[dialect], `${t.name} ${dialect}`);
        await s.close();
      }
    }
  });

  test(`${sdk}: refusals before the stream opens (mcp-events-wire.json refused), in both dialects`, async () => {
    for (const c of g.refused) {
      for (const [dialect, client] of [["draft", "some-draft-client"], ["chatgpt", "openai-mcp"]] as const) {
        const core = fakeCore({
          stream: () => (c.core_status ? { status: c.core_status, error: { error: c.core_error }, ...(c.retry_after ? { headers: { "retry-after": String(c.retry_after) } } : {}) } : undefined),
        });
        const started = Date.now();
        const { wake } = nextApp(core);
        const ep = statelessEndpoint(sdk, () => {
          const server = newServer(sdk);
          wake.attach(server, { identify: () => (c.user ? { user: c.user } : undefined) });
          return server;
        });
        const headers: Record<string, string> = c.header ? { "mcp-name": c.header } : {};
        const res = await ep.post(5, "events/stream", { ...c.params, _meta: as2026(client, false) }, { "user-agent": `${client}/1`, ...headers });
        const ms = await messagesOf(res);
        const last = ms.at(-1);
        if (c.min_ms) assert.ok(Date.now() - started >= c.min_ms, `${c.name}: not before Retry-After (${Date.now() - started} ms)`);
        if (c.result) {
          assert.deepEqual(withoutMeta(last?.result), c.result, `${c.name}: the final result`);
          assert.deepEqual(events(ms, 5), [], `${c.name}: no notifications`);
        } else {
          assert.deepEqual(
            { code: last?.error?.code, message: last?.error?.message, data: last?.error?.data ?? null },
            { code: c.error.code[dialect], message: c.error.message, data: c.error.data },
            `${c.name} (${dialect})`,
          );
          if (c.header) assert.equal(res.status, 400, `${c.name}: HTTP 400`);
        }
        assert.equal(core.streamReqs().length, c.core_status ? 1 : 0, `${c.name}: Wakeshift asked for a stream`);
        for (const o of ep.open) await o.close();
      }
    }
  });

  test(`${sdk}: push is listed (and served) only where the core reports it, the transport streams and push isn't off (not_served)`, async () => {
    const list = async (features: string[], push: any, json: boolean, client = "some-draft-client") => {
      const core = fakeCore({ features, stream: () => ({ frames: [{ type: "close" }] }) });
      const { wake } = nextApp(core);
      const ep = statelessEndpoint(
        sdk,
        () => {
          const server = newServer(sdk);
          wake.attach(server, { identify: () => ({ user: "u1" }), ...(push === undefined ? {} : { push }) });
          return server;
        },
        json,
      );
      const listed = (await messagesOf(await ep.post(1, "events/list", { _meta: as2026(client) }))).at(-1).result.events;
      const streamed = (await messagesOf(await ep.post(2, "events/stream", { name: "chat.message", arguments: { channel: "eng" }, _meta: as2026(client) }))).at(-1);
      for (const o of ep.open) await o.close();
      return { listed, streamed, core };
    };
    const on = await list(["subscribe_vouchers", "push"], undefined, false);
    assert.deepEqual(on.listed.find((e: any) => e.name === "chat.message").delivery, g.delivery);
    assert.deepEqual(on.listed.find((e: any) => e.name === "crawl.finished").delivery, g.delivery_tools_only, "a tools-only event, listed with a voucher");
    for (const [why, features, push, json] of [
      ["the core doesn't report push", ["subscribe_vouchers"], undefined, false],
      ["push: false", ["subscribe_vouchers", "push"], false, false],
      ["JSON-response mode", ["subscribe_vouchers", "push"], undefined, true],
    ] as const) {
      const off = await list([...features], push, json);
      assert.deepEqual(off.listed.find((e: any) => e.name === "chat.message").delivery, ["webhook", "poll"], why);
      assert.deepEqual(off.listed.find((e: any) => e.name === "crawl.finished").delivery, ["webhook"], why);
      assert.deepEqual({ code: off.streamed.error?.code, message: off.streamed.error?.message, data: off.streamed.error?.data }, { code: g.not_served.code.draft, message: g.not_served.message, data: g.not_served.data }, why);
      assert.equal(off.core.streamReqs().length, 0, `${why}: no upstream`);
    }
  });

  test(`${sdk} session: two streams on one connection are told apart by subscription ID; cancelling one ends its subscription (stdio) and the other goes on`, async () => {
    const core = fakeCore();
    const { wake } = nextApp(core);
    const server = newServer(sdk);
    wake.attach(server, { identify: () => ({ user: "u1" }) });
    const s = await session(sdk, server, "some-draft-client");
    s.request("a", "events/stream", { name: "chat.message", arguments: { channel: "eng" } });
    s.request(2, "events/stream", { name: "chat.message", arguments: { channel: "ops" } });
    await until(() => core.upstreams.length === 2, 3000, "two upstreams");
    const [ua, ub] = [core.upstreams.find((u) => u.body.arguments.channel === "eng")!, core.upstreams.find((u) => u.body.arguments.channel === "ops")!];
    ua.write({ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 });
    ub.write({ type: "active", cursor: "c2.b.0.m", truncated: false, heartbeat_ms: 30000 });
    ub.write({ type: "event", occurrence: { eventId: "e1", name: "chat.message", timestamp: "2026-10-29T12:00:00Z", data: { from: "a", text: "b" }, cursor: "c2.b.1.m", _meta: {} } });
    await until(() => s.notificationsFor(2).length === 2 && s.notificationsFor("a").length === 1, 3000, "both streams' notifications");
    assert.deepEqual(s.notificationsFor("a").map((n) => n.params.cursor), ["c2.a.0.m"]);
    assert.deepEqual(s.notificationsFor(2).map((n) => n.params.cursor), ["c2.b.0.m", "c2.b.1.m"]);
    // The client cancels "a": its upstream ends, and its subscription with it (an explicit cancel).
    await s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "a", reason: "done" } });
    await until(() => ua.aborted, 3000, "the cancelled upstream to end");
    await until(() => core.reqs.some((r) => r.path === "/events/stream/end"), 3000, "the end call");
    const end = core.reqs.find((r) => r.path === "/events/stream/end")!.body;
    assert.deepEqual({ name: end.name, arguments: end.arguments, cursor: end.cursor, user: end.call.user }, { name: "chat.message", arguments: { channel: "eng" }, cursor: "c2.a.0.m", user: "u1" });
    ua.write({ type: "event", occurrence: { eventId: "late", name: "chat.message", cursor: "c2.a.1.m", _meta: {} } });
    ub.write({ type: "heartbeat", cursor: "c2.b.1.m" });
    await until(() => s.notificationsFor(2).length === 3, 3000, "the other stream goes on");
    await sleep(20);
    assert.equal(s.notificationsFor("a").length, 1, "nothing more for the cancelled stream");
    assert.equal(s.hasResponse("a"), false, "no result after a cancel");
    ub.write({ type: "close" });
    assert.deepEqual((await s.response(2)).result, finalOf(2));
    await s.close();
  });

  test(`${sdk} stateless HTTP: the client dropping the request aborts the upstream, and doesn't end the subscription`, async () => {
    const core = fakeCore();
    const { wake } = nextApp(core);
    const ep = statelessEndpoint(sdk, () => {
      const server = newServer(sdk);
      wake.attach(server, { identify: () => ({ user: "u1" }) });
      return server;
    });
    const ctl = new AbortController();
    const res = await Promise.race([ep.post(1, "events/stream", { name: "chat.message", arguments: { channel: "eng" }, _meta: as2026("some-draft-client") }, {}, ctl.signal), until(() => core.upstreams.length === 1).then(() => undefined)]);
    await until(() => core.upstreams.length === 1, 3000, "the upstream");
    core.upstreams[0]!.write({ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 });
    await sleep(20);
    ctl.abort();
    for (const o of ep.open) await o.close(); // 1.x: the HTTP response closing closes its transport
    void res;
    await until(() => core.upstreams[0]!.aborted, 3000, "the upstream to be aborted");
    await sleep(20);
    assert.equal(core.reqs.some((r) => r.path === "/events/stream/end"), false, "over HTTP an abort can't be told from a drop: the subscription lapses");
  });

  test(`${sdk} session: an upstream silent for 3 x the heartbeat grant ends the client's stream with the final result (logged); maxStreamMs ends it too`, async () => {
    for (const [why, push, frames, code] of [
      ["silence", undefined, [{ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 20 }], "push_upstream_failed"],
      ["maxStreamMs", { maxStreamMs: 50 }, [{ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 }], undefined],
    ] as const) {
      const core = fakeCore();
      const { wake, log } = nextApp(core);
      const server = newServer(sdk);
      wake.attach(server, { identify: () => ({ user: "u1" }), ...(push ? { push } : {}) });
      const s = await session(sdk, server, "some-draft-client");
      s.request(1, "events/stream", { name: "chat.message", arguments: { channel: "eng" } });
      await until(() => core.upstreams.length === 1, 3000, "the upstream");
      for (const f of frames) core.upstreams[0]!.write(f);
      const started = Date.now();
      assert.deepEqual((await s.response(1, 3000)).result, finalOf(1), why);
      assert.ok(Date.now() - started >= 40, `${why}: not at once`);
      await until(() => core.upstreams[0]!.aborted, 3000, `${why}: upstream aborted`);
      if (code) assert.ok(log.codes().includes(code), `${why}: logged ${code}`);
      assert.equal(core.reqs.some((r) => r.path === "/events/stream/end"), false, `${why}: the subscription stays, for the reconnect`);
      await s.close();
    }
  });

  test(`${sdk} session: 50 open streams don't block tools/call`, async () => {
    const core = fakeCore();
    const { wake } = nextApp(core);
    const server = newServer(sdk);
    server.registerTool("hello", { description: "Say hello" }, async () => ({ content: [{ type: "text", text: "hello" }] }));
    wake.attach(server, { identify: () => ({ user: "u1" }) });
    const s = await session(sdk, server, "some-draft-client");
    for (let i = 0; i < 50; i++) s.request(`s${i}`, "events/stream", { name: "chat.message", arguments: { channel: `c${i}` } });
    await until(() => core.upstreams.length === 50, 5000, "50 upstreams");
    s.request("call", "tools/call", { name: "hello", arguments: {} });
    assert.equal((await s.response("call", 2000)).result.content[0].text, "hello");
    for (const u of core.upstreams) u.write({ type: "close" });
    await until(() => Array.from({ length: 50 }, (_, i) => s.hasResponse(`s${i}`)).every(Boolean), 5000, "every stream's result");
    await s.close();
  });

  test(`${sdk}: a voucher and a cursor through open, relay, refusal and close never reach a log`, async () => {
    const voucher = "wsv_canarycanarycanarycanarycanaryca";
    const cursor = "c2.canary.7.Q0FOQVJZ";
    for (const how of ["relay", "refused", "silent"] as const) {
      const core = fakeCore({
        stream: () =>
          how === "refused"
            ? { status: 403, error: { error: { code: "bad_voucher", message: "no" } } }
            : how === "relay"
              ? { frames: [{ type: "active", cursor, truncated: false, heartbeat_ms: 30000 }, { type: "heartbeat", cursor }, { type: "close" }] }
              : { frames: [{ type: "active", cursor, truncated: false, heartbeat_ms: 30000 }] },
      });
      const { wake, log } = nextApp(core);
      const server = newServer(sdk);
      wake.attach(server, {});
      const s = await session(sdk, server, "some-draft-client");
      s.request(1, "events/stream", { name: "crawl.finished", arguments: { job: "j1", wakeshift_voucher: voucher }, cursor });
      await s.response(1);
      const logged = JSON.stringify(log.lines);
      assert.ok(!logged.includes("canary"), `${how}: ${logged}`);
      await s.close();
    }
  });

  test(`${sdk}: a stream that created its subscription runs onSubscribe (via native; a redeemed voucher's as the tool's)`, async () => {
    for (const [frame, want] of [
      [{ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000, created: true }, { via: "native", tool: undefined }],
      [{ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 }, null],
    ] as const) {
      const core = fakeCore({ stream: () => ({ frames: [frame, { type: "close" }] }) });
      const seen: unknown[] = [];
      const log = captureLog();
      const wake = new Wakeshift({ key: KEY, core: "https://core.test", fetch: core.fetchFn, logger: log.logger });
      wake.defineEvent("chat.message", { description: "A new message", args: z.object({ channel: z.string() }), payload: z.object({ text: z.string() }), public: true, onSubscribe: (s) => void seen.push({ via: s.via, tool: s.tool }) });
      const server = newServer(sdk);
      wake.attach(server, { identify: () => ({ user: "u1" }) });
      const s = await session(sdk, server, "some-draft-client");
      s.request(1, "events/stream", { name: "chat.message", arguments: { channel: "eng" } });
      await s.response(1);
      await sleep(10);
      assert.deepEqual(seen, want ? [want] : []);
      await s.close();
    }
  });
}

// ── opencode ────────────────────────────────────────

for (const sdk of SDKS) {
  test(`${sdk}: opencode declaring MCP Events where push is served is native: no subscribe_events, and its call.subscribe asks the core with events_ext (native_line: the native line; without: the bridged block, the mixed state)`, async () => {
    for (const nativeLine of [true, false]) {
      const core = fakeCore({ replies: { "/event-subscriptions": () => ({ event_subscription: { id: "sub-1", created: true }, session: "wsc_s1", pending: "pa_1", ...(nativeLine ? { native_line: true } : {}) }) } });
      const { wake, events: ev } = nextApp(core);
      const server = newServer(sdk);
      const attached = wake.attach(server, { identify: () => ({ user: "u1" }) });
      let native: boolean | undefined;
      attached.registerTool("start_crawl", { description: "Start a crawl", inputSchema: { job: z.string() }, subscribes: [ev.crawl] }, async ({ job }: { job: string }, _ctx: unknown, call: any) => {
        native = call.native;
        await call.subscribe(ev.crawl, { job });
        return `Crawling ${job}.`;
      });
      const s = await session(sdk, server, "opencode", { extensions: { [EXT]: {} } });
      s.request("l", "tools/list");
      const tools = (await s.response("l")).result.tools.map((t: any) => t.name);
      assert.ok(!tools.includes("subscribe_events"), `${nativeLine}: subscribe_events hidden (SDK verdict native): ${tools}`);
      s.request("c", "tools/call", { name: "start_crawl", arguments: { job: "j1" } });
      const text = (await s.response("c")).result.content.map((c: any) => c.text).join("\n");
      assert.equal(native, true, "call.native is the SDK's verdict");
      const sub = core.reqs.find((r) => r.path === "/event-subscriptions")!.body;
      assert.equal(sub.call.events_ext, true, "events_ext sent");
      const add = core.reqs.find((r) => r.path === "/calls/addition")!.body;
      if (nativeLine) {
        assert.deepEqual(add.native, [{ name: "crawl.finished", arguments: { job: "j1" } }]);
        assert.match(text, /NATIVE crawl\.finished/);
      } else {
        assert.equal(add.native, undefined, "the downgrade: no native line");
        assert.match(text, /BRIDGED block/, "the mixed state: subscribe_events hidden, bridged block");
      }
      await s.close();
    }
  });

  test(`${sdk}: opencode where push isn't served stays bridged: subscribe_events listed, no events_ext, and no native line even if the core answers native_line`, async () => {
    for (const [why, features, push] of [
      ["the core doesn't report push", ["subscribe_vouchers"], undefined],
      ["push: false", ["subscribe_vouchers", "push"], false],
    ] as const) {
      const core = fakeCore({ features: [...features], replies: { "/event-subscriptions": () => ({ event_subscription: { id: "sub-1", created: true }, session: "wsc_s1", pending: "pa_1", native_line: true }) } });
      const { wake, events: ev } = nextApp(core);
      const server = newServer(sdk);
      const attached = wake.attach(server, { identify: () => ({ user: "u1" }), ...(push === undefined ? {} : { push }) });
      attached.registerTool("start_crawl", { description: "Start a crawl", inputSchema: { job: z.string() }, subscribes: [ev.crawl] }, async ({ job }: { job: string }, _ctx: unknown, call: any) => {
        await call.subscribe(ev.crawl, { job });
        return `Crawling ${job}.`;
      });
      const s = await session(sdk, server, "opencode", { extensions: { [EXT]: {} } });
      s.request("l", "tools/list");
      assert.ok((await s.response("l")).result.tools.some((t: any) => t.name === "subscribe_events"), why);
      s.request("c", "tools/call", { name: "start_crawl", arguments: { job: "j1" } });
      await s.response("c");
      assert.equal(core.reqs.find((r) => r.path === "/event-subscriptions")!.body.call.events_ext, undefined, why);
      assert.equal(core.reqs.find((r) => r.path === "/calls/addition")!.body.native, undefined, `${why}: no native line`);
      await s.close();
    }
  });

  test(`${sdk} stateless HTTP in JSON-response mode: opencode gets no events_ext, and no native line even if the core answers native_line`, async () => {
    const core = fakeCore({ replies: { "/event-subscriptions": () => ({ event_subscription: { id: "sub-1", created: true }, session: "wsc_s1", pending: "pa_1", native_line: true }) } });
    const { wake, events: ev } = nextApp(core);
    const ep = statelessEndpoint(
      sdk,
      () => {
        const server = newServer(sdk);
        const attached = wake.attach(server, { identify: () => ({ user: "u1" }) });
        attached.registerTool("start_crawl", { description: "Start a crawl", inputSchema: { job: z.string() }, subscribes: [ev.crawl] }, async ({ job }: { job: string }, _ctx: unknown, call: any) => {
          await call.subscribe(ev.crawl, { job });
          return `Crawling ${job}.`;
        });
        return server;
      },
      true,
    );
    const res = (await messagesOf(await ep.post(1, "tools/call", { name: "start_crawl", arguments: { job: "j1" }, _meta: as2026("opencode") }))).at(-1);
    assert.ok(res.result, JSON.stringify(res));
    assert.equal(core.reqs.find((r) => r.path === "/event-subscriptions")!.body.call.events_ext, undefined);
    assert.equal(core.reqs.find((r) => r.path === "/calls/addition")!.body.native, undefined, "no native line");
    for (const o of ep.open) await o.close();
  });

  test(`${sdk} stateless HTTP: opencode's 2026-07-28 tools/list leaves out subscribe_events only where push is served`, async () => {
    for (const [features, hidden] of [
      [["subscribe_vouchers", "push"], true],
      [["subscribe_vouchers"], false],
    ] as const) {
      const core = fakeCore({ features: [...features] });
      const { wake } = nextApp(core);
      const ep = statelessEndpoint(sdk, () => {
        const server = newServer(sdk);
        wake.attach(server, { identify: () => ({ user: "u1" }) });
        return server;
      });
      const tools = (await messagesOf(await ep.post(1, "tools/list", { _meta: as2026("opencode") }))).at(-1).result.tools.map((t: any) => t.name);
      assert.equal(!tools.includes("subscribe_events"), hidden, `${features}: ${tools}`);
      for (const o of ep.open) await o.close();
    }
  });
}

// opencode on the legacy protocol (its default config) declares MCP Events
// only in initialize. A server that keeps a session's initialize and
// serves each of its requests on a server made for it (the try app, the
// webhooks app: the initialize's capabilities restored, the name given by
// identify) never sees oninitialized: its tools/list still leaves out
// subscribe_events where push is served, and the call asks with events_ext.
for (const sdk of SDKS) test(`${sdk}, a session served per request: opencode's legacy initialize declaration hides subscribe_events where push is served`, async () => {
  for (const [why, features, declares, client, hidden] of [
    ["declared, push served", ["subscribe_vouchers", "push"], true, "opencode", true],
    ["not declared", ["subscribe_vouchers", "push"], false, "opencode", false],
    ["declared, push not served", ["subscribe_vouchers"], true, "opencode", false],
    ["declared, a bridged harness", ["subscribe_vouchers", "push"], true, "claude-code", false],
  ] as const) {
    const core = fakeCore({ features: [...features] });
    const { wake, events: ev } = nextApp(core);
    const capabilities = declares ? { extensions: { [EXT]: {} } } : {};
    const make = () => {
      const server = newServer(sdk);
      // What the server would know had it seen initialize, as the try app restores it.
      (server.server as any).getClientCapabilities = () => capabilities;
      const attached = wake.attach(server, { identify: () => ({ user: "u1", client }) });
      attached.registerTool("start_crawl", { description: "Start a crawl", inputSchema: { job: z.string() }, subscribes: [ev.crawl] }, async ({ job }: { job: string }, _ctx: unknown, call: any) => {
        await call.subscribe(ev.crawl, { job });
        return `Crawling ${job}.`;
      });
      return server;
    };
    const open: { close(): Promise<void> }[] = [];
    const post = async (id: number, method: string, params: Record<string, unknown>) => {
      const server = make();
      const transport = sdk === "1.x" ? new V1WebHttp({ sessionIdGenerator: undefined }) : new v2server.WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      open.push({ close: () => transport.close() });
      const req = new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", "user-agent": "Bun/1.3.14" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      return (await messagesOf(await transport.handleRequest(req))).at(-1);
    };
    const tools = (await post(1, "tools/list", {})).result.tools.map((t: any) => t.name);
    assert.equal(!tools.includes("subscribe_events"), hidden, `${why}: ${tools}`);
    assert.ok(tools.includes("start_crawl"), why);
    await post(2, "tools/call", { name: "start_crawl", arguments: { job: "j1" } });
    const sub = core.reqs.find((r) => r.path === "/event-subscriptions")!.body;
    assert.equal(sub.call.events_ext === true, hidden, `${why}: events_ext ${sub.call.events_ext}`);
    for (const o of open) await o.close();
  }
});

// ── The testing module ──────────────────────────────────────────────────

for (const sdk of SDKS) {
  test(`${sdk}: createTestClient serves push: active, an event per matching emit, and close when it closes`, async () => {
    const wake = createTestClient();
    const chat = wake.defineEvent("chat.message", { description: "A new message", args: z.object({ channel: z.string() }), payload: z.object({ text: z.string() }), public: true });
    const server = newServer(sdk);
    wake.attach(server, { identify: () => ({ user: "u1" }) });
    const s = await session(sdk, server, "some-draft-client");
    s.request(1, "events/list");
    assert.deepEqual((await s.response(1)).result.events[0].delivery, ["webhook", "poll", "push"]);
    s.request(2, "events/stream", { name: "chat.message", arguments: { channel: "eng" }, heartbeatMs: 15000 });
    await until(() => s.notificationsFor(2).length === 1, 3000, "active");
    const active = s.notificationsFor(2)[0]!;
    assert.equal(active.method, "notifications/events/active");
    assert.equal(active.params.heartbeatMs, 15000);
    await chat.emit({ channel: "ops" }, { text: "elsewhere" });
    await chat.emit({ channel: "eng" }, { text: "hi" });
    await until(() => s.notificationsFor(2).length === 2, 3000, "the event");
    const ev = s.notificationsFor(2)[1]!;
    assert.equal(ev.method, "notifications/events/event");
    assert.deepEqual(ev.params.data, { text: "hi" });
    assert.equal(ev.params._meta[SUB], 2);
    assert.equal(wake.subscriptions.length, 1);
    await wake.close();
    assert.deepEqual((await s.response(2)).result, finalOf(2));
    await s.close();
  });
}

// ── The option ──────────────────────────────────────────────────────────

test("attach's push option: false, or { maxStreamMs, maxHeartbeatMs }; anything else is refused; maxStreamMs defaults by host", () => {
  const core = fakeCore();
  const { wake, log } = nextApp(core);
  for (const bad of [true, "off", { maxStreamMs: 0 }, { maxStreamMs: 1.5 }, { other: 1 }, null]) {
    assert.throws(() => wake.attach(newServer("1.x"), { push: bad as any }), /push/, JSON.stringify(bad));
  }
  assert.deepEqual(pushConfig(wake, false, {}), { on: false });
  const on = { on: true, reauthorizeMs: g.reauthorize.default_ms };
  assert.deepEqual(pushConfig(wake, undefined, {}), on);
  assert.deepEqual(pushConfig(wake, { maxHeartbeatMs: 20000 }, {}), { ...on, maxHeartbeatMs: 20000 });
  assert.deepEqual(pushConfig(wake, undefined, { VERCEL: "1" }), { ...on, maxStreamMs: 280_000 });
  assert.deepEqual(pushConfig(wake, undefined, { AWS_LAMBDA_FUNCTION_NAME: "f" }), { ...on, maxStreamMs: 840_000 });
  assert.deepEqual(pushConfig(wake, undefined, { K_SERVICE: "s" }), { ...on, maxStreamMs: 3_300_000 });
  assert.deepEqual(pushConfig(wake, { maxStreamMs: 1000 }, { VERCEL: "1" }), { ...on, maxStreamMs: 1000 }, "the app's own wins");
  // reauthorizeMs (mcp-events-wire.json push.reauthorize clamp, invalid).
  for (const c of g.reauthorize.clamp) assert.equal(pushConfig(wake, { reauthorizeMs: c.reauthorize_ms }, {}).reauthorizeMs, c.want_ms, String(c.reauthorize_ms));
  for (const bad of g.reauthorize.invalid) assert.throws(() => wake.attach(newServer("1.x"), { push: { reauthorizeMs: bad } as any }), /reauthorizeMs/, JSON.stringify(bad));
  assert.ok(log.codes("debug").includes("push_max_stream"));
});

test("maxHeartbeatMs: the smaller of it and the client's suggestion is asked for, or it alone", async () => {
  for (const [suggested, max, want] of [
    [15000, 20000, 15000],
    [40000, 20000, 20000],
    [null, 20000, 20000],
  ] as const) {
    const core = fakeCore({ stream: () => ({ frames: [{ type: "close" }] }) });
    const { wake } = nextApp(core);
    const server = newServer("1.x");
    wake.attach(server, { identify: () => ({ user: "u1" }), push: { maxHeartbeatMs: max } });
    const s = await session("1.x", server, "some-draft-client");
    s.request(1, "events/stream", { name: "chat.message", arguments: { channel: "eng" }, ...(suggested === null ? {} : { heartbeatMs: suggested }) });
    await s.response(1);
    assert.equal(core.streamReqs()[0]!.body.heartbeat_ms, want);
    await s.close();
  }
});

test("2.x createMcpHandler with responseMode \"auto\", one client shared by a server per request (a common app shape): push listed and served", async () => {
  const core = fakeCore({ stream: () => ({ frames: [{ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 }, { type: "close" }] }) });
  const { wake } = nextApp(core);
  const handler = v2server.createMcpHandler(
    () => {
      const server = new v2server.McpServer({ name: "toy", version: "0.1.0" });
      wake.attach(server, { identify: () => ({ user: "u1" }), builtinTools: { subscribe: false, list: false, unsubscribe: false, wait: false } });
      return server;
    },
    { legacy: "reject", responseMode: "auto", onerror: () => {} },
  );
  const post = async (id: number, method: string, params: Record<string, unknown>) => {
    const body = { jsonrpc: "2.0", id, method, params: { ...params, _meta: as2026("probe", false) } };
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method };
    if (typeof params.name === "string") h["mcp-name"] = params.name;
    return messagesOf(await handler.fetch(new Request("http://mcp.test/mcp", { method: "POST", headers: h, body: JSON.stringify(body) }), { parsedBody: body }));
  };
  const listed = (await post(1, "events/list", {})).at(-1).result.events;
  assert.deepEqual(listed.find((e: any) => e.name === "chat.message").delivery, g.delivery);
  const streamed = await post(2, "events/stream", { name: "chat.message", arguments: { channel: "eng" }, cursor: null });
  assert.deepEqual(events(streamed, 2).map((n) => n.method), ["notifications/events/active"]);
  assert.equal(withoutMeta(streamed.at(-1).result).resultType, "complete");
});

test("2.x createMcpHandler: an events/stream response carries no SSE keep-alive comments (heartbeats are data frames); other responses keep them", async () => {
  const core = fakeCore();
  const { wake } = nextApp(core);
  const handler = v2server.createMcpHandler(
    () => {
      const server = new v2server.McpServer({ name: "next", version: "1.0.0" });
      wake.attach(server, { identify: () => ({ user: "u1" }) });
      return server;
    },
    { onerror: () => {}, keepAliveMs: 10 },
  );
  const body = { jsonrpc: "2.0", id: 1, method: "events/stream", params: { name: "chat.message", arguments: { channel: "eng" }, cursor: null, _meta: as2026("probe", false) } };
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "events/stream", "mcp-name": "chat.message" };
  const pending = handler.fetch(new Request("http://mcp.test/mcp", { method: "POST", headers: h, body: JSON.stringify(body) }), { parsedBody: body });
  await until(() => core.upstreams.length === 1, 3000, "the upstream");
  core.upstreams[0]!.write({ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 });
  const res = await pending;
  await sleep(80); // several keep-alive intervals
  core.upstreams[0]!.write({ type: "heartbeat", cursor: "c2.a.0.m" });
  core.upstreams[0]!.write({ type: "close" });
  const text = await res.text();
  assert.ok(!text.includes(": keepalive"), text);
  assert.match(text, /notifications\/events\/heartbeat/);
  assert.match(text, /"io\.modelcontextprotocol\/subscriptionId":1\}\},"jsonrpc"|"resultType":"complete"/);
});

// ── A 503's Retry-After, a reused request ID, a body that isn't Wakeshift's ──

test("a 503's Retry-After: seconds or an HTTP date, at most 10 seconds; the wait ends with the client's abort", async () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  assert.equal(retryAfterMs(null, now), 0);
  assert.equal(retryAfterMs("2", now), 2000);
  assert.equal(retryAfterMs("120", now), 10_000, "capped");
  assert.equal(retryAfterMs("Thu, 12 Nov 2026 12:00:03 GMT", now), 3000);
  assert.equal(retryAfterMs("Thu, 12 Nov 2026 11:00:00 GMT", now), 0, "a past date");
  assert.equal(retryAfterMs("soon", now), 0);
  const ctl = new AbortController();
  const started = Date.now();
  const waited = pause(10_000, ctl.signal);
  setTimeout(() => ctl.abort(), 20);
  await waited;
  assert.ok(Date.now() - started < 1000, "the abort ended the wait");
});

for (const sdk of SDKS) {
  test(`${sdk} session: a request ID cancelled before its stream opened isn't taken for that stream's cancel`, async () => {
    const core = fakeCore();
    const { wake } = nextApp(core);
    const server = newServer(sdk);
    wake.attach(server, { identify: () => ({ user: "u1" }) });
    const s = await session(sdk, server, "some-draft-client");
    // A cancel for an ID with nothing in flight, then a stream reusing it.
    await s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "late" } });
    s.request(1, "events/stream", { name: "chat.message", arguments: { channel: "eng" } });
    await until(() => core.upstreams.length === 1, 3000, "the upstream");
    core.upstreams[0]!.write({ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 });
    await until(() => s.notificationsFor(1).length === 1, 3000, "active");
    // The connection drops: an abort, not a cancel.
    await s.close();
    await until(() => core.upstreams[0]!.aborted, 3000, "the upstream to be aborted");
    await sleep(20);
    assert.equal(core.reqs.some((r) => r.path === "/events/stream/end"), false, "no end call");
  });

  test(`${sdk}: a refusal whose body isn't Wakeshift's JSON never reaches the client`, async () => {
    const core = fakeCore({ stream: () => ({ status: 403, error: null, raw: "<html><body>proxy says no: secret-page-text</body></html>" }) });
    const { wake } = nextApp(core);
    const server = newServer(sdk);
    wake.attach(server, { identify: () => ({ user: "u1" }) });
    const s = await session(sdk, server, "some-draft-client");
    s.request(1, "events/stream", { name: "chat.message", arguments: { channel: "eng" } });
    const res = await s.response(1);
    assert.ok(res.error, JSON.stringify(res));
    assert.ok(!JSON.stringify(res.error).includes("secret-page-text"), JSON.stringify(res.error));
    assert.match(res.error.message, /push upstream failed/);
    await s.close();
  });
}

// ── Reauthorizing an open stream (mcp-events-wire.json push.reauthorize) ──

// reauthApp serves deploy.finished, whose authorize and identify the test steers.
function reauthApp(sdk: Sdk, steer: { allow: () => boolean; user: () => string | undefined }, push?: Record<string, unknown>) {
  const core = fakeCore();
  const log = captureLog();
  const wake = new Wakeshift({ key: KEY, core: "https://core.test", fetch: core.fetchFn, logger: log.logger });
  wake.defineEvent("deploy.finished", { description: "A deploy finished", args: z.object({ env: z.string() }), payload: z.object({ status: z.string() }), authorize: () => steer.allow() });
  const server = newServer(sdk);
  wake.attach(server, { identify: () => ({ user: steer.user() }), ...(push ? { push: push as any } : {}) });
  return { core, log, server };
}

const R = g.reauthorize;
const tickAndSettle = async (t: any, ms: number) => {
  t.mock.timers.tick(ms);
  await sleep(10);
};

for (const sdk of SDKS) {
  test(`${sdk}: a reauthorization that refuses ends the open stream as a revocation does (terminated, Forbidden), with no end call; in both dialects`, async (t) => {
    for (const [dialect, client] of [["draft", "some-draft-client"], ["chatgpt", "openai-mcp"]] as const) {
      t.mock.timers.enable({ apis: ["setInterval"] });
      let allow = true;
      const { core, server } = reauthApp(sdk, { allow: () => allow, user: () => R.user });
      const s = await session(sdk, server, client);
      s.request(R.stream_id, "events/stream", R.params);
      await until(() => core.upstreams.length === 1, 3000, "the upstream");
      core.upstreams[0]!.write({ type: "active", cursor: "c2.d.0.m", truncated: false, heartbeat_ms: 30000 });
      await until(() => s.notificationsFor(R.stream_id).length === 1, 3000, "active");
      allow = false;
      await tickAndSettle(t, R.default_ms - 1);
      assert.equal(s.hasResponse(R.stream_id), false, `${dialect}: not before the interval`);
      await tickAndSettle(t, 1);
      const res = await s.response(R.stream_id);
      assert.deepEqual(res.result, R.result, dialect);
      const want = { ...R.notification, params: { ...R.notification.params, error: { ...R.notification.params.error, code: R.code[dialect] } } };
      assert.deepEqual(s.notificationsFor(R.stream_id).at(-1), want, dialect);
      await until(() => core.upstreams[0]!.aborted, 3000, "the upstream aborted");
      assert.equal(core.reqs.some((r) => r.path === "/events/stream/end"), false, `${dialect}: the core's subscription stays`);
      await s.close();
      t.mock.timers.reset();
    }
  });

  test(`${sdk}: identify giving another user (or none) at a reauthorization ends the stream; identify or authorize failing keeps it`, async (t) => {
    for (const [why, steerAt, ends, code] of [
      ["another user", { user: () => "u2" }, true, undefined],
      ["no user", { user: () => undefined }, true, undefined],
      ["authorize throws", { allow: () => { throw new Error("db down"); } }, false, "authorize_failed"],
      ["authorize allows", {}, false, undefined],
    ] as const) {
      t.mock.timers.enable({ apis: ["setInterval"] });
      let checking = false;
      const base = { allow: () => true, user: () => R.user };
      const steer = { allow: () => (checking && "allow" in steerAt ? (steerAt as any).allow() : base.allow()), user: () => (checking && "user" in steerAt ? (steerAt as any).user() : base.user()) };
      const { core, server, log } = reauthApp(sdk, steer);
      const s = await session(sdk, server, "some-draft-client");
      s.request(R.stream_id, "events/stream", R.params);
      await until(() => core.upstreams.length === 1, 3000, "the upstream");
      core.upstreams[0]!.write({ type: "active", cursor: "c2.d.0.m", truncated: false, heartbeat_ms: 30000 });
      await until(() => s.notificationsFor(R.stream_id).length === 1, 3000, "active");
      checking = true;
      await tickAndSettle(t, R.default_ms);
      if (ends) {
        assert.deepEqual((await s.response(R.stream_id)).result, R.result, why);
        assert.equal(s.notificationsFor(R.stream_id).at(-1)!.method, "notifications/events/terminated", why);
      } else {
        // Still open: the next event arrives.
        core.upstreams[0]!.write({ type: "event", occurrence: { eventId: "e1", name: "deploy.finished", cursor: "c2.d.1.m", data: { status: "ok" }, _meta: {} } });
        await until(() => s.notificationsFor(R.stream_id).length === 2, 3000, `${why}: the next event`);
        assert.equal(s.hasResponse(R.stream_id), false, why);
        if (code) assert.ok(log.codes().includes(code), `${why}: logged ${code}`);
        core.upstreams[0]!.write({ type: "close" });
        await s.response(R.stream_id);
      }
      await s.close();
      t.mock.timers.reset();
    }
  });

  test(`${sdk}: push.reauthorizeMs sets the interval, clamped (fake clock)`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let allow = true;
    const { core, server } = reauthApp(sdk, { allow: () => allow, user: () => R.user }, { reauthorizeMs: 1000 });
    const s = await session(sdk, server, "some-draft-client");
    s.request(R.stream_id, "events/stream", R.params);
    await until(() => core.upstreams.length === 1, 3000, "the upstream");
    core.upstreams[0]!.write({ type: "active", cursor: "c2.d.0.m", truncated: false, heartbeat_ms: 30000 });
    await until(() => s.notificationsFor(R.stream_id).length === 1, 3000, "active");
    allow = false;
    await tickAndSettle(t, 1000);
    assert.equal(s.hasResponse(R.stream_id), false, "1000 ms is clamped up to the minimum");
    await tickAndSettle(t, R.min_ms - 1000);
    assert.deepEqual((await s.response(R.stream_id)).result, R.result);
    await s.close();
  });
}

// ── Failing rechecks, bounded (MAX_UNCHECKED_MS) ────────────────────────

test("maxUncheckedMs: 15 minutes, or three reauthorize intervals if longer", () => {
  assert.equal(MAX_UNCHECKED_MS, 15 * 60_000);
  assert.equal(maxUncheckedMs(R.default_ms), 15 * 60_000, "three failed rechecks at the default");
  assert.equal(maxUncheckedMs(R.min_ms), 15 * 60_000);
  assert.equal(maxUncheckedMs(10 * 60_000), 30 * 60_000);
});

for (const sdk of SDKS) {
  // A stream of deploy.finished whose identify and authorize the test
  // steers through answers: "ok", "refuse", "authorize_throws" or
  // "identify_throws", one per recheck in order (the open always allows).
  // Canary values in the arguments, cursor and error message: none may
  // reach a log.
  const CANARY = { params: { name: "deploy.finished", arguments: { env: "env-canary" }, cursor: "c2.cursor-canary.0.m" }, error: "secret-canary" };
  async function steered(t: any, answers: string[], push?: Record<string, unknown>) {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    let n = -1;
    const now = () => (n < 0 ? "ok" : answers[Math.min(n, answers.length - 1)]);
    const { core, server, log } = reauthApp(
      sdk,
      {
        allow: () => {
          if (now() === "authorize_throws") throw new Error(CANARY.error);
          return now() !== "refuse";
        },
        user: () => {
          if (now() === "identify_throws") throw new Error(CANARY.error);
          return R.user;
        },
      },
      push,
    );
    const s = await session(sdk, server, "some-draft-client");
    s.request(R.stream_id, "events/stream", CANARY.params);
    await until(() => core.upstreams.length === 1, 3000, "the upstream");
    core.upstreams[0]!.write({ type: "active", cursor: CANARY.params.cursor, truncated: false, heartbeat_ms: 30000 });
    await until(() => s.notificationsFor(R.stream_id).length === 1, 3000, "active");
    // Each recheck: the next answer, then the interval passing.
    const recheck = async (ms: number) => {
      n++;
      await tickAndSettle(t, ms);
    };
    return { core, s, log, recheck };
  }
  const noCanary = (log: { lines: unknown[] }) => {
    const logged = JSON.stringify(log.lines);
    assert.ok(!logged.includes("canary"), logged);
  };

  test(`${sdk}: identify or authorize failing at every recheck ends the stream once its last successful check is 15 minutes old, with the final result (no terminated), for the client to reconnect`, async (t) => {
    for (const fails of ["authorize_throws", "identify_throws"]) {
      const { core, s, log, recheck } = await steered(t, [fails]);
      await recheck(R.default_ms);
      await recheck(R.default_ms);
      assert.equal(s.hasResponse(R.stream_id), false, `${fails}: open after two failed rechecks (10 minutes)`);
      await recheck(R.default_ms);
      assert.deepEqual((await s.response(R.stream_id)).result, R.result, `${fails}: the final result at 15 minutes`);
      assert.deepEqual(
        s.notificationsFor(R.stream_id).map((m) => m.method),
        ["notifications/events/active"],
        `${fails}: no terminated: the client reconnects with its cursor`,
      );
      await until(() => core.upstreams[0]!.aborted, 3000, "the upstream aborted");
      assert.equal(core.reqs.some((r) => r.path === "/events/stream/end"), false, `${fails}: the subscription stays, for the reconnect`);
      const ours = log.lines.filter((l) => l.fields.code.startsWith("push_recheck"));
      assert.deepEqual(
        ours.map((l) => [l.level, l.fields.code]),
        [
          ["warn", "push_recheck_failed"],
          ["warn", "push_recheck_failed"],
          ["warn", "push_recheck_failed"],
          ["warn", "push_recheck_stale"],
        ],
        fails,
      );
      for (const l of ours) assert.deepEqual(Object.keys(l.fields).sort(), ["code", "count", "event"], fails);
      for (const l of ours) assert.equal(l.fields.event, "deploy.finished");
      noCanary(log);
      await s.close();
      t.mock.timers.reset();
    }
  });

  test(`${sdk}: a successful recheck resets the bound; a refusal still ends the stream as a revocation`, async (t) => {
    const { core, s, log, recheck } = await steered(t, ["authorize_throws", "authorize_throws", "ok", "identify_throws", "identify_throws", "identify_throws"]);
    for (let i = 0; i < 5; i++) await recheck(R.default_ms);
    // 25 minutes in, the last successful check 10 minutes ago: still open.
    core.upstreams[0]!.write({ type: "event", occurrence: { eventId: "e1", name: "deploy.finished", cursor: "c2.d.1.m", data: { status: "ok" }, _meta: {} } });
    await until(() => s.notificationsFor(R.stream_id).length === 2, 3000, "the next event");
    assert.equal(s.hasResponse(R.stream_id), false);
    await recheck(R.default_ms);
    assert.deepEqual((await s.response(R.stream_id)).result, R.result, "15 minutes after the successful check");
    assert.equal(s.notificationsFor(R.stream_id).at(-1)!.method, "notifications/events/event");
    noCanary(log);
    await s.close();
    t.mock.timers.reset();

    // Failing, then refusing: terminated (Forbidden, revoked), as before.
    const r = await steered(t, ["authorize_throws", "refuse"]);
    await r.recheck(R.default_ms);
    await r.recheck(R.default_ms);
    assert.deepEqual((await r.s.response(R.stream_id)).result, R.result);
    const last = r.s.notificationsFor(R.stream_id).at(-1)!;
    assert.equal(last.method, "notifications/events/terminated");
    assert.deepEqual(last.params.error.data, { reason: "revoked" });
    assert.equal(last.params.error.code, R.code.draft);
    assert.equal(r.log.codes().includes("push_recheck_stale"), false);
    noCanary(r.log);
    await r.s.close();
    t.mock.timers.reset();
  });

  test(`${sdk}: with a longer push.reauthorizeMs, the bound is three failed rechecks`, async (t) => {
    const every = 10 * 60_000;
    const { s, recheck } = await steered(t, ["authorize_throws"], { reauthorizeMs: every });
    await recheck(every);
    await recheck(every);
    assert.equal(s.hasResponse(R.stream_id), false, "20 minutes: open");
    await recheck(every);
    assert.deepEqual((await s.response(R.stream_id)).result, R.result, "30 minutes: ended");
    await s.close();
    t.mock.timers.reset();
  });
}

// ── A reconnect whose check fails (an error, not a refusal) ─────────────

for (const sdk of SDKS) {
  test(`${sdk}: identify or authorize failing at a stream's open (a reconnect) answers a retryable Internal error, never Forbidden; a refusal is still Forbidden; in both dialects`, async () => {
    for (const [dialect, client] of [["draft", "some-draft-client"], ["chatgpt", "openai-mcp"]] as const) {
      for (const how of ["identify_throws", "authorize_throws", "authorize_refuses", "identify_no_user"] as const) {
        const { core, server, log } = reauthApp(sdk, {
          allow: () => {
            if (how === "authorize_throws") throw new Error("secret-canary");
            return how !== "authorize_refuses";
          },
          user: () => {
            if (how === "identify_throws") throw new Error("secret-canary");
            return how === "identify_no_user" ? undefined : R.user;
          },
        });
        const s = await session(sdk, server, client);
        s.request(R.stream_id, "events/stream", { name: "deploy.finished", arguments: { env: "env-canary" }, cursor: "c2.cursor-canary.0.m" });
        const res = await s.response(R.stream_id);
        const what = `${dialect} ${how}`;
        if (how.endsWith("_throws")) {
          assert.deepEqual(res.error, { code: -32603, message: CHECK_FAILED }, what);
          const ours = log.lines.filter((l) => l.fields.code === "push_open_check_failed");
          assert.equal(ours.length, 1, what);
          assert.equal(ours[0]!.level, "warn", what);
          assert.deepEqual(ours[0]!.fields, { code: "push_open_check_failed", event: "deploy.finished", count: 1 }, what);
        } else {
          assert.equal(res.error?.code, R.code[dialect], `${what}: Forbidden`);
          assert.equal(log.codes().includes("push_open_check_failed"), false, what);
        }
        assert.equal(core.upstreams.length, 0, `${what}: no upstream opened`);
        assert.ok(!JSON.stringify(log.lines).includes("canary"), `${what}: ${JSON.stringify(log.lines)}`);
        await s.close();
      }
    }
  });
}

// ── Streamable HTTP with sessions: keep-alive comments and a dropped response ──

// sessionHttp is a server on the MCP SDK's web-standard Streamable HTTP
// transport with sessions (keep-alive comments every keepAliveMs), its
// session initialized; post sends one request on it.
async function sessionHttp(sdk: Sdk, server: any, keepAliveMs: number) {
  const Transport = sdk === "1.x" ? V1WebHttp : (v2server as any).WebStandardStreamableHTTPServerTransport;
  const transport = new Transport({ sessionIdGenerator: () => "s1", keepAliveMs });
  await server.connect(transport);
  const post = (body: Record<string, unknown>, more: Record<string, string> = {}) =>
    transport.handleRequest(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...more },
        body: JSON.stringify(body),
      }),
    ) as Promise<Response>;
  const init = await post({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "some-draft-client", version: "1" } } });
  await init.text();
  await (await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": "s1" })).text();
  const stream = (id: number) => post({ jsonrpc: "2.0", id, method: "events/stream", params: { name: "chat.message", arguments: { channel: "eng" } } }, { "mcp-session-id": "s1", "mcp-name": "chat.message" });
  return { transport, stream };
}

for (const sdk of SDKS) {
  test(`${sdk} Streamable HTTP with sessions: an events/stream response carries no SSE keep-alive comments (heartbeats are data frames)`, async () => {
    const core = fakeCore();
    const { wake } = nextApp(core);
    const server = newServer(sdk);
    wake.attach(server, { identify: () => ({ user: "u1" }) });
    const { transport, stream } = await sessionHttp(sdk, server, 10);
    try {
      const pending = stream(7);
      await until(() => core.upstreams.length === 1, 3000, "the upstream");
      core.upstreams[0]!.write({ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 });
      const res = await pending;
      await sleep(80); // several keep-alive intervals
      core.upstreams[0]!.write({ type: "heartbeat", cursor: "c2.a.0.m" });
      core.upstreams[0]!.write({ type: "close" });
      const text = await res.text();
      assert.ok(!text.includes(": keepalive"), text);
      assert.match(text, /notifications\/events\/active/);
      assert.match(text, /notifications\/events\/heartbeat/);
      assert.match(text, /"resultType":"complete"/);
    } finally {
      await transport.close();
    }
  });

  test(`${sdk} Streamable HTTP with sessions: the client dropping the response aborts the upstream at once, not at the next write`, async () => {
    const core = fakeCore();
    const { wake } = nextApp(core);
    const server = newServer(sdk);
    wake.attach(server, { identify: () => ({ user: "u1" }) });
    const { transport, stream } = await sessionHttp(sdk, server, 60_000);
    try {
      const pending = stream(8);
      await until(() => core.upstreams.length === 1, 3000, "the upstream");
      core.upstreams[0]!.write({ type: "active", cursor: "c2.a.0.m", truncated: false, heartbeat_ms: 30000 });
      const res = await pending;
      const reader = res.body!.getReader();
      await reader.read(); // the active notification
      await reader.cancel();
      // Nothing more is written to the stream (the heartbeat grant is 30 seconds): only the cancel can end it.
      await until(() => core.upstreams[0]!.aborted, 1000, "the upstream to be aborted");
      await sleep(20);
      assert.equal(core.reqs.some((r) => r.path === "/events/stream/end"), false, "over HTTP an abort can't be told from a drop: the subscription lapses");
    } finally {
      await transport.close();
    }
  });
}

for (const sdk of SDKS) {
  test(`${sdk}: a stream that ends before notifications/events/active is answered with an error, never a bare final result (SEP-3415: an error, or active first)`, async () => {
    for (const [why, frames, want] of [
      ["close", [{ type: "close" }], { code: -32603, message: "Wakeshift couldn't be reached" }],
      ["terminated", [{ type: "terminated", error: { name: "Forbidden", message: "revoked", data: { reason: "revoked" } } }], { code: -32024, message: "revoked", data: { reason: "revoked" } }],
    ] as const) {
      const core = fakeCore();
      const { wake } = nextApp(core);
      const server = newServer(sdk);
      wake.attach(server, { identify: () => ({ user: "u1" }) });
      const s = await session(sdk, server, "some-draft-client");
      s.request(1, "events/stream", { name: "chat.message", arguments: { channel: "eng" } });
      await until(() => core.upstreams.length === 1, 3000, "the upstream");
      for (const f of frames) core.upstreams[0]!.write(f);
      const r = await s.response(1);
      assert.equal(r.result, undefined, `${why}: no result`);
      assert.deepEqual({ code: r.error?.code, message: r.error?.message, ...(r.error?.data ? { data: r.error.data } : {}) }, want, why);
      assert.deepEqual(s.notificationsFor(1), [], `${why}: no notifications`);
      await s.close();
    }
  });
}
