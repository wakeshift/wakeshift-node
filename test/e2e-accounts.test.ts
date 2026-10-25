// End to end against a real core, for an app whose users sign in with
// Wakeshift (accounts: "wakeshift"): run with scripts/e2e.sh, whose harness
// (TestSDKHarness's accounts part) registers the app and signs agents in.
// Skipped without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Wakeshift, isCode, type Agent } from "../src/index.js";

const harness = process.env.WAKESHIFT_SDK_HARNESS;

interface Signed {
  token: string;
  session: string;
  user: string;
}

// A subscription is the agent's its exchanged token names, under its
// person's consent; a personal event reaches only the agent it's to;
// another app's consent doesn't count; serveEvents' tools act as the agent
// the agent option names.
test("events for an app whose users sign in with Wakeshift", { skip: !harness && "set WAKESHIFT_SDK_HARNESS (make sdk-e2e)" }, async () => {
  const h = JSON.parse(readFileSync(harness!, "utf8")) as {
    core: string;
    accounts?: { key: string; mcp: string; ada_claude: Signed; ada_codex: Signed; bob_claude: Signed; other_key: string; other_mcp: string; other_token: string };
  };
  const a = h.accounts;
  assert.ok(a, "the harness has no accounts part: scripts/e2e.sh sets WAKESHIFT_SDK_HARNESS_ACCOUNTS_MCP");
  const wake = new Wakeshift({ key: a.key, core: h.core, mcpUrl: a.mcp, onWarning: () => {} });
  const msg = wake.defineEvent("chat.message", {
    description: "A message for you in a channel.",
    args: z.object({ channel: z.string() }),
    payload: z.object({ from: z.string(), text: z.string() }),
    text: (m, x) => `${m.from} in #${x.channel}: ${m.text}`,
    personal: true,
  });
  await wake.publishManifest({
    description: "Lounge, for the SDKs' tests.",
    accounts: "wakeshift",
    agent: { wake: [{ pattern: "app.lounge.*", description: "Messages" }], post: [], ttl_days: 30 },
  });

  // verifyAccessToken: Wakeshift's token for this app's MCP URL; not another app's.
  const claims = await wake.verifyAccessToken(a.ada_claude.token);
  assert.equal(claims.wakeshift_tenant + "/" + claims.wakeshift_agent, a.ada_claude.user);
  await assert.rejects(wake.verifyAccessToken(a.other_token), /another app/);
  await assert.rejects(wake.verifyAccessToken("not.a.token"), /invalid token/);
  // Wakeshift's header and claims, with a signature of the wrong length.
  const [head, body] = (a.ada_claude.token as string).split(".");
  await assert.rejects(wake.verifyAccessToken(`${head}.${body}.AAAA`), /invalid token/);

  const claude = await wake.exchange(a.ada_claude.token);
  const codex = await wake.exchange(a.ada_codex.token);
  const bob = await wake.exchange(a.bob_claude.token);
  assert.equal(claude.user(), a.ada_claude.user);
  assert.equal(JSON.stringify(claude).includes(claude.token), false, "an Agent never serialises its token");

  const as = (agent: Agent, client: string, session: string) => ({ client, agent, wakeArgs: { session_key: session } });
  // Each agent subscribes its own session.
  const sub = await msg.subscribe({}, { channel: "eng" }, as(claude, "claude-code", a.ada_claude.session));
  assert.ok(sub.created && sub.id);
  await msg.subscribe({}, { channel: "eng" }, as(bob, "claude-code", a.bob_claude.session));
  // Not another agent's session.
  await assert.rejects(msg.subscribe({}, { channel: "eng" }, as(codex, "codex", a.ada_claude.session)), (e: unknown) => isCode(e, "unknown_session"));
  // Not under another app's consent (Ada's sign-in to "other").
  const other = new Wakeshift({ key: a.other_key, core: h.core, mcpUrl: a.other_mcp, onWarning: () => {} });
  const elsewhere = await other.exchange(a.other_token);
  await assert.rejects(msg.subscribe({}, { channel: "eng" }, as(elsewhere, "claude-code", a.ada_claude.session)), (e: unknown) => isCode(e, "bad_agent_token"));

  // A personal emit reaches only the agent it's to.
  assert.equal((await msg.emit({ channel: "eng" }, { from: "bob", text: "hi ada" }, { to: claude.user() })).matched, 1);
  assert.equal((await msg.emit({ channel: "eng" }, { from: "ada", text: "hi bob" }, { to: bob.user() })).matched, 1);
  assert.equal((await msg.emit({ channel: "eng" }, { from: "ada", text: "hi codex" }, { to: codex.user() })).matched, 0, "Codex never subscribed");

  // serveEvents with the agent option: the tools act as the signed-in agent.
  const server = new McpServer({ name: "lounge", version: "1" });
  wake.serveEvents(server, { agent: () => codex });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "codex-mcp-client", version: "1" });
  await client.connect(ct);
  const said = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return (r.content as { text: string }[]).map((c) => c.text).join("\n");
  };
  assert.match(await said("subscribe_events", { event: "chat.message", arguments: { channel: "ops" }, session_key: a.ada_codex.session }), /Subscribed to chat\.message/);
  assert.equal((await msg.emit({ channel: "ops" }, { from: "ada", text: "now codex" }, { to: codex.user() })).matched, 1);
  assert.match(await said("list_subscriptions", {}), /chat\.message \{"channel":"ops"\}/);
  assert.match(await said("unsubscribe_events", { event: "chat.message", arguments: { channel: "ops" }, session_key: a.ada_codex.session }), /Stopped chat\.message/);
  await client.close();

  // A caller that isn't signed in gets no subscription.
  const signedOut = new McpServer({ name: "lounge", version: "1" });
  wake.serveEvents(signedOut, {
    agent: () => {
      throw new Error("not signed in");
    },
  });
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  await signedOut.connect(st2);
  const anon = new Client({ name: "claude-code", version: "1" });
  await anon.connect(ct2);
  const r = (await anon.callTool({ name: "subscribe_events", arguments: { event: "chat.message", arguments: { channel: "eng" } } })) as CallToolResult;
  assert.equal(r.isError, true);
  await anon.close();
});

// The lounge app's key in the current format, which names no app: token
// exchange works with an assertion naming the key (before app()) and the
// app (after), and Sign in with Wakeshift's client is app:<id>.
test("token exchange with a current-format key", { skip: !harness && "set WAKESHIFT_SDK_HARNESS (make sdk-e2e)" }, async () => {
  const h = JSON.parse(readFileSync(harness!, "utf8")) as {
    core: string;
    accounts?: { new_key: string; mcp: string; ada_claude: Signed; ada_codex: Signed };
  };
  const a = h.accounts;
  assert.ok(a?.new_key, "the harness has no accounts.new_key");
  const wake = new Wakeshift({ key: a.new_key, core: h.core, mcpUrl: a.mcp, onWarning: () => {} });
  const claude = await wake.exchange(a.ada_claude.token);
  assert.equal(claude.user(), a.ada_claude.user);
  assert.deepEqual(await wake.app(), { id: "lounge", name: "Lounge" });
  const codex = await wake.exchange(a.ada_codex.token);
  assert.equal(codex.user(), a.ada_codex.user);
  const u = new URL(wake.authorizeUrl({ redirectUri: "https://lounge.test/callback", state: "s", challenge: wake.pkce().challenge }));
  assert.equal(u.searchParams.get("client_id"), "app:lounge");
});
