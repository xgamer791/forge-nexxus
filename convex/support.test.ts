/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { answerDesignResearch, insertDesignPackage } from "./designWorkerMock";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { SUPPORT_EMAIL, wantsReport } from "./support";

// A build that fails, or one a reply stopped part way through, is emailed to
// support with its whole log the moment it ends. These drive real builds
// through streamed replies and read the email the way Resend would get it.
const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);
type T = ReturnType<typeof fresh>;

const KEY = "sk-test-secret-key";
const RESEND_KEY = "re_test_secret_key";
const PROMPT = "Change the opening hours to eight until four";
const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bakery</title><style>body{margin:0}</style></head><body><main><h1>Bakery on Main</h1></main></body></html>';
const edited = `Changed the hours.\n\n\`\`\`html\n${PAGE}\n\`\`\``;
const encoder = new TextEncoder();

const streamed = (...events: string[]) =>
  new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
const delta = (fields: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: fields, finish_reason: finish }] })}\n\n`;
const dropped = () => streamed(": keep-alive\n\n", delta({ reasoning_content: "Plan the hours." }));
const finished = () => streamed(delta({ reasoning_content: "Plan." }), delta({ content: edited }), delta({ content: "" }, "stop"), "data: [DONE]\n\n");
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

async function createBuilder(t: T) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "baker@example.com" });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 });
    return { userId, sessionId };
  });
  await t.mutation(internal.billing.grantPlan, { userId, plan: "starter" });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

async function seedBuiltSite(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const conversationId = await ctx.db.insert("conversations", { userId, title: "Bakery", updatedAt: Date.now() });
    const siteId = await ctx.db.insert("sites", { userId, conversationId, name: "Bakery on Main", status: "draft", createdAt: Date.now(), updatedAt: Date.now() });
    const versionId = await ctx.db.insert("siteVersions", { userId, siteId, html: PAGE, summary: "First", requestKind: "generate", createdAt: Date.now() });
    await ctx.db.patch(siteId, { currentVersionId: versionId });
    await insertDesignPackage(ctx, userId, siteId);
    return { siteId, conversationId };
  });
}

// Build calls answer through `build`; the memory note gets a plain reply; the
// email provider's requests are kept and answered through `mail`.
function stub(build: (call: number) => Response, mail: () => Response = () => json({ id: "email_1" })) {
  const builds: any[] = [];
  const emails: { url: string; auth: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const layout = await answerDesignResearch(url, init, async () => {
      throw new Error("This test does not research a design reference");
    });
    if (layout) return layout;
    const body = JSON.parse(String(init.body));
    if (url.startsWith("https://api.resend.com")) {
      emails.push({ url, auth: String((init.headers as Record<string, string>).authorization), body });
      return mail();
    }
    if (!body.messages.some((m: any) => /standing rules for the website agent/.test(m.content))) {
      return json({ choices: [{ message: { content: '{"add":[],"forget":[],"replace":[]}' } }] });
    }
    builds.push(body);
    return build(builds.length);
  }));
  return { builds, emails };
}

const drain = (t: T) => t.finishAllScheduledFunctions(() => {});
async function runLog(t: T) {
  return await t.run(async (ctx) => {
    const [run] = await ctx.db.query("buildRuns").collect();
    const events = await ctx.db.query("buildEvents").withIndex("by_run_at", (q) => q.eq("runId", run._id)).collect();
    return { run, events };
  });
}

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = KEY;
  process.env.AI_MODEL = "forge-test";
  process.env.AUTH_RESEND_KEY = RESEND_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AUTH_RESEND_KEY", "SUPPORT_EMAIL", "SUPPORT_EMAIL_FROM", "SUPPORT_REPORTS"]) delete process.env[name];
});

describe("build reports go to support by themselves", () => {
  test("a failed build is emailed to support once, with its whole log and nothing secret", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId } = await seedBuiltSite(t, member.userId);
    const { emails } = stub(() => dropped());

    await expect(member.as.action(api.generate.run, { conversationId, prompt: PROMPT })).rejects.toThrow("dropped");
    await drain(t);

    expect(emails).toHaveLength(1);
    const [email] = emails;
    expect(email.url).toBe("https://api.resend.com/emails");
    expect(email.auth).toBe(`Bearer ${RESEND_KEY}`);
    expect(email.body.to).toEqual([SUPPORT_EMAIL]);
    expect(email.body.from).toBe("Forge Nexxus <onboarding@resend.dev>");
    expect(email.body.subject).toBe("[Forge] Build failed: The connection to the model dropped before it started writing your website.");
    const text: string = email.body.text;
    const { run } = await runLog(t);
    for (const expected of [
      "A build failed.", "The member saw: The connection to the model dropped before it started writing your website. Try again.",
      "Class: stream_dropped", `Run: ${run._id}`, "Kind: Thread build (edit)", "Model: forge-test on ai.example",
      "Email: baker@example.com", "Site: Bakery on Main", "Timeline",
      "provider_stop", "stopped: dropped, phase thinking", "keep-alives 1", "provider_retry",
      "npx convex run diagnostics:inspectStalls",
    ]) expect(text).toContain(expected);
    // What the log never held, the report never carries.
    for (const secret of [KEY, RESEND_KEY, PROMPT, "Plan the hours.", "<!doctype"]) expect(text).not.toContain(secret);

    // The run's own log says support was told.
    const { events } = await runLog(t);
    expect(events.at(-1)).toMatchObject({ phase: "support_report", level: "info", label: `Sent the build report to ${SUPPORT_EMAIL}` });
  });

  test("a build that recovered from a stall is reported as recovered", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId } = await seedBuiltSite(t, member.userId);
    const { emails } = stub((call) => (call === 1 ? dropped() : finished()));

    await member.as.action(api.generate.run, { conversationId, prompt: PROMPT });
    await drain(t);

    expect(emails).toHaveLength(1);
    expect(emails[0].body.subject).toBe("[Forge] Build recovered: Finished after a stop: The connection to the model dropped.");
    expect(emails[0].body.text).toContain("A build finished, but a reply stopped on the way.");
  });

  test("a clean build sends nothing", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId } = await seedBuiltSite(t, member.userId);
    const { emails } = stub(() => finished());

    await member.as.action(api.generate.run, { conversationId, prompt: PROMPT });
    await drain(t);
    expect(emails).toEqual([]);
  });

  test("a refused email is written into the run's log with what the provider said, and never the key", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId } = await seedBuiltSite(t, member.userId);
    const { emails } = stub(() => dropped(), () => json({ statusCode: 403, message: `The domain is not verified for ${RESEND_KEY}` }, 403));

    await expect(member.as.action(api.generate.run, { conversationId, prompt: PROMPT })).rejects.toThrow();
    await drain(t);

    expect(emails).toHaveLength(1);
    const { run, events } = await runLog(t);
    // The build's own ending is untouched by the email's.
    expect(run).toMatchObject({ status: "failed", errorClass: "stream_dropped" });
    const note = events.find((event) => event.phase === "support_report");
    expect(note).toMatchObject({ level: "warn", label: "The build report to support could not be sent" });
    expect(note?.detail).toMatchObject({ httpStatus: 403, errorClass: "support_email", providerError: "The domain is not verified for [key]" });
  });

  test("where reports go, who sends them and whether they go at all are the deployment's to set", async () => {
    const t = fresh();
    const member = await createBuilder(t);
    const { conversationId } = await seedBuiltSite(t, member.userId);
    process.env.SUPPORT_EMAIL = "builds@forgenexxus.com";
    process.env.SUPPORT_EMAIL_FROM = "Forge Nexxus <reports@forgenexxus.com>";
    const { emails } = stub(() => dropped());
    await expect(member.as.action(api.generate.run, { conversationId, prompt: PROMPT })).rejects.toThrow();
    await drain(t);
    expect(emails.map((email) => [email.body.to, email.body.from])).toEqual([[["builds@forgenexxus.com"], "Forge Nexxus <reports@forgenexxus.com>"]]);

    // Off, and with no key at all, nothing is even queued.
    for (const off of [() => { process.env.SUPPORT_REPORTS = "0"; }, () => { delete process.env.SUPPORT_REPORTS; delete process.env.AUTH_RESEND_KEY; }]) {
      off();
      const quiet = stub(() => dropped());
      await expect(member.as.action(api.generate.run, { conversationId, prompt: PROMPT })).rejects.toThrow();
      const queued = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.startsWith("support:") && job.state.kind === "pending"));
      expect(queued).toEqual([]);
      await drain(t);
      expect(quiet.emails).toEqual([]);
    }
  });

  test("an ending the member chose is not a fault, unless a reply stopped on the way", () => {
    const stop = [{ phase: "provider_stop" }];
    expect(wantsReport({ status: "failed", error: "Build cancelled" }, [])).toBe(false);
    expect(wantsReport({ status: "failed", error: "This build is no longer active" }, [])).toBe(false);
    expect(wantsReport({ status: "failed", error: "Build cancelled" }, stop)).toBe(true);
    expect(wantsReport({ status: "failed", error: "The model provider answered 500" }, [])).toBe(true);
    expect(wantsReport({ status: "complete" }, [])).toBe(false);
    expect(wantsReport({ status: "complete" }, [{ phase: "watchdog" }])).toBe(true);
  });
});
