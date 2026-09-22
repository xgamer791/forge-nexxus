import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // The suites describe the agent with its full direction; the fed-only
    // default and the sample rebuild are covered at the end of
    // convex/buildFlow.test.ts, which clears these.
    env: { AGENT_DIRECTION: "on", REBUILD_SAMPLE: "off" },
  },
});
