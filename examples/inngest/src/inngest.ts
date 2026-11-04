import { eventType, Inngest } from "inngest"
import { z } from "zod"
import { reportFinished, type ReportResult } from "./events.ts"

export const inngest = new Inngest({ id: "reports" })

const ReportRequest = z.object({ report: z.string(), topic: z.string() })
export const reportRequested = eventType("app/report.requested", { schema: ReportRequest })

// Each report: running, or how it finished. Your app would keep this in its database.
export const reports = new Map<string, "running" | ReportResult>()

export const generateReport = inngest.createFunction(
  {
    id: "generate-report",
    triggers: [reportRequested],
    retries: 3,
    // Every attempt failed: wake the conversation with the error instead.
    onFailure: async ({ event, error, step }) => {
      const { report, topic } = ReportRequest.parse(event.data.event.data)
      await step.run("wake-the-agent", () => {
        const failed: ReportResult = { status: "failed", topic, error: error.message.slice(0, 300) }
        reports.set(report, failed)
        return reportFinished.emit({ report }, failed, { id: `${report}-finished` })
      })
    },
  },
  async ({ event, step }) => {
    const { report, topic } = event.data

    // Stands in for the real work: research, model calls, rendering a PDF.
    await step.sleep("research", "20s")
    const result = await step.run("write-report", () => ({
      summary: `5 sources on ${topic}, about 1,200 words.`,
      url: `https://example.com/reports/${report}`,
    }))

    // The last step: wake the conversation that started it. If this step is
    // retried, the id makes it emit once.
    await step.run("wake-the-agent", () => {
      const ready: ReportResult = { status: "ready", topic, ...result }
      reports.set(report, ready)
      return reportFinished.emit({ report }, ready, { id: `${report}-finished` })
    })
    return result
  },
)
