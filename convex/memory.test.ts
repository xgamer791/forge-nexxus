/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { insertDesignPackage } from "./designWorkerMock";
import type { Id } from "./_generated/dataModel";
import { DESIGN_GOD } from "./designgod";
import { FED } from "./fed";
import { FORGE_MD } from "./forgeMd";
import { MEMORY_CHARS, MEMORY_LIMIT, formatMemoryNote, parseReflection, reflectionMessages } from "./memory";
import { REQUEST_COSTS, planFor } from "./plans";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);
type T = ReturnType<typeof fresh>;

async function createUser(t: T, fields: { isAnonymous?: boolean; email?: string }) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", fields);
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 });
    return { userId, sessionId };
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

// Building needs credits the free plan does not have, so members start on Starter.
async function createBuilder(t: T, email: string) {
  const member = await createUser(t, { email });
  await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "starter" });
  return member;
}

const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bakery</title><style>body{margin:0}</style></head><body><main><h1>Bakery on Main</h1></main></body></html>';
const KEY = "sk-test-secret-key";
const free = planFor("free");
const starter = planFor("starter");
const OPENING = (free.monthlyCredits ?? 0) + free.signupCredits + starter.monthlyCredits!;

// A site with a first build already on it, so a thread turn is an edit.
async function seedBuiltSite(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const conversationId = await ctx.db.insert("conversations", { userId, title: "Bakery", updatedAt: now });
    const siteId = await ctx.db.insert("sites", { userId, conversationId, name: "Bakery", status: "draft", createdAt: now, updatedAt: now });
    const versionId = await ctx.db.insert("siteVersions", { userId, siteId, html: PAGE, summary: "First", requestKind: "generate", createdAt: now });
    await ctx.db.patch(siteId, { currentVersionId: versionId });
    await insertDesignPackage(ctx, userId, siteId);
    return { siteId, conversationId };
  });
}

// Rows written the way the server writes them, in the order given.
async function remember(t: T, userId: Id<"users">, ...texts: string[]) {
  return await t.run(async (ctx) => {
    const ids: Id<"memories">[] = [];
    for (const text of texts) {
      const at = Date.now() + ids.length;
      ids.push(await ctx.db.insert("memories", { userId, text, createdAt: at, updatedAt: at }));
    }
    return ids;
  });
}
const texts = (rows: { text: string }[]) => rows.map((row) => row.text);
const drain = (t: T) => t.finishAllScheduledFunctions(() => {});

type Call = { url: string; body: any };
function stubProvider(respond: (body: any, call: number) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      return respond(body, calls.length);
    }),
  );
  return calls;
}
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const said = (content: string) => json({ choices: [{ message: { content } }] });
const reflection = (payload: unknown) => said(JSON.stringify(payload));
const systemsOf = (call: Call): string[] => call.body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content as string);
const memoryNoteIn = (call: Call) => systemsOf(call).find((content) => content.startsWith("MEMORY —"));

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = KEY;
  process.env.AI_MODEL = "forge-test";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  delete process.env.AI_REASONING_EFFORT;
});

describe("memory", () => {
  test("empty until Forge has something to keep, and private to the account", async () => {
    const t = fresh();
    expect(await t.query(api.memory.list, {})).toEqual([]);
    const alice = await createUser(t, { email: "a@example.com" });
    const bob = await createUser(t, { email: "b@example.com" });
    expect(await alice.as.query(api.memory.list, {})).toEqual([]);

    const [first, second] = await remember(t, alice.userId, "Runs a bakery in Leeds", "Prefers warm palettes");
    expect(texts(await alice.as.query(api.memory.list, {}))).toEqual(["Prefers warm palettes", "Runs a bakery in Leeds"]);
    expect(await bob.as.query(api.memory.list, {})).toEqual([]);
    await expect(bob.as.mutation(api.memory.forget, { id: first })).rejects.toThrow("Memory not found");

    await alice.as.mutation(api.memory.forget, { id: second });
    expect(texts(await alice.as.query(api.memory.list, {}))).toEqual(["Runs a bakery in Leeds"]);
    await alice.as.mutation(api.memory.forgetAll, {});
    expect(await alice.as.query(api.memory.list, {})).toEqual([]);
    await expect(t.mutation(api.memory.forgetAll, {})).rejects.toThrow("Not signed in");
  });

  test("the note is one system message, and nothing when there is nothing or memory is off", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    expect(formatMemoryNote([])).toBeNull();
    expect(await t.query(internal.memory.note, { userId: member.userId })).toBeNull();
    await remember(t, member.userId, "Runs a bakery in Leeds", "Prefers warm palettes");
    const note = (await t.query(internal.memory.note, { userId: member.userId }))!;
    expect(note.startsWith("MEMORY —")).toBe(true);
    expect(note).toContain("untrusted user content");
    expect(note.endsWith("- Runs a bakery in Leeds\n- Prefers warm palettes")).toBe(true);
    await member.as.mutation(api.settings.update, { memory: false });
    expect(await t.query(internal.memory.note, { userId: member.userId })).toBeNull();
    expect(await t.query(internal.memory.recall, { userId: member.userId })).toBeNull();
    // Off does not forget: the rows are still the member's to see.
    expect(await member.as.query(api.memory.list, {})).toHaveLength(2);
  });

  test("a guest's memories follow them into the account, and go with a deleted account", async () => {
    const t = fresh();
    const guest = await createUser(t, { isAnonymous: true });
    const member = await createUser(t, { email: "m@example.com" });
    await remember(t, guest.userId, "Runs a bakery in Leeds");
    await remember(t, member.userId, "Prefers warm palettes");
    await t.mutation(internal.auth.adoptGuest, { guestId: guest.userId, userId: member.userId });
    expect(texts(await member.as.query(api.memory.list, {})).sort()).toEqual(["Prefers warm palettes", "Runs a bakery in Leeds"]);
    expect(await t.run((ctx) => ctx.db.get(guest.userId))).toBeNull();
    await member.as.mutation(api.users.deleteAccount, {});
    expect(await t.run((ctx) => ctx.db.query("memories").collect())).toEqual([]);
  });
});

describe("reflection", () => {
  test("parseReflection reads the JSON out of whatever surrounds it and drops what it cannot trust", () => {
    expect(parseReflection('Here you go:\n```json\n{"add":["Runs a bakery"],"forget":[2,"3"],"replace":{"1":"Runs Crumb & Co"}}\n```')).toEqual({
      add: ["Runs a bakery"],
      forget: [2, 3],
      replace: [{ index: 1, text: "Runs Crumb & Co" }],
    });
    const none = { add: [], forget: [], replace: [] };
    expect(parseReflection("Nothing worth keeping was said.")).toEqual(none);
    expect(parseReflection('{"add":["broken"')).toEqual(none);
    expect(parseReflection('{"add":"not a list","forget":[0,-1,"a",1.5],"replace":["nope"]}')).toEqual(none);
    expect(parseReflection('{"add":[1,"kept"],"replace":{"x":"no","2":3,"4":"yes"}}')).toEqual({
      add: ["kept"],
      forget: [],
      replace: [{ index: 4, text: "yes" }],
    });
  });

  test("the reflection prompt carries the numbered list and the exchange, cut to size", () => {
    const [rules, exchange] = reflectionMessages(["Runs a bakery"], "Crumb & Co", "x".repeat(7000), "Noted.");
    expect(rules.role).toBe("system");
    expect(rules.content).not.toBe(FORGE_MD);
    expect(rules.content).toContain(`under ${MEMORY_CHARS} characters`);
    expect(exchange.content).toContain("Site being built: Crumb & Co");
    expect(exchange.content).toContain("1. Runs a bakery");
    expect(exchange.content).toContain("Forge replied:\nNoted.");
    expect(exchange.content).toContain("x".repeat(6000) + "…");
    expect(exchange.content).not.toContain("x".repeat(6001));
    expect(reflectionMessages([], undefined, "hi", "hello")[1].content).toContain("Already remembered:\nNothing yet.");
  });

  test("applying a reflection forgets, replaces, adds, dedupes and caps", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const other = await createUser(t, { email: "o@example.com" });
    const [a, b] = await remember(t, member.userId, "Runs a bakery", "Prefers warm palettes");
    const [theirs] = await remember(t, other.userId, "Runs a florist");

    const result = await t.mutation(internal.memory.apply, {
      userId: member.userId,
      forget: [a, theirs],
      replace: [{ id: b, text: "  Prefers warm,   earthy palettes " }, { id: theirs, text: "Runs a bakery" }],
      add: ["Prefers warm, earthy palettes.", "", "  Uses British   spelling  ", "y".repeat(400)],
    });
    expect(result).toEqual({ forgotten: 1, replaced: 1, added: 2 });
    const mine = texts(await member.as.query(api.memory.list, {}));
    expect(mine).toHaveLength(3);
    expect(mine).toContain("Prefers warm, earthy palettes");
    expect(mine).toContain("Uses British spelling");
    expect(mine).toContain("y".repeat(MEMORY_CHARS));
    expect(texts(await other.as.query(api.memory.list, {}))).toEqual(["Runs a florist"]);

    // The cap holds whatever was asked, and off means nothing is written.
    await remember(t, member.userId, ...Array.from({ length: MEMORY_LIMIT }, (_, i) => `Fact ${i}`));
    expect(await t.mutation(internal.memory.apply, { userId: member.userId, forget: [], replace: [], add: ["One more"] })).toEqual({ forgotten: 0, replaced: 0, added: 0 });
    await member.as.mutation(api.settings.update, { memory: false });
    expect(await t.mutation(internal.memory.apply, { userId: member.userId, forget: [b], replace: [], add: [] })).toEqual({ forgotten: 0, replaced: 0, added: 0 });
  });

  test("reflect asks the chat route with the exchange and the list, never a page, and applies the answer", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await remember(t, member.userId, "Runs a bakery in Leeds");
    const calls = stubProvider(() => reflection({ add: ["Prefers warm palettes"], forget: [], replace: { "1": "Runs Crumb & Co, a bakery in Leeds" } }));

    await t.action(internal.memory.reflect, { userId: member.userId, siteName: "Crumb & Co", prompt: "We're Crumb & Co. I like warm palettes.", reply: "Noted — warm it is." });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ai.example/v1/chat/completions");
    // Room for a reasoning model to think and still write the few lines of
    // JSON; what is kept is bounded by the memory limits, not by this.
    expect(calls[0].body).toMatchObject({ model: "forge-test", max_tokens: 24000 });
    expect(calls[0].body.reasoning_effort).toBeUndefined();
    const [rules, exchange] = calls[0].body.messages;
    expect(rules.role).toBe("system");
    expect(rules.content).not.toContain(FORGE_MD);
    expect(exchange.content).toContain("1. Runs a bakery in Leeds");
    expect(exchange.content).toContain("Member said:\nWe're Crumb & Co.");
    expect(exchange.content).toContain("Forge replied:\nNoted");
    expect(JSON.stringify(calls[0].body)).not.toContain("<html");
    expect(texts(await member.as.query(api.memory.list, {}))).toEqual(["Prefers warm palettes", "Runs Crumb & Co, a bakery in Leeds"]);
  });

  test("reflect is quiet when memory is off, the key is unset, or the model does not answer in kind", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    await remember(t, member.userId, "Runs a bakery in Leeds");
    const turn = { userId: member.userId, prompt: "Remember that I love blue.", reply: "Will do." };

    delete process.env.AI_API_KEY;
    let calls = stubProvider(() => reflection({ add: ["Loves blue"] }));
    await t.action(internal.memory.reflect, turn);
    expect(calls).toHaveLength(0);
    process.env.AI_API_KEY = KEY;

    await member.as.mutation(api.settings.update, { memory: false });
    calls = stubProvider(() => reflection({ add: ["Loves blue"] }));
    await t.action(internal.memory.reflect, turn);
    expect(calls).toHaveLength(0);
    await member.as.mutation(api.settings.update, { memory: true });

    calls = stubProvider(() => said("Sure! Nothing to add here."));
    await t.action(internal.memory.reflect, turn);
    expect(calls).toHaveLength(1);

    calls = stubProvider(() => json({ error: { message: "bad request" } }, 400));
    // A refusal is logged and dropped: the action still returns nothing (which is null over the wire).
    await expect(t.action(internal.memory.reflect, turn)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    expect(texts(await member.as.query(api.memory.list, {}))).toEqual(["Runs a bakery in Leeds"]);
  });
});

describe("a turn", () => {
  test("carries what Forge remembers, then reflects on what was said without metering it", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await seedBuiltSite(t, member.userId);
    await remember(t, member.userId, "Runs a bakery in Leeds");
    const calls = stubProvider((_body, call) =>
      call === 1
        ? said("Warm cream and terracotta would suit a bakery. Want me to apply it?")
        : reflection({ add: ["Wants a warm palette"], forget: [], replace: {} }),
    );

    await member.as.action(api.generate.run, { conversationId, prompt: "Remember that I want a warm palette. What colours suit a bakery?" });

    const systems = systemsOf(calls[0]);
    expect(systems[0]).toBe(FORGE_MD);
    expect(systems[1]).toBe(DESIGN_GOD);
    expect(systems[2]).toBe(FED);
    expect(memoryNoteIn(calls[0])).toContain("- Runs a bakery in Leeds");
    await drain(t);
    expect(calls).toHaveLength(2);
    expect(systemsOf(calls[1])).not.toContain(FORGE_MD);
    const exchange = calls[1].body.messages.at(-1).content as string;
    expect(exchange).toContain("Site being built: Bakery");
    expect(exchange).toContain("Member said:\nRemember that I want a warm palette.");
    expect(exchange).toContain("Forge replied:\nWarm cream and terracotta");
    expect(exchange).not.toContain("<html");
    expect(texts(await member.as.query(api.memory.list, {}))).toEqual(["Wants a warm palette", "Runs a bakery in Leeds"]);
    // The reflection rides for free: the turn settled at the chat rate and nothing else moved.
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({ credits: OPENING - REQUEST_COSTS.chat, reserved: 0 });
  });

  test("with memory off, a turn carries nothing and nothing is reflected", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const { conversationId } = await seedBuiltSite(t, member.userId);
    await remember(t, member.userId, "Runs a bakery in Leeds");
    await member.as.mutation(api.settings.update, { memory: false });
    const calls = stubProvider(() => said("Warm cream would suit a bakery."));

    await member.as.action(api.generate.run, { conversationId, prompt: "What colours suit a bakery?" });
    await drain(t);

    expect(calls).toHaveLength(1);
    expect(memoryNoteIn(calls[0])).toBeUndefined();
    expect(texts(await member.as.query(api.memory.list, {}))).toEqual(["Runs a bakery in Leeds"]);
  });

  test("a first onboarding build is told too", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    await remember(t, member.userId, "Runs a bakery in Leeds");
    const { siteId, id } = await t.run(async (ctx) => {
      const now = Date.now();
      const conversationId = await ctx.db.insert("conversations", { userId: member.userId, title: "Bakery", updatedAt: now });
      const siteId = await ctx.db.insert("sites", { userId: member.userId, conversationId, name: "Bakery", status: "draft", createdAt: now, updatedAt: now });
      const id = await ctx.db.insert("siteOnboarding", { userId: member.userId, siteId, answers: [], step: 0, revision: 0, assets: [], status: "building", attempt: 1, dismissed: false, events: [], createdAt: now, updatedAt: now });
      await insertDesignPackage(ctx, member.userId, siteId);
      return { siteId, id };
    });
    const job = await t.mutation(internal.generate.beginOnboarding, { id, attempt: 1 });
    expect(job.result.siteId).toBe(siteId);
    const note = job.messages.find((m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("MEMORY —"));
    expect(note?.content).toContain("- Runs a bakery in Leeds");
    expect(job.messages[0].content).toBe(FORGE_MD);
    expect(job.messages[1].content).toBe(DESIGN_GOD);
    expect(job.messages[2].content).toBe(FED);
  });
});
