/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import { assertDesignRules } from "./siteDesign";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("saved design reference", () => {
  test("accepts only a package for the active site and build epoch", async () => {
    const t = convexTest(schema, modules);
    const { siteId, onboardingId, storageId } = await t.run(async ctx => {
      const userId = await ctx.db.insert("users", { email: "design@example.com" });
      const conversationId = await ctx.db.insert("conversations", { userId, title: "Test", updatedAt: Date.now() });
      const siteId = await ctx.db.insert("sites", {
        userId, conversationId, name: "Test", status: "draft", buildEpoch: 2,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      const onboardingId = await ctx.db.insert("siteOnboarding", {
        userId, siteId, answers: ["Test", "Bakery"], step: 10, revision: 1,
        assets: [], status: "queued", attempt: 1, dismissed: false, events: [],
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      const storageId = await ctx.storage.store(new Blob(["reference package"]));
      return { siteId, onboardingId, storageId };
    });
    const args = {
      siteId, onboardingId, attempt: 1, epoch: 2, storageId,
      referenceUrl: "https://example.com/", prompt: "Original design structure", inspectedPages: 6,
    };
    expect(await t.mutation(internal.siteDesign.save, { ...args, epoch: 1 })).toBe(false);
    expect(await t.mutation(internal.siteDesign.save, args)).toBe(true);
    expect(await t.query(internal.siteDesign.forSite, { siteId })).toMatchObject({
      storageId, prompt: "Original design structure", inspectedPages: 6, buildEpoch: 2,
    });
    await t.run(async ctx => { await ctx.db.patch(siteId, { buildEpoch: 3 }); });
    expect(await t.mutation(internal.siteDesign.save, args)).toBe(false);
  });

  test("rejects reference assets and non-Fontshare font URLs in built pages", () => {
    assertDesignRules({ html: '<a href="/about">About</a><img src="forge-image:1">' }, "https://reference.example.com");
    expect(() => assertDesignRules({ html: '<img src="https://reference.example.com/a.jpg">' },
      "https://reference.example.com")).toThrow(/reference/);
    expect(() => assertDesignRules({ html: '<link href="https://fonts.googleapis.com/css2">' },
      "https://reference.example.com")).toThrow(/Fontshare/);
  });
});
