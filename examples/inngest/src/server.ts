import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { serve } from "inngest/node"
import { z } from "zod"
import { reportFinished, wake } from "./events.ts"
import { generateReport, inngest, reportRequested, reports } from "./inngest.ts"

function newServer() {
  const server = new McpServer({ name: "reports", version: "1.0.0" })
  const attached = wake.attach(server)

  server.registerTool(
    "start_report",
    {
      description: "Start a research report on a topic. It runs in the background and takes about a minute.",
      inputSchema: attached.inputs(z.object({ topic: z.string().describe("What the report is about") })),
    },
    attached.events("start_report", { subscribes: [reportFinished] }, async ({ topic }, call) => {
      const report = randomUUID()
      // Subscribe first, so the report can't finish before anyone listens.
      await call.subscribe(reportFinished, { report }, { reason: `Report on ${topic}` })
      // If starting the job throws, the call fails and the subscription it made ends.
      reports.set(report, "running")
      try {
        await inngest.send(reportRequested.create({ report, topic }, { id: report }))
      } catch (err) {
        reports.delete(report)
        throw err
      }
      return `Started report ${report} on "${topic}". You'll be notified here when it's ready.`
    }),
  )

  server.registerTool(
    "watch_report",
    {
      description: "Watch a report that's already running, from this conversation.",
      inputSchema: attached.inputs(z.object({ report: z.string().describe("The report's ID, as start_report returned it") })),
    },
    attached.events("watch_report", { subscribes: [reportFinished] }, async ({ report }, call) => {
      if (!reports.has(report)) return { isError: true, content: [{ type: "text", text: `No report ${report}.` }] }
      // Subscribe, then check: a report that finishes in between still wakes this conversation.
      await call.subscribe(reportFinished, { report }, { reason: `Watching report ${report}` })
      const state = reports.get(report)
      if (!state || state === "running") return `Watching report ${report}. You'll be notified here when it's ready.`
      await call.unsubscribe(reportFinished, { report })
      return `Report ${report} already finished: ${state.status === "ready" ? `${state.summary} ${state.url}` : state.error}`
    }),
  )

  return server
}

const inngestHandler = serve({ client: inngest, functions: [generateReport] })
const mcpHandler = toNodeHandler(createMcpHandler(newServer))

const port = Number(process.env.PORT ?? 3000)
createServer((req, res) => {
  if (req.url?.startsWith("/api/inngest")) return inngestHandler(req, res)
  return mcpHandler(req, res)
}).listen(port, () => {
  console.log(`MCP server on http://localhost:${port}/mcp, Inngest functions on /api/inngest`)
})
