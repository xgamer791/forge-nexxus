import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // The sample rebuild is covered at the end of convex/buildFlow.test.ts,
    // which clears this. The design check is covered in
    // convex/designReview.test.ts, which turns it back on; everywhere else a
    // stubbed build is saved the way it was before the check existed.
    env: { REBUILD_SAMPLE: "off", DESIGN_REVIEW: "off" },
  },
});
