import { task, wait } from "@trigger.dev/sdk"
import { reportFinished } from "../events.ts"

export interface ReportPayload {
  report: string
  topic: string
}

export const generateReport = task({
  id: "generate-report",
  run: async ({ report, topic }: ReportPayload) => {
    // Stands in for the real work: research, model calls, rendering a PDF.
    await wait.for({ seconds: 20 })
    return { summary: `5 sources on ${topic}, about 1,200 words.`, url: `https://example.com/reports/${report}` }
  },

  // The run succeeded: wake the conversation that started it.
  onSuccess: async ({ payload, output }) => {
    await reportFinished.emit(
      { report: payload.report },
      { status: "ready", topic: payload.topic, summary: output.summary, url: output.url },
      { id: `${payload.report}-finished` }, // a retried hook emits once
    )
  },

  // Every attempt failed: wake it with the error instead.
  onFailure: async ({ payload, error }) => {
    const message = error instanceof Error ? error.message : String(error)
    await reportFinished.emit(
      { report: payload.report },
      { status: "failed", topic: payload.topic, error: message.slice(0, 300) },
      { id: `${payload.report}-finished` },
    )
  },
})
