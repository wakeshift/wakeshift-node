// Client requests (src/clientrequests.ts):
// the shared vectors (test/client-requests.json), then the form end to end
// with an MCP client that answers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer, Client, InMemoryTransport, MCP } from "./mcp.js";
import { Wakeshift } from "../src/index.js";
import { CLIENT_REQUEST_BOUNDS, offersForm, outcomeKey, requestPrefix, resetRecentForms, validateRequest, type ClientRequest } from "../src/clientrequests.js";
import { captureLog } from "./logs.js";

const vectors = JSON.parse(readFileSync(new URL("../../test/client-requests.json", import.meta.url), "utf8"));

// expand turns {N x} and {N lines} into their strings.
function expand(v: unknown): unknown {
  if (typeof v === "string") {
    const x = /^\{(\d+) x\}$/.exec(v);
    if (x) return "x".repeat(Number(x[1]));
    const l = /^\{(\d+) lines\}$/.exec(v);
    if (l) return Array(Number(l[1])).fill("x").join("\n");
    return v;
  }
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
  return v;
}

function requestOf(vec: any): any {
  if (vec.request) return expand(vec.request);
  const r = structuredClone(vectors.validate[vec.base].request);
  Object.assign(r, expand(vec.patch ?? {}));
  if (vec.drop_outcome) delete r.outcomes[vec.drop_outcome];
  if (vec.patch_outcome) {
    const { key, ...rest } = vec.patch_outcome;
    Object.assign(r.outcomes[key], expand(rest));
  }
  return r;
}

test("the bounds are the shared ones", () => {
  const b = vectors.bounds;
  assert.deepEqual(
    [b.message_max, b.message_lines_max, b.title_max, b.fields_max, b.options_max, b.outcome_text_max, b.timeout_ms, b.report_wait_ms, b.session_window_ms],
    [CLIENT_REQUEST_BOUNDS.messageMax, CLIENT_REQUEST_BOUNDS.messageLinesMax, CLIENT_REQUEST_BOUNDS.titleMax, CLIENT_REQUEST_BOUNDS.fieldsMax, CLIENT_REQUEST_BOUNDS.optionsMax,
      CLIENT_REQUEST_BOUNDS.outcomeTextMax, CLIENT_REQUEST_BOUNDS.timeoutMs, CLIENT_REQUEST_BOUNDS.reportWaitMs, CLIENT_REQUEST_BOUNDS.sessionWindowMs],
  );
  assert.equal(requestPrefix("Shipyard"), vectors.prefix.replace("{app}", "Shipyard"));
  assert.equal(requestPrefix(""), "Wakeshift, for an app:");
});

for (const vec of vectors.validate) {
  test(`validate: ${vec.name}`, () => {
    assert.equal(validateRequest(requestOf(vec), vec.app), vec.want);
  });
}

for (const vec of vectors.outcome) {
  test(`outcome: ${vec.name}`, () => {
    const r = requestOf(vectors.validate[vec.base]) as ClientRequest;
    assert.equal(outcomeKey(vec.result, r), vec.want);
  });
}

for (const vec of vectors.offer) {
  test(`offer: ${vec.name}`, () => {
    assert.equal(offersForm({ capabilities: vec.capabilities, protocol: vec.protocol, http: vec.http, session: vec.session, off: vec.off, recent: vec.recent }), vec.want);
  });
}

// ── End to end ───────────────────────────────────────────────────────────

const KEY = "wst_1116qJFWMMHFy3xDdLmvUeyc2S6FrWRhJP51HsvDYdz9fWXzSV";
const TOKEN = "wse_00000000-0000-4000-8000-000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function core(request: unknown, always = false) {
  const bodies: { path: string; body: any }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://core.test/api/apps/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    bodies.push({ path, body });
    const json = path.startsWith("/manifest")
      ? {}
      : path === "/event-subscriptions"
        ? { event_subscription: { id: "sub-1", created: true }, session: "wsc_s1", pending: "pa_1" }
        : path === "/calls/addition"
          ? {
              text: "Today's text.",
              trailer: "",
              meta: { "wakeshift/connector": "beacon-1" },
              ...(always || body?.call?.client_requests?.includes("elicit.form") ? { requests: [request] } : {}),
            }
          : path === "/app"
            ? { id: "shipyard", name: "Shipyard" }
            : path === "/requests/outcome"
              ? { recorded: true }
              : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const log = captureLog();
  const wake = new Wakeshift({ key: KEY, core: "https://core.test", fetch: fetchFn, logger: log.logger, logLevel: "debug" } as any);
  const build = wake.defineEvent("build.finished", { description: "A build finished", args: z.object({ n: z.number().int() }), payload: z.object({}) });
  return { wake, build, bodies, log };
}

async function run(answer: ((params: any) => any) | null, request: unknown, attachOpts: Record<string, unknown> = {}, always = false) {
  resetRecentForms();
  const c = core(request, always);
  const server = new McpServer({ name: "shipyard", version: "1" });
  const attached = c.wake.attach(server, attachOpts as any);
  attached.registerTool("watch_build", { inputSchema: { n: z.number().int() }, subscribes: [c.build] }, async ({ n }, _extra, call) => {
    await call.subscribe(c.build, { n });
    return "Watching.";
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "codex-mcp-client", version: "0.170.0" }, answer ? ({ capabilities: { elicitation: { form: {} } } } as any) : undefined);
  const asked: any[] = [];
  if (answer) {
    (client as any).setRequestHandler(MCP === 2 ? "elicitation/create" : (await import("@modelcontextprotocol/sdk/types.js")).ElicitRequestSchema, async (req: any) => {
      asked.push(req.params);
      return answer(req.params);
    });
  }
  await Promise.all([server.connect(a), client.connect(b)]);
  const result = (await client.callTool({ name: "watch_build", arguments: { n: 1 } })) as any;
  await c.wake.close();
  const texts = (result.content as any[]).filter((x) => x.type === "text").map((x) => x.text);
  const addition = c.bodies.find((x) => x.path === "/calls/addition")!.body;
  const reports = c.bodies.filter((x) => x.path === "/requests/outcome").map((x) => x.body);
  return { texts, result, asked, addition, reports, log: c.log };
}

const form = () => structuredClone(vectors.validate[0].request);

test("end to end: the form in the client's dialog, the answer's text before the app's, the outcome reported", { skip: MCP !== 2 && "MCP SDK 2.x only (ctx.mcpReq.elicitInput)" }, async () => {
  const r = await run(() => ({ action: "accept", content: { choice: "setup" } }), form());
  assert.deepEqual(r.addition.call.client_requests, ["elicit.form"]);
  assert.equal(r.asked.length, 1);
  assert.ok(r.asked[0].message.startsWith("Wakeshift, for Shipyard:\nShipyard sends its notifications"), r.asked[0].message);
  assert.deepEqual(r.asked[0].requestedSchema, form().schema);
  assert.deepEqual(r.texts, ["Set up.\n\nWatching."], "the answer's text, placed before the app's (a string result stays one block)");
  assert.deepEqual(r.reports, [{ token: TOKEN, outcome: "choice=setup" }]);
  assert.equal(r.result._meta?.["wakeshift/connector"], "beacon-1");
});

test("end to end: decline keeps today's text where the core put it, and the beacon", { skip: MCP !== 2 && "MCP SDK 2.x only" }, async () => {
  const r = await run(() => ({ action: "decline" }), form());
  assert.deepEqual(r.texts, ["Watching.\n\nToday's text."]);
  assert.deepEqual(r.reports, [{ token: TOKEN, outcome: "decline" }]);
});

test("end to end: a request past the bounds is never shown; today's text, reported unsupported", { skip: MCP !== 2 && "MCP SDK 2.x only" }, async () => {
  const r = await run(() => ({ action: "accept", content: { choice: "setup" } }), { ...form(), kind: "elicit.url" });
  assert.equal(r.asked.length, 0, "nothing shown");
  assert.deepEqual(r.texts, ["Watching.\n\nToday's text."]);
  assert.deepEqual(r.reports, [{ token: TOKEN, outcome: "unsupported" }]);
  assert.ok(r.log.lines.some((l) => l.message.includes("past this SDK's bounds (kind)")));
});

test("end to end: a client that doesn't take forms, attach's clientRequests: false, and MCP SDK 1.x offer nothing", async () => {
  const none = await run(null, form());
  assert.equal(none.addition.call.client_requests, undefined);
  assert.deepEqual(none.texts, ["Watching.\n\nToday's text."]);
  const off = await run(() => ({ action: "accept", content: { choice: "setup" } }), form(), { clientRequests: false });
  assert.equal(off.addition.call.client_requests, undefined);
  assert.equal(off.asked.length, 0);
  if (MCP !== 2) {
    const v1 = await run(() => ({ action: "accept", content: { choice: "setup" } }), form());
    assert.equal(v1.addition.call.client_requests, undefined, "1.x: no request channel in this release");
  }
});

test("a request the call didn't offer is never shown (attach's clientRequests: false, a client without forms, MCP SDK 1.x)", async () => {
  for (const [name, answer, opts] of [
    ["off", () => ({ action: "accept", content: { choice: "setup" } }), { clientRequests: false }],
    ["no forms", null, {}],
  ] as const) {
    const r = await run(answer as any, form(), opts as any, true);
    assert.equal(r.asked.length, 0, name);
    assert.deepEqual(r.texts, ["Watching.\n\nToday's text."], name);
    assert.deepEqual(r.reports, [{ token: TOKEN, outcome: "unsupported" }], name);
  }
});
