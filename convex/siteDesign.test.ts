/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { FEATURE_PAGES, FINAL_STEP, pagePurpose, QUESTION_SET, QUESTIONS } from "./onboardingQuestions";
import { MAX_PAGES, sitePages } from "./pages";
import { assertDesignRules } from "./siteDesign";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const FEATURES = (QUESTIONS.find((question) => question.id === "features") as { options: readonly string[] }).options;
const answers = (name: string, offer: string) => QUESTIONS.map((_, index) => [name, offer][index] ?? "");

describe("the design rules every build is held to", () => {
  test("fonts come from Fontshare, and nothing else about a page's links is refused", () => {
    assertDesignRules({ html: '<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@400"><a href="/about">About</a><img src="forge-image:1">' });
    assertDesignRules({ html: '<img src="https://images.example.com/counter.jpg"><a href="https://example.com/">Elsewhere</a>' });
    expect(() => assertDesignRules({ html: '<link href="https://fonts.googleapis.com/css2?family=Inter">' })).toThrow(/Fontshare/);
    expect(() => assertDesignRules({
      shell: "<style>@font-face{src:url(https://fonts.gstatic.com/s/inter.woff2)}</style><!--forge-page-->",
      pages: [{ path: "/", title: "Home", body: "<main></main>" }],
    })).toThrow(/Fontshare/);
  });
});

describe("the pages a build plans", () => {
  test("the home page alone, until the member says what people should be able to do", () => {
    expect(sitePages("")).toEqual(["/"]);
    expect(sitePages("Something of my own\n\n")).toEqual(["/"]);
  });

  test("each choice that needs a page names one, home first, in the plan's order", () => {
    expect(sitePages("See a menu or price list")).toEqual(["/", "/menu"]);
    expect(sitePages("Send you a message\nBuy products")).toEqual(["/", "/shop", "/contact"]);
    // Two choices that belong on one page make one.
    expect(sitePages("Find you on a map\nSend you a message")).toEqual(["/", "/contact"]);
    // The member's own words beside the choices name no page.
    expect(sitePages(" Read reviews \nWatch our videos")).toEqual(["/", "/reviews"]);
  });

  test("five pages at most, whatever is chosen", () => {
    expect(sitePages(FEATURES.join("\n"))).toEqual(["/", "/shop", "/book", "/order", "/menu"]);
    expect(sitePages(FEATURES.join("\n"))).toHaveLength(MAX_PAGES);
  });

  test("every choice the question offers names a page, and every page says what it is for", () => {
    expect(FEATURE_PAGES.flatMap((page) => page.choices).sort()).toEqual([...FEATURES].sort());
    for (const page of FEATURE_PAGES) expect(pagePurpose(page.path)).toBe(page.purpose);
    expect(pagePurpose("/")).toMatch(/^The home page/);
    expect(pagePurpose("/food-menu")).toBeUndefined();
  });
});

describe("a build needs no design worker", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("the step before the build calls nothing and hands straight on to the build", async () => {
    // Scheduled functions sit on setTimeout: faked, the build stays queued.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = convexTest(schema, modules);
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const id = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "plan@example.com" });
      const conversationId = await ctx.db.insert("conversations", { userId, title: "Harbor", updatedAt: Date.now() });
      const siteId = await ctx.db.insert("sites", { userId, conversationId, name: "Harbor", status: "draft", createdAt: Date.now(), updatedAt: Date.now() });
      return await ctx.db.insert("siteOnboarding", {
        userId, siteId, answers: answers("Harbor", "Coffee roasted on the pier"), questionSet: QUESTION_SET, step: FINAL_STEP,
        revision: 1, assets: [], status: "queued", attempt: 1, dismissed: false, events: [], createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    await t.action(internal.onboarding.research, { id, attempt: 1 });
    expect(fetched).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      status: "queued", queueStep: expect.objectContaining({ attempt: 1, step: "build" }),
    });
    const jobs = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job.name));
    expect(jobs).toEqual(["onboarding:build"]);
  });

  test("a rebuild lets go of the design package a site kept from the design worker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = convexTest(schema, modules);
    const { userId, sessionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "retired@example.com" });
      const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 });
      return { userId, sessionId };
    });
    await t.mutation(internal.billing.grantPlan, { userId, plan: "starter" });
    const member = t.withIdentity({ subject: `${userId}|${sessionId}` });
    const { siteId, storageId } = await t.run(async (ctx) => {
      const conversationId = await ctx.db.insert("conversations", { userId, title: "Harbor", updatedAt: Date.now() });
      const siteId = await ctx.db.insert("sites", { userId, conversationId, name: "Harbor", status: "draft", createdAt: Date.now(), updatedAt: Date.now() });
      const versionId = await ctx.db.insert("siteVersions", {
        userId, siteId, html: "<!doctype html><html><body><h1>Harbor</h1></body></html>", summary: "Built it.", requestKind: "generate", createdAt: Date.now(),
      });
      await ctx.db.patch(siteId, { currentVersionId: versionId });
      await ctx.db.insert("siteOnboarding", {
        userId, siteId, answers: answers("Harbor", "Coffee roasted on the pier"), questionSet: QUESTION_SET, step: FINAL_STEP,
        revision: 1, assets: [], status: "complete", attempt: 1, dismissed: true, events: [], createdAt: Date.now(), updatedAt: Date.now(),
      });
      const storageId = await ctx.storage.store(new Blob(["PK skillui-ultra"], { type: "application/zip" }));
      await ctx.db.insert("siteDesignPackages", {
        userId, siteId, storageId, referenceUrl: "https://harbor-reference.example/", prompt: "Extract", inspectedPages: 1,
        buildEpoch: 0, createdAt: Date.now(), format: "skillui-ultra-v1", routes: ["/"],
      });
      return { siteId, storageId };
    });
    await member.mutation(api.onboarding.rebuild, { siteId });
    expect(await t.run((ctx) => ctx.db.query("siteDesignPackages").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  });
});
