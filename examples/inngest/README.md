# Wake the agent when an Inngest function finishes

An MCP server whose tool starts an [Inngest](https://www.inngest.com) function, and a function that wakes the agent that started it when it finishes. The agent doesn't poll or keep its turn open: it ends its turn, and [Wakeshift](https://wakeshift.ai) wakes the same conversation (Claude Code, Codex, Cursor and others) when the report is ready or has failed.

```text
agent ── start_report ──▶ MCP server ── inngest.send ──▶ Inngest function
  ▲                                                          │
  └──────────── Wakeshift wakes the conversation ◀── emit ───┘ (last step.run / onFailure)
```

## What's in it

| File | What it does |
| --- | --- |
| [`src/events.ts`](src/events.ts) | The Wakeshift client and the `report.finished` event. |
| [`src/inngest.ts`](src/inngest.ts) | The Inngest client, the `app/report.requested` event and the `generate-report` function. The function does the work (here, a 20-second `step.sleep`), then emits `report.finished` in its last `step.run`, or from `onFailure` once every retry has failed. |
| [`src/server.ts`](src/server.ts) | The MCP server on `/mcp`, and the Inngest functions on `/api/inngest`. `start_report` subscribes the calling conversation to its report, then sends the event that starts the function. `watch_report` subscribes another conversation to a report that's still running, or answers at once if it already finished. |
| [`test/report.test.ts`](test/report.test.ts) | Runs the function with [`@inngest/test`](https://www.npmjs.com/package/@inngest/test) and `emit` mocked, and checks what it emits. |

The heart of it is the function's last step:

```ts
export const generateReport = inngest.createFunction(
  { id: "generate-report", triggers: [reportRequested], retries: 3 },
  async ({ event, step }) => {
    const { report, topic } = event.data
    const result = await step.run("write-report", () => writeReport(topic))

    await step.run("wake-the-agent", () =>
      reportFinished.emit({ report }, { status: "ready", topic, ...result }, { id: `${report}-finished` }),
    )
  },
)
```

## Run it

You need Node 22.18 or later and [Claude Code](https://claude.com/claude-code) to test with. Any MCP client works the same way. Locally, Inngest runs as its Dev Server, with no account.

1. **Install.**

   ```sh
   npm ci --ignore-scripts
   cp .env.example .env
   ```

2. **Wakeshift.** Make an app key; this writes `WAKESHIFT_KEY` to `.env` and opens the console to confirm it:

   ```sh
   npx -y @wakeshift/cli init
   ```

   Or sign in to the [Wakeshift console](https://app.wakeshift.ai), choose **New app**, and paste its key into `.env`.

3. **Start both**, each in its own terminal:

   ```sh
   npm start             # the MCP server on http://localhost:3000/mcp, functions on /api/inngest
   npm run dev:inngest   # the Inngest Dev Server, on http://localhost:8288
   ```

   `dev:inngest` runs `npx --ignore-scripts=false inngest-cli@1.49.0 dev`: the CLI downloads its binary in an install script, so this one command allows it.

4. **Connect Claude Code.**

   ```sh
   claude mcp add --transport http reports http://localhost:3000/mcp
   ```

5. **Ask for a report.**

   ```text
   Start a report on vector databases.
   ```

## What you'll see

Claude Code calls `start_report`. The first time, it asks whether to install Wakeshift's plugin for Claude Code, showing the exact command. Say yes, type `/reload-plugins` and send any message. If you say no, it starts a background monitor for this session (in manual permission mode, Claude Code asks you to approve it); Claude Code ends a monitor after 30 minutes, so the agent starts it again every 25. Then it ends its turn.

To have a recent Claude Code in the terminal wait on your server instead of a monitor, with no restarts, pass `tools: { wait: { enabled: true } }` to `wake.attach` in `src/server.ts`. Your server then keeps a request open for each waiting conversation; on a serverless host, give the function a timeout of at least 30 seconds. See [the wait tool for Claude Code](https://wakeshift.ai/docs/agents#the-wait-tool-for-claude-code).

About 20 seconds later the function's last step emits, and Claude Code wakes in the same conversation with:

```text
Report 0b7c6f3e-… on "vector databases" is ready: 5 sources on vector databases, about 1,200 words. https://example.com/reports/0b7c6f3e-…
```

It goes on from there: it can summarize the report, open it, or start the next step. If the function fails on every attempt, it wakes with `… failed: <the error>` instead. The run and each step show in the Dev Server at http://localhost:8288.

## Test

```sh
npm test        # the function, run by @inngest/test, with emit mocked
npm run typecheck
```

The test needs no Inngest server or Wakeshift key.

## Going further

- **Who may watch.** This server has no sign-in, so a report's random ID is what lets a conversation subscribe to it. With your own sign-in, pass `identify` to `wake.attach` and check in `watch_report` that the report is the caller's ([your users](https://wakeshift.ai/docs/users)).
- **Where reports live.** `reports` is an in-memory map, which works here because the functions run in the same process as the MCP server. Keep it in your database.
- **Emit in a step.** Emitting inside `step.run` means a retried function doesn't emit again once that step has succeeded, and the `id` makes a retry of the step itself emit once.
- **Deploying.** Remove `INNGEST_DEV`, set `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`, and sync your app's `/api/inngest` URL in the Inngest dashboard.

[Wakeshift's docs](https://wakeshift.ai/docs) cover events, sign-in and how each agent is woken.
