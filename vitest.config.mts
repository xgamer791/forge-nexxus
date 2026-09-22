import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // The suites describe the agent with its full direction; the fed-only
    // default is covered in convex/fedOnly.test.ts, which clears this.
    env: { AGENT_DIRECTION: "on" },
  },
});
