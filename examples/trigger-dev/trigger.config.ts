import { defineConfig } from "@trigger.dev/sdk"

export default defineConfig({
  // Your project's ref, from the Trigger.dev dashboard (Project settings).
  project: "<your-project-ref>",
  dirs: ["./src/trigger"],
  maxDuration: 300,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2, randomize: true },
  },
})
