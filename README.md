# @wakeshift/sdk

Wakeshift lets an MCP server wake the AI agents that use it. Let agents subscribe to things in your app: define your events, add one argument to the tool that starts the work, and Wakeshift wakes the conversation that asked, whether it's Claude Code, Codex, ChatGPT or another.

## Install

```sh
npm install @wakeshift/sdk @modelcontextprotocol/server zod
```

On `@modelcontextprotocol/sdk` 1.x, install `@wakeshift/sdk @modelcontextprotocol/sdk zod` instead.

## Quickstart

A crawler that wakes the conversation that started a crawl:

```ts
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server"
import { z } from "zod"
import { Wakeshift } from "@wakeshift/sdk"

const wake = new Wakeshift() // reads WAKESHIFT_KEY; without one, Wakeshift is off and the server runs as before

const crawlFinished = wake.defineEvent("crawl.finished", {
  description: "A crawl finished",
  args: z.object({ job: z.string() }),
  payload: z.object({ status: z.string(), pages: z.number() }),
})

export const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "crawler", version: "1.0.0" })
  const attached = wake.attach(server)
  attached.registerTool(
    "start_crawl",
    { description: "Crawl a site.", inputSchema: z.object({ url: z.string() }), subscribes: [crawlFinished] },
    async ({ url }, ctx, call) => {
      const job = crypto.randomUUID() // your tool minted the ID, so only this conversation can know it
      await call.subscribe(crawlFinished, { job }, { once: true })
      startCrawl(url, job)
      return `Crawl ${job} started.`
    },
  )
  return server
})

// When the crawl finishes, in your worker or webhook handler:
export async function onCrawlFinished(job: string, pages: number) {
  await crawlFinished.emit({ job }, { status: "completed", pages })
}
```

What just happened:

- **The key comes from `WAKESHIFT_KEY`.** Without one, Wakeshift is off: every call still works, nothing is sent, and your server runs as it would without it. Construction makes no network request.
- **`registerTool` is your MCP SDK's own**, with `subscribes` added and `call` appended to the handler. Your input schema stays yours: Wakeshift adds its arguments in `tools/list` and strips them before your code runs.
- **Only your tools can subscribe to `crawl.finished`**, because it declares neither `personal`, `authorize` nor `public`. That's the safe default for IDs your tool mints.
- **`once` ends the subscription after one delivery**, and a call that fails ends what it subscribed.
- **`emit` wakes every conversation subscribed with those arguments.** Without `text`, the agent reads the description and the arguments.

### No webhook? Watch

If your API can't call you back, check its status until the work is done, and emit once:

```ts
crawlFinished.watch({ job }, async ({ signal }) => {
  const s = await api.status(job, { signal })
  return s.done ? { status: s.state, pages: s.pages } : undefined // undefined: keep waiting
}, { every: "10s", timeout: "2h" })
```

It runs in this process (a restart or a serverless freeze ends it), at most 10 checks at once, and emits once even if a webhook got there first with the same `id`. To start it however the subscription was made, call it from the event's `onSubscribe: ({ args }) => crawlFinished.watch(args, check)`. `await wake.close()` stops every watch on shutdown.

### Tools that wait

A tool that waits for its work without Wakeshift keeps that wait unless `call.wakes` is true after `call.subscribe`. When the agent asks for a wait longer than its program lets one tool call run (`call.callLimit`: Claude Code 60 seconds, Codex 300), `call.shouldSkipWait(waitSeconds)` is true for a conversation Wakeshift wakes: return at once with a plain status, and keep the subscription. Don't promise the wake in your own text: Wakeshift's addition tells the agent.

### Unit tests

```ts
import { createTestClient, createToolCall, withCall } from "@wakeshift/sdk/testing"

const wake = createTestClient()         // enabled and offline: records wake.emits and wake.subscriptions
const call = createToolCall()           // a typed ToolCall for a handler you call directly
await startCrawlHandler({ url: "https://x.test" }, ctx, call)
assert.equal(call.subscriptions[0].event, "crawl.finished")
await withCall(wake, call, () => wrappedHandler()) // wake.currentCall() returns call inside
```

To keep a real client off in tests whatever the environment says, construct it with `new Wakeshift({ key: "" })`. The test client also serves MCP Events push: a client's `events/stream` to a server attached with it gets an event for each matching `emit`.

### Push (`events/stream`)

`attach` serves MCP Events push to clients that hold a stream open, such as opencode and Mastra, wherever Wakeshift offers it. Each stream stays open on your server while Wakeshift delivers to it, so your host must answer a request with a stream (SSE, or stdio):

- **In the MCP SDK's JSON-response mode** (1.x `enableJsonResponse: true`, 2.x `responseMode: "json"`), `attach` doesn't offer push. Webhook and poll still work.
- **Behind middleware that forces JSON responses**, turn it off: `wake.attach(server, { push: false })`.
- **On a host that caps request duration**, `push: { maxStreamMs }` ends each stream before the cap, and the client reconnects without losing events. On Vercel, AWS Lambda and Cloud Run it's set for you (280 seconds, 14 minutes, 55 minutes).
- **Behind a load balancer that drops idle connections**, `push: { maxHeartbeatMs }` asks for heartbeats at least that often. Wakeshift sends them every 10 to 45 seconds.
- **Access is checked again while a stream is open.** Every 5 minutes, `attach` runs `identify` and the event's `authorize` again. If either refuses, the stream ends as a revoked subscription does, and a reconnect is refused. An error in either keeps the stream until the next check. If errors go on, the stream ends once its last successful check is 15 minutes old (three intervals, if longer), and the client reconnects with its cursor, where the checks run again; each failed check logs `push_recheck_failed`, and the end `push_recheck_stale`. A reconnect while they fail gets a retryable error (`-32603`, logged as `push_open_check_failed`), not Forbidden, so the client retries until they answer. `push: { reauthorizeMs }` changes the interval, between 1 and 50 minutes.

**Codex's install offer in its own dialog.** Where Wakeshift turns it on for your app, a subscribing call from Codex can show the user an MCP elicitation form, in Codex's own dialog, with the steps to set up notifications; the user runs them, with no step by the agent. The SDK runs it only within fixed bounds, and only where your transport can carry a request to the client during the call: stdio, or streamable HTTP with sessions, on MCP SDK 2.x. Otherwise, and with `wake.attach(server, { clientRequests: false })`, results keep Wakeshift's usual text. Turn it off behind a proxy that won't hold a response for up to two minutes, or with instances that can't route the client's answer back to the one holding the call.

Signing people in, webhooks, tools registered elsewhere (`wrap` and `wake.currentCall()`), testing, and who may subscribe: [wakeshift.ai/docs](https://wakeshift.ai/docs).

## Compatibility

| | |
| --- | --- |
| Node | 22.12 or later (ES modules; CommonJS loads it with `require()`). Node 20.19 or later runs it too (20.x is past end of life): like 22.12, it has `require()` of ES modules on by default, which `attach` on `@modelcontextprotocol/sdk` 1.x needs |
| MCP SDKs | `@modelcontextprotocol/server` 2.3 or later, or `@modelcontextprotocol/sdk` 1.23 or later |
| zod | 3.25 or later, or 4 |
| TypeScript | 5.8 or later; for CommonJS, `module: nodenext` |
| Cloudflare Workers | with the `nodejs_compat` flag |
| Mastra | `@mastra/mcp` 2.7 or later, through `@wakeshift/sdk/mastra` |
| MCP Events | As accepted (SEP-3415): webhook, poll and push (`events/stream`) for clients that subscribe natively, served by `attach`. Push is offered where your transport can stream (not JSON-response mode); `attach(server, { push: false })` turns it off, and `push: { maxStreamMs, maxHeartbeatMs, reauthorizeMs }` (`PushOptions`) tunes its streams |
| A runtime with no MCP SDK server (xmcp, hand-rolled JSON-RPC) | `@wakeshift/sdk/tools` |
| Unit tests | `@wakeshift/sdk/testing` |
