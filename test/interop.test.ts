// test/mcp-events-interop.json (with the Go and Python SDKs): where the
// SDKs used to answer MCP Events requests differently. Over HTTP, as an
// app serves a stateless server (test/mcp.ts statelessHttp: 1.x's
// Streamable HTTP transport, or 2.x's createMcpHandler).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer, statelessHttp } from "./mcp.js";
import { Wakeshift } from "../src/index.js";
import { EXTENSION_KEY, REVISION, evaluateClient, headerValue, nativeClient, paramHeaderRefusal, paramHeadersOf } from "../src/spec.js";
import { UsageError } from "../src/errors.js";
import { CLIENT_TABLE } from "../src/clients.js";
import { quiet } from "./logs.js";

const g = JSON.parse(readFileSync(new URL("../../test/mcp-events-interop.json", import.meta.url), "utf8"));

const KEY = `wst_test_chat_${Buffer.alloc(32, 9).toString("base64url")}`;
const DELIVERY = { mode: "webhook", url: "https://agent.example/hooks/1", secret: "whsec_dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQtdGVzdA==" };

// A chat app (chat.message, public, unless withEvent is false) whose
// identify says u1, behind a fake core that answers events/*; asked counts
// what reached the core's events routes.
async function chatApp(withEvent = true, withDeploy = false) {
  const asked: string[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://core.test/api/apps/v1", "");
    if (path.startsWith("/events/")) asked.push(path);
    const json =
      path === "/events/poll"
        ? { events: [], cursor: "c1.0", truncated: false, has_more: false, next_poll_ms: 10000, created: false }
        : path === "/events/subscribe"
          ? { id: "sub_1", refresh_before: "2026-11-11T13:00:00Z", cursor: "c1.0", truncated: false, created: false }
          : path === "/events/unsubscribe"
            ? { ended: true }
            : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const wake = new Wakeshift({ key: KEY, core: "https://core.test", fetch: fakeFetch, logger: quiet });
  if (withEvent) {
    wake.defineEvent("chat.message", {
      description: "A new message in a channel",
      args: z.object({ channel: z.string() }),
      payload: z.object({ text: z.string() }),
      public: true,
    });
  }
  if (withDeploy) {
    // test/mcp-events-interop.json mcp_param_http: x-mcp-header through zod 4's meta.
    wake.defineEvent("deploy.finished", {
      description: "A deploy finished",
      args: z.object({ region: z.string().meta({ "x-mcp-header": "Region" }), attempt: z.number().int().optional().meta({ "x-mcp-header": "Attempt" }) }),
      payload: z.object({ region: z.string(), attempt: z.number().int() }),
      public: true,
    });
  }
  const served = await statelessHttp(() => {
    const server = new McpServer({ name: "chat", version: "1.0.0" });
    wake.attach(server, { identify: () => ({ user: "u1" }) });
    return server;
  });
  return { ...served, asked };
}

const meta = (client: string, declares: boolean) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: client, version: "1" },
  "io.modelcontextprotocol/clientCapabilities": declares ? { extensions: { [EXTENSION_KEY]: {} } } : {},
});

// post sends one 2026-07-28 JSON-RPC request; its HTTP status and the JSON-RPC message.
async function post(url: string, method: string, params: unknown, headers: Record<string, string> = {}, more: [string, string][] = []): Promise<{ status: number; msg: any }> {
  const h = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...headers });
  for (const [k, v] of more) h.append(k, v);
  const res = await fetch(url, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = (await res.text()).trim();
  let msg: any = {};
  if (text.startsWith("{")) msg = JSON.parse(text);
  else
    for (const line of text.split("\n"))
      if (line.startsWith("data:")) {
        const m = JSON.parse(line.slice(5));
        if ("result" in m || "error" in m) msg = m;
      }
  return { status: res.status, msg };
}

test("interop: the revision is the accepted SEP-3415", () => {
  assert.equal(g.revision, REVISION);
});

test("interop: decoding Mcp-Name (mcp_name_decode)", () => {
  for (const c of g.mcp_name_decode.cases) assert.equal(headerValue(c.header), c.value, c.header);
});

test("interop: Mcp-Name must match params.name and may be missing (mcp_name)", async () => {
  const app = await chatApp();
  try {
    for (const c of g.mcp_name.cases) {
      const params: Record<string, unknown> =
        c.method === "events/list" ? { _meta: meta(c.client, c.declares) } : { name: "chat.message", arguments: { channel: "eng" }, _meta: meta(c.client, c.declares) };
      if (c.method === "events/subscribe") params.delivery = DELIVERY;
      const before = app.asked.length;
      const more: [string, string][] = (c as { second_header?: string }).second_header !== undefined ? [["mcp-name", (c as { second_header?: string }).second_header!]] : [];
      const { status, msg } = await post(app.url, c.method, params, { "user-agent": `${c.client}/1`, ...(c.header !== null ? { "mcp-name": c.header } : {}) }, more);
      const refused = status === 400 && msg.error?.code === -32020;
      assert.equal(refused ? "refused" : "passed", c.want, `${c.name}: ${status} ${JSON.stringify(msg)}`);
      if (refused) assert.equal(app.asked.length, before, `${c.name}: asked Wakeshift`);
    }
  } finally {
    await app.close();
  }
});

test("interop: events/stream answers Unsupported, value push (stream)", async () => {
  const app = await chatApp();
  try {
    for (const [dialect, client] of [["draft", "some-draft-client"], ["chatgpt", "openai-mcp"]] as const) {
      for (const name of ["chat.message", "no.such.event"]) {
        const { msg } = await post(app.url, "events/stream", { ...g.stream.params, name, _meta: meta(client, false) }, { "user-agent": `${client}/1` });
        assert.deepEqual(msg.error, { code: g.stream.error.code[dialect], message: g.stream.error.message, data: g.stream.error.data }, `${dialect} ${name}`);
      }
    }
    assert.deepEqual(app.asked, [], "Wakeshift isn't asked");
  } finally {
    await app.close();
  }
});

test("interop: no events, -32601 (no_events)", async () => {
  const app = await chatApp(false);
  try {
    for (const m of g.no_events.methods) {
      const { msg } = await post(app.url, m, { name: "chat.message", arguments: {}, _meta: meta("tanstack-ai", true) }, { "mcp-name": "chat.message" });
      assert.equal(msg.error?.code, g.no_events.code, `${m}: ${JSON.stringify(msg)}`);
    }
  } finally {
    await app.close();
  }
});

test("interop: one native-client rule (native_client)", () => {
  // The client table's cases: the SDK's rule (this SDK serves no push), and the table's whole verdict (native,
  // dialect, matched entry), push or not.
  for (const c of g.native_client.cases) {
    const push = c.serves_push ?? false;
    if (!push) assert.equal(nativeClient(c.client, c.user_agent, c.meta, c.session_extensions ?? undefined), c.native, c.name);
    assert.deepEqual(evaluateClient(c.client, c.user_agent, c.meta, c.session_extensions ?? undefined, push), { native: c.native, dialect: c.dialect, entry: c.entry }, c.name);
  }
});

test("interop: the generated client table is mcp-events-clients.json", () => {
  // Without its documentation (_about, reason, source, about) and webhook_only (only Wakeshift reads it), which the SDKs don't ship.
  const doc = (k: string) => k.startsWith("_") || k === "reason" || k === "source" || k === "about" || k === "webhook_only";
  const want = JSON.parse(readFileSync(new URL("../../test/mcp-events-clients.json", import.meta.url), "utf8"), (k, v) => (doc(k) ? undefined : v));
  assert.deepEqual(CLIENT_TABLE, want, "regenerate it: go run ./internal/mcpevents/clientsgen/gen");
});

test("interop: x-mcp-header annotations are checked when an event is defined (mcp_param_schema)", () => {
  for (const c of g.mcp_param_schema.cases) {
    const got = paramHeadersOf(c.schema);
    assert.equal(got.problem === undefined, c.valid, `${c.name}: ${got.problem ?? "valid"}`);
  }
  // Through defineEvent: zod 4's meta carries the annotation into the arguments' JSON Schema.
  const wake = new Wakeshift({ key: KEY, core: "https://core.test", logger: quiet });
  const payload = z.object({ ratio: z.number() });
  assert.throws(
    () => wake.defineEvent("bad.number", { description: "d", args: z.object({ ratio: z.number().meta({ "x-mcp-header": "Ratio" }) }), payload, topic: "t" }),
    (err: unknown) => err instanceof UsageError && err.code === "config" && /x-mcp-header on ratio/.test(err.message),
  );
  assert.throws(
    () => wake.defineEvent("bad.token", { description: "d", args: z.object({ ratio: z.string().meta({ "x-mcp-header": "Ra tio" }) }), payload, topic: "t" }),
    (err: unknown) => err instanceof UsageError && err.code === "config",
  );
  const ok = wake.defineEvent("good.event", { description: "d", args: z.object({ team: z.object({ id: z.string().meta({ "x-mcp-header": "Team-Id" }) }) }), payload, topic: "t" });
  assert.deepEqual(ok.paramHeaders, [{ path: ["team", "id"], name: "Team-Id", type: "string" }]);
});

test("interop: Mcp-Param headers must match the annotated arguments (mcp_param)", () => {
  const { headers: annotated, problem } = paramHeadersOf(g.mcp_param.schema);
  assert.equal(problem, undefined);
  for (const c of g.mcp_param.cases) {
    const fields = new Map<string, string[]>();
    for (const [k, v] of c.headers as [string, string][]) fields.set(k.toLowerCase(), [...(fields.get(k.toLowerCase()) ?? []), v]);
    const refused = paramHeaderRefusal(annotated!, c.arguments, (k) => fields.get(k));
    assert.equal(refused === null ? "passed" : "refused", c.want, `${c.name}: ${refused}`);
  }
});

test("interop: Mcp-Param headers over HTTP (mcp_param_http)", async () => {
  const app = await chatApp(true, true);
  try {
    const h = g.mcp_param_http;
    const listed = await post(app.url, "events/list", { _meta: meta("tanstack-ai", true) });
    const def = listed.msg.result.events.find((e: { name: string }) => e.name === h.event);
    assert.deepEqual(def.inputSchema, h.input_schema);
    for (const c of h.cases) {
      const name = c.event ?? h.event;
      const params: Record<string, unknown> = { name, arguments: c.arguments, _meta: meta("tanstack-ai", true) };
      if (c.method === "events/subscribe") params.delivery = DELIVERY;
      const before = app.asked.length;
      const { status, msg } = await post(app.url, c.method, params, { "user-agent": "tanstack-ai/1", ...(c.no_name ? {} : { "mcp-name": name }), ...c.headers });
      const refused = status === 400 && msg.error?.code === -32020;
      assert.equal(refused ? "refused" : "passed", c.want, `${c.name}: ${status} ${JSON.stringify(msg)}`);
      if (refused) assert.equal(app.asked.length, before, `${c.name}: asked Wakeshift`);
    }
  } finally {
    await app.close();
  }
});

test("interop: the transport's MCP-Protocol-Version and Mcp-Method on events/* (transport_headers)", async () => {
  const app = await chatApp();
  try {
    for (const c of g.transport_headers.cases) {
      const _meta: Record<string, unknown> = { ...meta("tanstack-ai", true) };
      if (c.meta_version === null) delete _meta["io.modelcontextprotocol/protocolVersion"];
      else _meta["io.modelcontextprotocol/protocolVersion"] = c.meta_version;
      const params: Record<string, unknown> = c.method === "events/list" ? { _meta } : { name: "chat.message", arguments: { channel: "eng" }, _meta };
      if (c.method === "events/subscribe") params.delivery = DELIVERY;
      const h = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "tanstack-ai/1", ...c.headers });
      if (c.method !== "events/list") h.set("mcp-name", "chat.message");
      const before = app.asked.length;
      const res = await fetch(app.url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: c.method, params }) });
      const text = (await res.text()).trim();
      const msg = text.startsWith("{") ? JSON.parse(text) : {};
      const refused = res.status === 400 && msg.error?.code === -32020;
      assert.equal(refused ? "refused" : "passed", c.want, `${c.name}: ${res.status} ${text.slice(0, 300)}`);
      if (refused) assert.equal(app.asked.length, before, `${c.name}: asked Wakeshift`);
    }
  } finally {
    await app.close();
  }
});
