import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // The sample rebuild is covered at the end of convex/buildFlow.test.ts,
    // which clears this.
    env: { REBUILD_SAMPLE: "off" },
  },
});
