// Runs the task's code without Trigger.dev or Wakeshift: @trigger.dev/sdk is
// mocked so task() hands back its config, and emit is mocked so nothing is sent.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mock, test } from "node:test"

// A throwaway key in the older format, for the SDK's constructor. Nothing reaches this address.
process.env.WAKESHIFT_KEY = `wst_test_example_${randomBytes(32).toString("base64url")}`
process.env.WAKESHIFT_CORE = "http://127.0.0.1:9"

mock.module("@trigger.dev/sdk", {
  namedExports: {
    task: (config: unknown) => config,
    wait: { for: async () => {} },
  },
})

const { ReportResult, reportFinished } = await import("../src/events.ts")
const { generateReport } = await import("../src/trigger/report.ts")

// What task() was given, since the mock returns it.
type Hook = (params: Record<string, unknown>) => Promise<void>
const config = generateReport as unknown as {
  run: (payload: { report: string; topic: string }, params: unknown) => Promise<{ summary: string; url: string }>
  onSuccess: Hook
  onFailure: Hook
}
const payload = { report: "0b7c6f3e-8d2a-4f1e-9c55-2a1d3e4f5a6b", topic: "vector databases" }

function mockEmit() {
  return mock.method(reportFinished, "emit", async () => ({ matched: 1, duplicate: false, unmatched: [], ended: [] }))
}

test("a finished report wakes whoever is subscribed to it", async (t) => {
  const emit = mockEmit()
  t.after(() => emit.mock.restore())

  const output = await config.run(payload, {})
  await config.onSuccess({ payload, output, ctx: {} })

  assert.equal(emit.mock.callCount(), 1)
  const [args, result, opts] = emit.mock.calls[0].arguments
  assert.deepEqual(args, { report: payload.report })
  assert.equal(ReportResult.parse(result).status, "ready")
  assert.deepEqual(result, { status: "ready", topic: "vector databases", summary: output.summary, url: output.url })
  assert.deepEqual(opts, { id: `${payload.report}-finished` })
})

test("a failed report wakes them with the error", async (t) => {
  const emit = mockEmit()
  t.after(() => emit.mock.restore())

  await config.onFailure({ payload, error: new Error("the model timed out"), ctx: {} })

  assert.equal(emit.mock.callCount(), 1)
  const [args, result] = emit.mock.calls[0].arguments
  assert.deepEqual(args, { report: payload.report })
  assert.deepEqual(ReportResult.parse(result), { status: "failed", topic: "vector databases", error: "the model timed out" })
})

test("the event is report.finished", () => {
  assert.equal(reportFinished.name, "report.finished")
})
