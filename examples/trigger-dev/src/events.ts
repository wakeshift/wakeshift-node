import { Wakeshift } from "@wakeshift/sdk"
import { z } from "zod"

// Shared by the MCP server (which subscribes conversations) and the
// Trigger.dev task (which emits when the report is done).
export const wake = new Wakeshift({ key: process.env.WAKESHIFT_KEY! })

export const ReportResult = z.object({
  status: z.enum(["ready", "failed"]),
  topic: z.string(),
  summary: z.string().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
})
export type ReportResult = z.infer<typeof ReportResult>

export const reportFinished = wake.defineEvent("report.finished", {
  description: "A report finished: it's ready, or it failed",
  args: z.object({ report: z.string().describe("The report's ID, as start_report returned it") }),
  payload: ReportResult,
  text: (r, { report }) =>
    r.status === "ready"
      ? `Report ${report} on "${r.topic}" is ready: ${r.summary} ${r.url}`
      : `Report ${report} on "${r.topic}" failed: ${r.error}`,
})
