/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { QUESTIONS } from "./onboardingQuestions";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

async function createUser(
  t: ReturnType<typeof fresh>,
  fields: { isAnonymous?: boolean; email?: string },
) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", fields);
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    });
    return { userId, sessionId };
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

async function createBuilder(t: ReturnType<typeof fresh>, email: string) {
  const member = await createUser(t, { email });
  await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
  return member;
}

const PAGE =
  '<!doctype html><html lang="en"><head><title>Old</title></head><body><h1>Old site</h1></body></html>';

async function seedReadySite(
  t: ReturnType<typeof fresh>,
  userId: Id<"users">,
  options: { dismissed?: boolean; status?: "complete" | "failed" | "questions" } = {},
) {
  return await t.run(async (ctx) => {
    const conversationId = await ctx.db.insert("conversations", {
      userId,
      title: "Harbor Roasters",
      updatedAt: Date.now(),
    });
    const siteId = await ctx.db.insert("sites", {
      userId,
      conversationId,
      name: "Harbor Roasters",
      status: "published",
      slug: "harbor-roasters",
      publishedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const versionId = await ctx.db.insert("siteVersions", {
      userId,
      siteId,
      html: PAGE,
      summary: "Old page",
      requestKind: "generate",
      createdAt: Date.now(),
    });
    await ctx.db.patch(siteId, { currentVersionId: versionId, publishedVersionId: versionId });
    await ctx.db.insert("messages", {
      conversationId,
      role: "assistant",
      body: "Built it.",
      versionId,
    });
    const answers = QUESTIONS.map((_, i) =>
      i === 0 ? "Harbor Roasters" : i === 1 ? "Small-batch coffee" : "",
    );
    const briefId = await ctx.db.insert("siteOnboarding", {
      userId,
      siteId,
      answers,
      step: 9,
      revision: 2,
      assets: [],
      status: options.status ?? "complete",
      attempt: 1,
      dismissed: options.dismissed ?? true,
      events: [{ label: "Website saved and ready", at: Date.now() }],
      strategy: "Keep the brand tight.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { siteId, conversationId, versionId, briefId };
  });
}

describe("onboarding rebuild", () => {
  test("a paid member can scrap the old page and queue a rebuild from saved answers", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const seeded = await seedReadySite(t, member.userId);
    const before = await member.as.query(api.onboarding.state, {});
    expect(before).toMatchObject({ canRebuild: true, hasWebsite: true, draft: null });

    const briefId = await member.as.mutation(api.onboarding.rebuild, {});
    expect(briefId).toBe(seeded.briefId);

    const brief = await t.run((ctx) => ctx.db.get(seeded.briefId));
    expect(brief).toMatchObject({
      status: "queued",
      attempt: 2,
      dismissed: false,
      siteId: seeded.siteId,
      strategy: "Keep the brand tight.",
    });
    expect(brief?.answers[0]).toBe("Harbor Roasters");
    expect(brief?.answers[1]).toBe("Small-batch coffee");
    expect(brief?.events).toEqual([
      expect.objectContaining({ label: "Rebuilding from your answers" }),
    ]);

    const site = await t.run((ctx) => ctx.db.get(seeded.siteId));
    expect(site).toMatchObject({
      slug: "harbor-roasters",
      name: "Harbor Roasters",
      status: "draft",
    });
    expect(site?.currentVersionId).toBeUndefined();
    expect(site?.publishedVersionId).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("conversations").collect())).toHaveLength(1);

    const after = await member.as.query(api.onboarding.state, {});
    expect(after).toMatchObject({
      canRebuild: false,
      hasWebsite: false,
      draft: expect.objectContaining({ id: seeded.briefId, status: "queued" }),
    });
  });

  test("rebuild reuses an existing site when the brief lost its pointer", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const seeded = await seedReadySite(t, member.userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.briefId, { siteId: undefined });
    });
    await member.as.mutation(api.onboarding.rebuild, {});
    const brief = await t.run((ctx) => ctx.db.get(seeded.briefId));
    expect(brief?.siteId).toBe(seeded.siteId);
    const site = await t.run((ctx) => ctx.db.get(seeded.siteId));
    expect(site?.status).toBe("draft");
    expect(await t.run((ctx) => ctx.db.query("sites").collect())).toHaveLength(1);
  });

  test("free members and guests cannot rebuild", async () => {
    const t = fresh();
    const free = await createUser(t, { email: "free@example.com" });
    await seedReadySite(t, free.userId);
    expect(await free.as.query(api.onboarding.state, {})).toMatchObject({ canRebuild: false });
    await expect(free.as.mutation(api.onboarding.rebuild, {})).rejects.toThrow("paid plan");

    const guest = await createUser(t, { isAnonymous: true });
    await expect(guest.as.mutation(api.onboarding.rebuild, {})).rejects.toThrow("Sign in to build");
    await expect(t.mutation(api.onboarding.rebuild, {})).rejects.toThrow("Not signed in");
  });

  test("a build already in flight cannot be rebuilt, and unfinished answers cannot either", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const seeded = await seedReadySite(t, member.userId, { dismissed: false });
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.briefId, { status: "building" });
    });
    expect(await member.as.query(api.onboarding.state, {})).toMatchObject({ canRebuild: false });
    await expect(member.as.mutation(api.onboarding.rebuild, {})).rejects.toThrow("still building");

    const other = await createBuilder(t, "n@example.com");
    await other.as.mutation(api.onboarding.start, {});
    expect(await other.as.query(api.onboarding.state, {})).toMatchObject({ canRebuild: false });
    await expect(other.as.mutation(api.onboarding.rebuild, {})).rejects.toThrow(
      "Finish your website questions first",
    );
  });
});
