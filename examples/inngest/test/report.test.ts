// Runs the function with @inngest/test, without an Inngest server, and with
// emit mocked so nothing reaches Wakeshift.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mock, test } from "node:test"
import { InngestTestEngine } from "@inngest/test"

// A throwaway key in the older format, for the SDK's constructor. Nothing reaches this address.
process.env.WAKESHIFT_KEY = `wst_test_example_${randomBytes(32).toString("base64url")}`
process.env.WAKESHIFT_CORE = "http://127.0.0.1:9"

const { ReportResult, reportFinished } = await import("../src/events.ts")
const { generateReport, reports } = await import("../src/inngest.ts")

const data = { report: "0b7c6f3e-8d2a-4f1e-9c55-2a1d3e4f5a6b", topic: "vector databases" }
const events = [{ name: "app/report.requested", data }] as [{ name: string; data: typeof data }]
// The sleep finishes at once.
const steps = [{ id: "research", handler: () => {} }]

test("the function's last step wakes whoever is subscribed to the report", async (t) => {
  const emit = mock.method(reportFinished, "emit", async () => ({ matched: 1, duplicate: false, unmatched: [], ended: [] }))
  t.after(() => emit.mock.restore())

  const engine = new InngestTestEngine({ function: generateReport })
  const { result } = await engine.execute({ events, steps })

  assert.equal(emit.mock.callCount(), 1)
  const [args, payload, opts] = emit.mock.calls[0].arguments
  assert.deepEqual(args, { report: data.report })
  assert.deepEqual(ReportResult.parse(payload), { status: "ready", topic: "vector databases", ...(result as object) })
  assert.deepEqual(opts, { id: `${data.report}-finished` })
  assert.equal((reports.get(data.report) as { status: string }).status, "ready")
})

test("the event is report.finished", () => {
  assert.equal(reportFinished.name, "report.finished")
})
