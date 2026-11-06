import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { runs, tasks } from "@trigger.dev/sdk"
import { z } from "zod"
import { reportFinished, wake } from "./events.ts"
import type { generateReport } from "./trigger/report.ts"

// Which Trigger.dev run is making each report. Your app would keep this in its database.
const runOf = new Map<string, string>()

function newServer() {
  const server = new McpServer({ name: "reports", version: "1.0.0" })
  const attached = wake.attach(server)

  attached.registerTool(
    "start_report",
    {
      description: "Start a research report on a topic. It runs in the background and takes about a minute.",
      inputSchema: z.object({ topic: z.string().describe("What the report is about") }),
      subscribes: [reportFinished],
    },
    async ({ topic }, ctx, call) => {
      const report = randomUUID()
      // Subscribe first, so the report can't finish before anyone listens.
      await call.subscribe(reportFinished, { report }, { reason: `Report on ${topic}` })
      // If starting the job throws, the call fails and the subscription it made ends.
      const run = await tasks.trigger<typeof generateReport>("generate-report", { report, topic })
      runOf.set(report, run.id)
      return `Started report ${report} on "${topic}". You'll be notified here when it's ready.`
    },
  )

  attached.registerTool(
    "watch_report",
    {
      description: "Watch a report that's already running, from this conversation.",
      inputSchema: z.object({ report: z.string().describe("The report's ID, as start_report returned it") }),
      subscribes: [reportFinished],
    },
    async ({ report }, ctx, call) => {
      const id = runOf.get(report)
      if (!id) return { isError: true, content: [{ type: "text", text: `No report ${report}.` }] }
      // Subscribe, then check: a run that finishes in between still wakes this conversation.
      await call.subscribe(reportFinished, { report }, { reason: `Watching report ${report}` })
      const run = await runs.retrieve<typeof generateReport>(id)
      if (!run.isCompleted) return `Watching report ${report}. You'll be notified here when it's ready.`
      await call.unsubscribe(reportFinished, { report })
      if (run.isSuccess && run.output) return `Report ${report} is already ready: ${run.output.summary} ${run.output.url}`
      return `Report ${report} already finished: it ${run.status.toLowerCase()}.`
    },
  )

  return server
}

const port = Number(process.env.PORT ?? 3000)
createServer(toNodeHandler(createMcpHandler(newServer))).listen(port, () => {
  console.log(`MCP server on http://localhost:${port}/mcp`)
})
