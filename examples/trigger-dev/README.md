# Wake the agent when a Trigger.dev task finishes

An MCP server whose tool starts a [Trigger.dev](https://trigger.dev) task, and a task that wakes the agent that started it when it finishes. The agent doesn't poll or keep its turn open: it ends its turn, and [Wakeshift](https://wakeshift.ai) wakes the same conversation (Claude Code, Codex, Cursor and others) when the report is ready or has failed.

```text
agent ── start_report ──▶ MCP server ── tasks.trigger ──▶ Trigger.dev task
  ▲                                                          │
  └──────────── Wakeshift wakes the conversation ◀── emit ───┘ (onSuccess / onFailure)
```

## What's in it

| File | What it does |
| --- | --- |
| [`src/events.ts`](src/events.ts) | The Wakeshift client and the `report.finished` event, shared by the server and the task. |
| [`src/server.ts`](src/server.ts) | The MCP server. `start_report` subscribes the calling conversation to its report, then triggers the task. `watch_report` subscribes another conversation to a report that's still running, or answers at once if it already finished. |
| [`src/trigger/report.ts`](src/trigger/report.ts) | The `generate-report` task. It does the work (here, a 20-second wait), then emits `report.finished` from its `onSuccess` hook, or from `onFailure` once every retry has failed. |
| [`test/report.test.ts`](test/report.test.ts) | Runs the task's code with Trigger.dev and Wakeshift mocked, and checks what it emits. |

The heart of it is the task's hooks:

```ts
export const generateReport = task({
  id: "generate-report",
  run: async ({ report, topic }: ReportPayload) => {
    // ... the long work ...
    return { summary, url }
  },
  onSuccess: async ({ payload, output }) => {
    await reportFinished.emit(
      { report: payload.report },
      { status: "ready", topic: payload.topic, summary: output.summary, url: output.url },
      { id: `${payload.report}-finished` },
    )
  },
})
```

## Run it

You need Node 22.18 or later, a [Trigger.dev](https://cloud.trigger.dev) account and [Claude Code](https://claude.com/claude-code) to test with. Any MCP client works the same way.

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

3. **Trigger.dev.** Create a project in the dashboard. Put its ref (`proj_…`) in `trigger.config.ts`, and the **Development** environment's secret key (`tr_dev_…`, under **API keys**) in `.env` as `TRIGGER_SECRET_KEY`.

4. **Start both**, each in its own terminal:

   ```sh
   npm run dev:trigger   # the Trigger.dev dev worker, which runs the task on your machine
   npm start             # the MCP server, on http://localhost:3000/mcp
   ```

   `trigger dev` reads `.env` too, so the task has `WAKESHIFT_KEY`.

5. **Connect Claude Code.**

   ```sh
   claude mcp add --transport http reports http://localhost:3000/mcp
   ```

6. **Ask for a report.**

   ```text
   Start a report on vector databases.
   ```

## What you'll see

Claude Code calls `start_report`. The first time, it asks whether to install Wakeshift's plugin for Claude Code, showing the exact command. Say yes, type `/reload-plugins` and send any message. If you say no, it starts a background monitor for this session (in manual permission mode, Claude Code asks you to approve it); Claude Code ends a monitor after 30 minutes, so the agent starts it again every 25. Then it ends its turn.

To have a recent Claude Code in the terminal wait on your server instead of a monitor, with no restarts, pass `tools: { wait: { enabled: true } }` to `wake.attach` in `src/server.ts`. Your server then keeps a request open for each waiting conversation; on a serverless host, give the function a timeout of at least 30 seconds. See [the wait tool for Claude Code](https://wakeshift.ai/docs/agents#the-wait-tool-for-claude-code).

About 20 seconds later the task finishes, `onSuccess` emits, and Claude Code wakes in the same conversation with:

```text
Report 0b7c6f3e-… on "vector databases" is ready: 5 sources on vector databases, about 1,200 words. https://example.com/reports/0b7c6f3e-…
```

It goes on from there: it can summarize the report, open it, or start the next step. If the task fails on every attempt, it wakes with `… failed: <the error>` instead. The run shows in the Trigger.dev dashboard as usual.

## Test

```sh
npm test        # the task's run, onSuccess and onFailure, with Trigger.dev and emit mocked
npm run typecheck
```

The test needs no Trigger.dev account or Wakeshift key: `@trigger.dev/sdk` is replaced with a mock (Node's `mock.module`), and `emit` with `mock.method`.

## Going further

- **Who may watch.** This server has no sign-in, so a report's random ID is what lets a conversation subscribe to it. With your own sign-in, pass `identify` to `wake.attach` and check in `watch_report` that the report is the caller's ([your users](https://wakeshift.ai/docs/users)).
- **Where the IDs live.** `runOf` is an in-memory map, so `watch_report` forgets reports when the server restarts. Keep it in your database.
- **Emit from anywhere.** `emit` works from a task's `run` too, or after a `wait.forToken` resumes, say for a person's approval. Give each occurrence its own `id`, so a retry emits once.
- **Deploying.** `npx trigger deploy`, and set `WAKESHIFT_KEY` in the project's environment variables in the Trigger.dev dashboard.

[Wakeshift's docs](https://wakeshift.ai/docs) cover events, sign-in and how each agent is woken.
