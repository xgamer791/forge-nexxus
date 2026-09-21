/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("fedReads", () => {
  test("a miss does not bump the counter, a hit records when it triggered", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(internal.fedReads.stats, {})).toMatchObject({
      count: 0,
      lastTriggeredAt: null,
      lastTriggered: null,
      lastSource: null,
      opened: false,
    });

    await t.mutation(internal.fedReads.record, { source: "build", opened: false });
    expect(await t.query(internal.fedReads.stats, {})).toMatchObject({ count: 0, opened: false });

    const started = Date.now();
    await t.mutation(internal.fedReads.record, { source: "rebuild", opened: true });
    const stats = await t.query(internal.fedReads.stats, {});
    expect(stats).toMatchObject({ count: 1, lastSource: "rebuild", opened: true });
    expect(stats.lastTriggeredAt).toBeGreaterThanOrEqual(started);
    expect(stats.lastTriggered).toBe(new Date(stats.lastTriggeredAt!).toISOString());
  });
});
