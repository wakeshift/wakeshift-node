# @wakeshift/sdk

Let agents subscribe to things in your app. You define the events your app offers, serve them on your MCP server, and emit them when they happen; Wakeshift wakes every subscribed agent, whether it's Claude Code, Codex, ChatGPT or another. Your events follow MCP Events: clients that speak it subscribe natively, and Wakeshift bridges every other agent. You don't deal with harnesses.

Node 22 or later. The package is ESM-only: load it with `import`, from an ES module (`"type": "module"`, or a `.mjs` or `.mts` file). It has no CommonJS build, so `require("@wakeshift/sdk")` works only where Node can require ES modules. Peer dependencies: `@modelcontextprotocol/sdk` (1.23 or later: the first that takes zod 4) and `zod` (3.25 or later, or 4). Import `z` from `"zod"`, not `"zod/v4"`: the SDK's schemas are built from `"zod"`, and the MCP SDK refuses a schema that mixes the two.

## Install

```sh
npm install @wakeshift/sdk @modelcontextprotocol/sdk zod
```

Install the package, not a checkout of this repository (a `file:` dependency): a `file:` dependency links the directory along with its `node_modules`, so the SDK can load its own development copy of zod instead of yours, and the MCP SDK then fails with "Mixed Zod versions detected in object shape". To try a change of your own, `npm pack` and install the tarball it writes.

## Quickstart: a CI bot

You have an MCP server and a GitHub webhook handler. Register an app in the Wakeshift console (Build), and put its key in `WAKESHIFT_KEY` (`wst_` and 50 characters). The SDK talks to `https://app.wakeshift.ai` unless `WAKESHIFT_CORE` names another address. Load them however you load environment variables, for example `node --env-file=.env server.ts`.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { Wakeshift } from "@wakeshift/sdk"

const wake = new Wakeshift({ key: process.env.WAKESHIFT_KEY! })

const ciFinished = wake.defineEvent("ci.finished", {
  description: "CI finished on a GitHub repo",
  args: z.object({ owner: z.string(), repo: z.string(), branch: z.string().optional() }),
  payload: z.object({ branch: z.string(), conclusion: z.string(), name: z.string(), url: z.string() }),
  authorize: (subscriber, { owner, repo }) => canSeeRepo(subscriber, `${owner}/${repo}`),
  text: (run, { owner, repo }) => `CI ${run.conclusion} on ${owner}/${repo} ${run.branch}: ${run.name}`,
})

// One McpServer per MCP session; serve the events before connecting it.
const server = new McpServer({ name: "ci-bot", version: "1.0.0" })
wake.attach(server)
```

```ts
// In your GitHub webhook handler, after checking X-Hub-Signature-256:
if (req.headers["x-github-event"] === "workflow_run" && body.action === "completed") {
  const run = body.workflow_run
  const [owner, repo] = body.repository.full_name.toLowerCase().split("/")
  await ciFinished.emit(
    { owner, repo },
    { branch: run.head_branch, conclusion: run.conclusion, name: run.name, url: run.html_url },
    { id: String(req.headers["x-github-delivery"]) },
  )
}
```

That's all. An agent subscribes with the `subscribe_events` tool `attach` adds (ChatGPT subscribes natively), and is woken with the text and payload of each occurrence for its repo, framed as information from your app, not as instructions from its user. A subscriber that names a `branch` only gets that branch's occurrences.

- `owner` and `repo` are required, so they route occurrences; their values are lowercase IDs (`a-z 0-9 . _ -`). The optional `branch` filters on the payload's `branch`.
- `attach` adds `subscribe_events`, `unsubscribe_events` and `list_subscriptions`, and touches no other tool or result.
- Native subscriptions (ChatGPT) and personal events need a signed-in user: pass `identify` to `attach`, or use `GuestAuth` (below).

## Events

Events follow MCP Events (SEP-3415): you define the event types your app offers, serve them, and emit occurrences. Clients that speak MCP Events, such as ChatGPT, subscribe natively; every other agent subscribes with the `subscribe_events` tool `attach` adds, and Wakeshift wakes it its own way. You write no subscribe tool and handle no harnesses.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { Wakeshift, guestOf } from "@wakeshift/sdk"

const wake = new Wakeshift({ key: process.env.WAKESHIFT_KEY! })

const message = wake.defineEvent("chat.message", {
  description: "A new message in a channel",
  args: z.object({ channel: z.string() }),
  payload: z.object({ from: z.string(), text: z.string() }),
  text: (m) => `${m.from}: ${m.text}`,
})

// A personal event: each subscription belongs to its subscriber, and an
// occurrence goes to one of them, so it can carry their own private view.
const turn = wake.defineEvent("game.turn", {
  description: "It's your move at a table",
  args: z.object({ table: z.string() }),
  payload: z.object({ hole: z.array(z.string()), toCall: z.number() }),
  text: (t) => `Your move: ${t.toCall} to call`,
  personal: true,
})

// One server per connection; attach before connecting it.
const server = new McpServer({ name: "chat", version: "1.0.0" })
wake.attach(server, { identify: (extra) => ({ user: guestOf(extra)?.user }) })

// When something happens:
await message.emit({ channel: "eng" }, { from: "ada", text: "shipped it" })
await turn.emit({ table: "juniper" }, { hole: ["As", "Kd"], toCall: 2 }, { to: "guest:abc123" })
```

- **`wake.defineEvent(name, { description, args, payload, text, authorize?, personal? })`** returns the event. `args` is what a subscriber picks; its required string, integer and boolean fields route occurrences, so their values are lowercase IDs (a-z 0-9 . _ -), and an optional one filters on the payload field of the same name. `authorize(subscriber, args)` decides who may subscribe. Define every event before `attach`.
- **`event.emit(args, payload, { id?, to? })`** checks the payload against its schema and sends it to everyone subscribed with those arguments; a personal event goes to the one subscriber `to` names (the `user` attach's `identify` gives for them). `id` makes retries emit once.
- **`wake.attach(server, { identify? })`** attaches Wakeshift to your MCP server. Today it serves `events/list`, `events/subscribe` and `events/unsubscribe` to clients that speak MCP Events, and adds `subscribe_events` (for everyone else), `unsubscribe_events` and `list_subscriptions` (for every client, so a person can always see and stop what they're subscribed to). `identify(extra)` says who is behind a request, as `{ user }`, the app's ID for the person; by default, the guest `GuestAuth` signed in. The events go into your manifest on first use; `publishManifest` adds them too.
- **`event.subscribe(extra, args, { server or client, user?, wakeArgs? })`** subscribes the conversation calling one of your own tools, the way `subscribe_events` would, so a tool like "join" can set up its wakes in one step; it gives back the subscription's `id`, the conversation's `session` (its `session_key`) and `result(text)`, your tool's text with what the agent needs added. Your tool decides who may (`authorize` isn't consulted). Clients that speak MCP Events subscribe themselves. **`event.unsubscribe(extra, args, …)`** ends the calling conversation's subscription with those arguments (for a tool like "unwatch"); **`event.end(user, id)`** ends one of a user's subscriptions by its ID.

## Reference

### `new Wakeshift({ key, core?, fetch?, timeoutMs?, onWarning? })`

- `key`: `wst_` and 50 characters. It's your app's Ed25519 private key; it never goes over the wire. Each request carries a fresh assertion signed with it (valid two minutes). Older keys, `wst_test_<app>_<seed>` and `wst_live_<app>_<seed>`, keep working.
- `core`: the address of the console the key came from. Default: `WAKESHIFT_CORE` from the environment, else `https://app.wakeshift.ai`. An older `wst_test_` key has no default: it needs one of the two, and the constructor throws without them.
- `onWarning(message)`: called once per kind of problem that doesn't fail a call, such as a tool call Wakeshift recognised no harness in. Default: `console.warn`.
- `await wake.app()`: `{ id, name }`, which app the key is, as Wakeshift says. It asks once and remembers the answer.
- `wake.appId`: the app's ID. A current key doesn't name its app, so this throws until `await wake.app()` has answered; an older key names it. `wake.core`: the address in use. `wake.mode` is deprecated: `"test"` or `"live"` for an older key, `null` for a current one.

### The caller

For your own tools that subscribe (`event.subscribe`) and for topics.


- `wake.call(extra, { server, user?, args?, session?, harness?, conversation?, client? })` packs a tool call from an MCP tool callback's `extra`: its `_meta` (Codex sends its thread there), the request's User-Agent (from `extra.requestInfo`), the client's name (from `server`'s client info; or pass `client` yourself, for example on a stateless server), `user` (your ID for the person; their conversations are grouped, and `u/<user>/…` topics are theirs), and `session_key`, `harness` and `conversation_id` from `args`.
- `wake.callOf({ meta, clientName, user?, session?, userAgent?, harness?, conversation? })` does the same without an MCP framework.
- `wake.args`: a zod shape with `session_key`, `harness` and `conversation_id` (`SESSION_ARG`, `HARNESS_ARG`, `CONVERSATION_ARG`), to spread into your subscribe tool's `inputSchema` (and any tool whose results you annotate).

### Topics

Topics are what events are built on; use them directly for publish URLs, `send` and a subscribe tool of your own with `once` or `replay`. Lowercase segments of `a-z 0-9 . _ -` joined by `/`, up to 200 characters, scoped to your app. `u/<user>/…` is private: Wakeshift refuses to subscribe a caller whose `user` isn't `<user>`. So a user with private topics needs an ID that is itself a topic segment (lowercase `a-z 0-9 . _ -`): use an opaque ID, or a hash of yours, not an email. Every other topic is shared, so check access before `subscribe`, and when someone loses access, end their subscriptions with `unsubscribeUser` (or `endSubscription`). Don't put secrets in topic names.

### Calls

| Call | Returns |
| --- | --- |
| `subscribe(call, topic, { filter?, once?, replay?, ttl? })` | `{ id, topic, filter, once, expiresAt, session, addition, agent, result(textOrResult) }`. `agent`: `{ harness, via, claimed }`, what Wakeshift recognised the caller as and by which signal (`"client"`, `"meta"`, `"user_agent"`, or `"claim"` when only the agent's `harness` named it), both `null` when nothing; `claimed` is what the agent said (normalized), or `null`, and one that differs from `harness` was ignored. `filter`: equality on top-level fields of the event's `data`. `once`: end after the first delivery. `replay`: deliver the latest event published within this long before subscribing (at most `"24h"`). `ttl`: end after this long without a delivery or a fresh subscribe (default `"30d"`). Durations are seconds or `"90s"`, `"5m"`, `"2h"`, `"30d"` (whole days). Subscribing again refreshes it. `result` returns your text (or `CallToolResult`) followed by Wakeshift's text, with its `_meta`. |
| `unsubscribe(call, topic?)` | How many of the calling conversation's subscriptions ended (all your topics without `topic`). |
| `unsubscribeUser(user, topic?)` | How many ended: every conversation of `user` stops getting `topic` (all your topics without it). Each conversation is told you ended it. For when someone loses access. |
| `endSubscription(subscriptionId)` | `true` if it ended one subscription (its conversation is told you ended it); `false` if it had already ended or isn't yours. |
| `publish(topics, { text, data?, id? })` | `{ matched, duplicate }`. `topics`: one or up to 20. `text` at most 1000 bytes; `data` a JSON object within the 64 KB request limit. The same `id` within a day publishes once (`duplicate: true`); after a day, it publishes again. |
| `send(subscriptionId, event)` | `"delivered"` (connected, on its way), `"queued"` (waits for the conversation) or `"closed"` (the subscription ended). Ignores the filter. |
| `topicStatus(topic)` | `{ topic, subscriptions, connected, via: { stream, poll, hooks, webhook } }`: how many conversations are subscribed, and how many are connected now and how (`stream`: a stream held open; `poll`: waiting or polling; `hooks`: Wakeshift's hooks or plugin on the user's machine; `webhook`: a client subscribed natively, such as ChatGPT). Only reads. |
| `subscriptionStatus(subscriptionId)` | `{ id, topic, status: "active" \| "closed", connected, via?, expiresAt? }`. Only reads. |
| `publishUrl(topic)` | `{ id, topic, url }`: anyone can POST to `url` to publish to `topic` (a JSON object body becomes `data`; `Idempotency-Key` or `X-GitHub-Delivery` dedupes). |
| `revokePublishUrl(id)` | The URL answers 410 from then on. |
| `annotate(call, result)` | A copy of `result` with what Wakeshift adds for this conversation (messages waiting for an agent that can't be woken, or what an agent needs to reconnect; usually nothing). Only results you pass here (and `sub.result`) change. `addition(call)` returns the raw `{ text?, meta?, agent }`. |
| `closeTopic(topic)` | How many subscriptions ended. Each conversation gets what was already published to it, then a notice. |
| `forgetUser(user)` | `false` if there was nothing to forget. Deletes everything Wakeshift keeps for the user: their conversations, subscriptions, events and deliveries, stream links (open streams close), recent publishes to their `u/<user>/…` topics and publish URLs for them, and their ID. Your app's log records that a user was forgotten, without their ID or anything derived from it. Their subscription IDs stay known as closed. |

### Guest sign-in: `new GuestAuth({ wake, mcpUrl, … })`

An OAuth server inside your app that signs MCP clients in as guests, with no user step ([Your users](https://wakeshift.ai/docs/users) has the walkthrough). Each registered client is one guest, with its own workspace and an agent named after its harness.

- `await guests.handle(req, res)`: serves `/.well-known/oauth-protected-resource` (and `…/mcp`), `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize` and `/oauth/token`; `false` for any other request. Works with `node:http` and Express (a body a parser already read is used as it is).
- `guests.authenticate(req, res)`: the guest for the request's bearer token, and `req.auth` set for the MCP transport; or `null` after answering 401 with `WWW-Authenticate: Bearer resource_metadata="…"`.
- `guestOf(extra)` in a tool callback: `{ user, workspace, agent, client, expires }`. Pass `user` and `client` to `wake.call`.
- `guests.verify(token)`: the guest, or `null`.
- Options: `base` (default `mcpUrl` without `/mcp`), `accessTtl` (seconds, default 3600), `refreshTtl` (default 30 days), `revoked(guest, issuedAt)`, `proxyHops`, `registerLimit` (default 20) and `tokenLimit` (default 60) per address per `rateWindow` (default 600 seconds), `grants` (also give each guest's agent a grant for the manifest's agent scope, as the Go SDK does), `onError`.
- A refresh returns a new refresh token; the old one works until it expires (nothing is stored). `wake.forgetUser(guest.user)` refuses all the guest's refreshes from then on, and `revoked` refuses the ones you choose, such as those issued before a cutoff.

### Manifest and workspaces

- `wake.publishManifest({ description?, agent?, events? })`: what your app may do; returns it as Wakeshift keeps it. `agent`: `{ wake, post, ttl_days, wake_limits?, start_prompt? }`, each scope event `{ pattern, description }`: what the agents in the workspaces your app keeps may be woken by and post.
- Your app identifies its own users, with `GuestAuth` or its own sign-in, and acts for the agents in the workspaces it keeps.
- `wake.workspace(user, name)`, `wake.addAgent(workspace, agent, displayName)`, `wake.checkAgent(workspace, agent)`: the workspace Wakeshift keeps for one of your users, an agent in it with a grant for your manifest's agent scope, and whether that grant is live. `GuestAuth` uses these; topics don't need them.
- `harnessAgent(clientName)`: the agent ID a client name maps to (`"Claude Code"` is `claude-code`), as Wakeshift names it.

### Errors

API errors throw `WakeshiftError` with `status` and `code`, the same codes as the [HTTP API](https://wakeshift.ai/docs/http-api)'s, plus `unreachable`:

| Status | Code | When |
| --- | --- | --- |
| `400` | `bad_request` | Something in the request is invalid, including a field the API doesn't take. The message says what. |
| `401` | `unauthenticated` | The assertion was refused: expired, reused, signed with another key, or for another `aud` (a key for another Wakeshift). The message says which. |
| `400` | `bad_arguments` | An event's arguments don't match its schema, or a routing value isn't a lowercase ID. |
| `403` | `private_topic` | Subscribing a caller to another user's `u/<user>/…` topic. |
| `403` | `other_client` | The `session` key is a conversation in another MCP client of the same user. Call again without it. |
| `404` | `unknown_subscription` | The subscription ID isn't one of your app's. |
| `404` | `unknown_publish_url` | The publish URL ID isn't one of your app's. |
| `404` | `unknown_event` | Your app offers no event by that name. |
| `413` | `too_large` | The request body is over 64 KB. The limit is on the whole body, so `data` must leave room for the rest of the request. |
| `0` | `unreachable` | No answer at all: a wrong `core`, a network problem, or the timeout. The message names the core it tried. |

`isCode(err, "private_topic")` checks one.

## Documentation

The guides and the full reference are at [wakeshift.ai/docs](https://wakeshift.ai/docs): the [quickstart](https://wakeshift.ai/docs/quickstart), [events](https://wakeshift.ai/docs/events), [your users](https://wakeshift.ai/docs/users) and [the TypeScript SDK](https://wakeshift.ai/docs/sdk). The same calls are in the [Go](https://github.com/wakeshift/wakeshift-go) and [Python](https://github.com/wakeshift/wakeshift-python) SDKs.

## Development

```sh
npm ci
npm run typecheck
npm test          # unit tests (node:test) and the README's examples
npm run build     # dist/
```

The end-to-end tests (`test/e2e*.test.ts`) run against a Wakeshift server, so they run in Wakeshift's own repository and skip here.

## Contributing and security

This repository is generated from Wakeshift's main repository. Pull requests are welcome: we apply them there and publish the result. See [CONTRIBUTING](CONTRIBUTING.md). Report a security problem privately to support@wakeshift.ai, not in an issue ([SECURITY](SECURITY.md)).

## License

Apache License 2.0; see [LICENSE](LICENSE).
