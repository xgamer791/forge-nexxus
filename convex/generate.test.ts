/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { parseReply } from "./generate";
import { REQUEST_COSTS, planFor } from "./plans";
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

const free = planFor("free");
const KEY = "sk-test-secret-key";
const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bakery</title><style>body{margin:0}</style></head><body><main><h1>Bakery on Main</h1></main></body></html>';
const PAGE_TWO = PAGE.replace("Bakery on Main", "Bakery on Main — now with hours");

type Call = { url: string; headers: Record<string, string>; body: any };

function stubProvider(respond: (body: any, call: number) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, headers: init.headers as Record<string, string>, body });
      return respond(body, calls.length);
    }),
  );
  return calls;
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const reply = (summary: string, html = PAGE) =>
  json({ choices: [{ message: { content: `${summary}\n\n\`\`\`html\n${html}\n\`\`\`` } }] });

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
});

describe("parseReply", () => {
  test("takes the fenced page and the sentence before it", () => {
    const parsed = parseReply(`1. Built a warm bakery landing page.\n\n\`\`\`html\n${PAGE}\n\`\`\`\nAnything after is ignored.`);
    expect(parsed.html).toBe(PAGE);
    expect(parsed.summary).toBe("Built a warm bakery landing page.");
  });

  test("accepts a bare document and an unlabelled fence", () => {
    expect(parseReply(`  ${PAGE}  `)).toEqual({ html: PAGE, summary: "" });
    expect(parseReply(`\`\`\`\n${PAGE}\n\`\`\``).html).toBe(PAGE);
  });

  test("refuses anything that is not a whole page", () => {
    expect(() => parseReply("Sure! Here is some CSS: body{margin:0}")).toThrow("complete page");
    expect(() => parseReply("```html\n<div>half</div>\n```")).toThrow("complete page");
  });
});

describe("generate.run", () => {
  test("a first prompt builds the site, charges the generate cost, and keeps the version", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { siteId, conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery on Main" });
    const calls = stubProvider(() => reply("Built a warm landing page with a menu."));

    const { messageId } = await member.as.action(api.generate.run, {
      conversationId,
      prompt: "A warm site for a neighbourhood bakery",
    });

    const messages = await member.as.query(api.messages.list, { conversationId });
    expect(messages.map((m) => [m.role, m.body, m.status ?? null])).toEqual([
      ["user", "A warm site for a neighbourhood bakery", null],
      ["assistant", "Built a warm landing page with a menu.", null],
    ]);
    expect(messages[1]._id).toBe(messageId);
    const [site] = await member.as.query(api.sites.list, {});
    expect(site.currentVersionId).toBe(messages[1].versionId);
    const current = await member.as.query(api.sites.currentHtml, { siteId });
    expect(current).toMatchObject({ html: PAGE, summary: "Built a warm landing page with a menu.", published: false });

    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: free.monthlyCredits - REQUEST_COSTS.generate,
      reserved: 0,
    });
    const history = await member.as.query(api.billing.history, {});
    expect(history[0]).toMatchObject({ kind: "spend", amount: -REQUEST_COSTS.generate, note: "Site generation" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ai.example/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body.model).toBe("forge-test");
    const roles = calls[0].body.messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user"]);
    expect(calls[0].body.messages[0].content).toContain("self-contained HTML file");
    expect(calls[0].body.messages[1].content).toBe("A warm site for a neighbourhood bakery");
  });

  test("a second prompt is an edit: the current page goes along and the edit cost is charged", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { conversationId, siteId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    const calls = stubProvider((_body, call) =>
      call === 1 ? reply("Built the first version.") : reply("Added opening hours.", PAGE_TWO),
    );
    await member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" });
    await member.as.action(api.generate.run, { conversationId, prompt: "Add opening hours" });

    const second = calls[1].body.messages;
    expect(second.map((m: any) => m.role)).toEqual(["system", "system", "user", "assistant", "user"]);
    expect(second[1].content).toContain(PAGE);
    expect(second[2].content).toBe("A bakery site");
    expect(second[3].content).toBe("Built the first version.");
    expect(second[4].content).toBe("Add opening hours");

    expect((await member.as.query(api.sites.currentHtml, { siteId }))?.html).toBe(PAGE_TWO);
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toHaveLength(2);
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(
      free.monthlyCredits - REQUEST_COSTS.generate - REQUEST_COSTS.edit,
    );
  });

  test("a provider failure marks the reply failed, gives the hold back, and never leaks the key", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider(() => new Response(`upstream said no to ${KEY}`, { status: 502 }));

    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow("answered 502");
    const messages = await member.as.query(api.messages.list, { conversationId });
    expect(messages.map((m) => [m.role, m.status ?? null])).toEqual([["user", null], ["assistant", "failed"]]);
    expect(messages[1].body).toContain("answered 502");
    expect(messages[1].body).toContain("[key]");
    expect(messages[1].body).not.toContain(KEY);
    expect(await member.as.query(api.billing.summary, {})).toMatchObject({
      credits: free.monthlyCredits,
      reserved: 0,
      available: free.monthlyCredits,
    });
    const holds = await t.run((ctx) => ctx.db.query("creditHolds").collect());
    expect(holds.map((hold) => hold.status)).toEqual(["released"]);
    expect(await t.run((ctx) => ctx.db.query("siteVersions").collect())).toEqual([]);
  });

  test("a reply without a page is refused and costs nothing", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider(() => json({ choices: [{ message: { content: "Sure, what colours do you like?" } }] }));
    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow("complete page");
    expect((await member.as.query(api.billing.summary, {}))!.credits).toBe(free.monthlyCredits);
  });

  test("without provider settings the build is refused and nothing is charged", async () => {
    delete process.env.AI_API_KEY;
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    const calls = stubProvider(() => reply("never"));
    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow("isn't set up");
    expect(calls).toHaveLength(0);
    const messages = await member.as.query(api.messages.list, { conversationId });
    expect(messages[1]).toMatchObject({ role: "assistant", status: "failed" });
    expect((await member.as.query(api.billing.summary, {}))!.available).toBe(free.monthlyCredits);
  });

  test("guests, strangers, and empty prompts are refused before anything is written", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const stranger = await createUser(t, { email: "s@example.com" });
    const guest = await createUser(t, { isAnonymous: true });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    stubProvider(() => reply("never"));
    await expect(member.as.action(api.generate.run, { conversationId, prompt: "   " })).rejects.toThrow(
      "Describe what you want",
    );
    await expect(
      stranger.as.action(api.generate.run, { conversationId, prompt: "Mine now" }),
    ).rejects.toThrow("Conversation not found");
    const guestThread = await t.run((ctx) =>
      ctx.db.insert("conversations", { userId: guest.userId, title: "Guest", updatedAt: 1 }),
    );
    await expect(
      guest.as.action(api.generate.run, { conversationId: guestThread, prompt: "Build" }),
    ).rejects.toThrow("This thread has no site");
    expect(await member.as.query(api.messages.list, { conversationId })).toEqual([]);
  });

  test("running out of credits refuses before the prompt is recorded", async () => {
    const t = fresh();
    const member = await createUser(t, { email: "m@example.com" });
    const { conversationId } = await member.as.mutation(api.sites.create, { name: "Bakery" });
    for (;;) {
      try {
        await t.mutation(internal.billing.reserve, { userId: member.userId, requestKind: "generate" });
      } catch {
        break;
      }
    }
    stubProvider(() => reply("never"));
    await expect(
      member.as.action(api.generate.run, { conversationId, prompt: "A bakery site" }),
    ).rejects.toThrow("Out of credits");
    expect(await member.as.query(api.messages.list, { conversationId })).toEqual([]);
  });
});
