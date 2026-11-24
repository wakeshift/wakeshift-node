// headerMismatchAs400 (src/events.ts) hooks the transport a server connects
// to, so a mismatched Mcp-Name goes out as HTTP 400. Only a web-standard
// transport's handleRequest(req: Request, options) is checked: a Node-style
// transport with the same method names, handleRequest(req: IncomingMessage,
// res, body), as mcp-proxy bundles for FastMCP (TypeScript), passes through
// with every argument (such a server answered every request with a 500
// before: req.headers.get is not a function).
import { test } from "node:test";
import assert from "node:assert/strict";
import { headerMismatchAs400 } from "../src/events.js";

function fakeServer() {
  const server = { connect: async (_t: unknown) => undefined };
  headerMismatchAs400(server);
  return server;
}

test("a Node-style transport (req, res, body) passes through the hook, every argument kept", async () => {
  const seen: unknown[][] = [];
  const transport = {
    async handleRequest(...args: unknown[]) {
      seen.push(args);
    },
    async handlePostRequest() {},
  };
  await fakeServer().connect(transport);
  const req = { method: "POST", headers: { "mcp-method": "events/subscribe", "mcp-name": "other.event" } };
  const res = { writeHead() {} };
  const body = { jsonrpc: "2.0", id: 1, method: "events/subscribe", params: { name: "chat.message" } };
  await transport.handleRequest(req, res, body);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]![0], req);
  assert.equal(seen[0]![1], res);
  assert.equal(seen[0]![2], body, "the parsed body reaches the transport");
});

test("a Node-style transport's handleMessage with a Node request passes through", async () => {
  const seen: unknown[][] = [];
  const transport = {
    async handleMessage(...args: unknown[]) {
      seen.push(args);
    },
  };
  await fakeServer().connect(transport);
  const extra = { request: { headers: { "mcp-method": "events/poll", "mcp-name": "other.event" } } };
  await transport.handleMessage({ jsonrpc: "2.0", id: 1, method: "events/poll", params: { name: "chat.message" } }, extra, "third");
  assert.deepEqual(seen, [[{ jsonrpc: "2.0", id: 1, method: "events/poll", params: { name: "chat.message" } }, extra, "third"]]);
});

test("a web-standard transport still refuses a mismatched Mcp-Name with HTTP 400", async () => {
  let called = 0;
  const transport = {
    async handleRequest(..._args: unknown[]) {
      called++;
      return new Response("ok");
    },
    async handlePostRequest() {},
  };
  await fakeServer().connect(transport);
  const body = { jsonrpc: "2.0", id: 1, method: "events/subscribe", params: { name: "chat.message" } };
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-method": "events/subscribe", "mcp-name": "other.event" },
    body: JSON.stringify(body),
  });
  const res = (await transport.handleRequest(req, { parsedBody: body })) as Response;
  assert.equal(res.status, 400);
  assert.equal(called, 0);
});
