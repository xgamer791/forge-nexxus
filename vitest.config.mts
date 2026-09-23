import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    // The sample rebuild is covered at the end of convex/buildFlow.test.ts,
    // which clears this. The design check is covered in
    // convex/designReview.test.ts, which turns it back on; everywhere else a
    // stubbed build is saved the way it was before the check existed.
    // The design worker is mocked in-process. These point at that double, never
    // at the live worker.
    env: {
      REBUILD_SAMPLE: "off",
      DESIGN_REVIEW: "off",
      // The pixel gate is covered in convex/visualGate.test.ts, which turns it
      // back on. A stubbed build must not call the design worker to render.
      BUILDER_VISUAL_GATE: "0",
      DESIGN_WORKER_URL: "https://design-worker.test",
      DESIGN_WORKER_TOKEN: "test-design-worker-token",
    },
  },
});
