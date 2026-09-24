/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { crewCall, partReply } from "./crewMock";
import {
  chromeHash,
  designReviewOn,
  elided,
  lostPageStyles,
  needsReview,
  readVerdict,
  unnamedParts,
} from "./designCheck";
import { parseReply, parseShellReply } from "./generate";
import { QUESTION_SET, QUESTIONS } from "./onboardingQuestions";
import schema from "./schema";

// The second agent. A build's header, dropdown menu and footer go to a
// separate design reviewer before the build is saved, and come back to the
// design agent until the reviewer agrees. The scheduler runs for real, so a
// check and its reworks run the way they would on Convex.
const modules = import.meta.glob("./**/*.*s");
function makeTest() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof makeTest>;
const fresh = () => makeTest();

async function createBuilder(t: T, email: string) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 });
    return { userId, sessionId };
  });
  await t.mutation(internal.billing.grantPlan, { userId, plan: "starter" });
  return { userId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}
type Member = Awaited<ReturnType<typeof createBuilder>>;

// No choice of what visitors can do, so the site is the home page alone.
const ANSWERS = [
  "Harbor Roasters",
  "Small-batch coffee roasted on the pier, for neighbours and visitors in Port Ellen",
  "",
  "Pier Roast 250g — £11",
  "",
  "",
  "",
  "Warm and welcoming",
  "",
  "",
];

async function answerEverything(member: Member) {
  const id = await member.as.mutation(api.onboarding.start, {});
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    await member.as.mutation(api.onboarding.save, { id, index, answer: ANSWERS[index], advance: true, questionSet: QUESTION_SET });
  }
  return id;
}

const CLONES = [
  "Header: Locomotive, https://locomotive.ca",
  "A 96px bar: wordmark left, four links right at 15px, 40px side padding.",
  "Dropdown menu: Locomotive, https://locomotive.ca",
  "A full-width panel that drops from the bar, links at 48px, 40px padding.",
  "Footer: Locomotive, https://locomotive.ca",
  "A four-column grid over a 12vw wordmark, 80px top padding.",
].join("\n");

const PAGE_STYLES = ".menu-card{padding:24px}.hours{display:grid}";
const shell = (css = "", pageStyles = PAGE_STYLES) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbor Roasters</title>` +
  `<style>body{margin:0}${pageStyles}${css}</style></head><body><header class="bar"><a href="/">Harbor Roasters</a>` +
  `<button class="menu-button" aria-expanded="false">Beans and hours</button><nav class="drop"><a href="/">Home</a></nav></header>` +
  `<!--forge-page--><footer class="foot">Pier 4, Port Ellen</footer></body></html>`;
const HOME =
  `<main><h1>Harbor Roasters</h1><div class="menu-card">Pier Roast</div><ul class="hours"><li>7am</li></ul>` +
  `<img src="forge-image:1" data-forge-image="Morning light on the roastery counter" data-forge-aspect="16:9" alt="The roastery counter" width="1600" height="900"></main>`;

const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``;
function siteReply(options: { clones?: string | null; shell?: string; home?: string; summary?: string } = {}) {
  return [
    options.summary ?? "Built a harbour-side site for Harbor Roasters.",
    ...(options.clones === null ? [] : [fence("clones", options.clones ?? CLONES)]),
    fence("html shell", options.shell ?? shell()),
    fence('html path="/" title="Home"', options.home ?? HOME),
  ].join("\n\n");
}
const reworkReply = (reworked: string, clones = CLONES) =>
  ["Made the header 96px tall.", fence("clones", clones), fence("html shell", reworked)].join("\n\n");

const part = (equal: boolean, difference?: string) => ({
  original: "Locomotive, https://locomotive.ca",
  equal,
  differences: difference ? [difference] : [],
});
const AGREE = JSON.stringify({ equal: true, header: part(true), menu: part(true), footer: part(true), fixes: [] });
const PNG = btoa("not really a png, but bytes are bytes");
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const answer = (content: string) => json({ choices: [{ message: { content } }] });

type Call = { url: string; body: any };
const systemOf = (call: Call) =>
  call.body.messages.filter((message: any) => message.role === "system").map((message: any) => message.content).join("\n");
const lastUser = (call: Call) => call.body.messages.filter((message: any) => message.role === "user").at(-1)?.content ?? "";

// The design agent and the design reviewer, told apart by their instructions.
// The strategist and the memory note are answered so they stay out of the way,
// and a first build's crew builders get their parts. Any other call counts as
// the design agent's, so a turn nobody asked for shows up in `builds`.
function stubAgents(agents: { build: (call: number) => string; review: (call: number) => string | Promise<string> }) {
  const calls: Call[] = [];
  let builds = 0;
  let reviews = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const call = { url, body };
      calls.push(call);
      if (/generateContent/.test(url)) {
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] });
      }
      const system = systemOf(call);
      if (/private website strategist/.test(system)) return answer("Lead with the roastery.");
      if (/You maintain Forge's memory/.test(system)) return answer('{"add":[],"forget":[],"replace":{}}');
      if (/You are Forge's design reviewer/.test(system)) return answer(await agents.review(++reviews));
      const crew = crewCall(body);
      if (crew) return answer(partReply(crew));
      return answer(agents.build(++builds));
    }),
  );
  const chat = () => calls.filter((call) => /chat\/completions/.test(call.url));
  return {
    all: () => calls,
    builds: () => chat().filter((call) => !crewCall(call.body) && !/You are Forge's design reviewer|private website strategist|You maintain Forge's memory/.test(systemOf(call))),
    crew: () => chat().filter((call) => crewCall(call.body)),
    reviews: () => chat().filter((call) => /You are Forge's design reviewer/.test(systemOf(call))),
  };
}

const drain = (t: T) => t.finishAllScheduledFunctions(() => {});
const holds = (t: T) => t.run(async (ctx) => (await ctx.db.query("creditHolds").collect()).map((hold) => [hold.requestKind, hold.status]));
const versions = (t: T) => t.run((ctx) => ctx.db.query("siteVersions").collect());
const reviews = (t: T) => t.run((ctx) => ctx.db.query("designReviews").collect());

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = "sk-test-secret-key";
  process.env.AI_MODEL = "forge-test";
  process.env.AI_IMAGE_API_KEY = "img-test-secret-key";
  process.env.CONVEX_SITE_URL = "https://forge-test.convex.site";
  process.env.DESIGN_REVIEW = "on";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AI_BUILD_MODEL", "AI_IMAGE_API_KEY", "CONVEX_SITE_URL", "DESIGN_REVIEW_ROUNDS"]) {
    delete process.env[name];
  }
  process.env.DESIGN_REVIEW = "off";
});

// A member's first site, built and saved. The Awwwards reviewer is retired.
async function firstSite(t: T, member: Member) {
  const id = await answerEverything(member);
  await member.as.mutation(api.onboarding.submit, { id });
  await drain(t);
  const row = (await t.run((ctx) => ctx.db.get(id)))!;
  const site = (await t.run((ctx) => ctx.db.get(row.siteId!)))!;
  return { id, site };
}

describe("a first build is written from the brief and saved", () => {
  test("the crew builds it, nothing but the model and the pictures is called, and the retired reviewer is not asked", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({ build: () => siteReply(), review: () => AGREE });

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    expect(agents.builds()).toHaveLength(0);
    expect(agents.crew()).toHaveLength(4);
    expect(agents.reviews()).toHaveLength(0);
    expect(await reviews(t)).toEqual([]);
    // No design worker, and no reference saved for the site.
    for (const call of agents.all()) expect(call.url).toMatch(/\/chat\/completions$|:generateContent$/);
    expect(await t.run((ctx) => ctx.db.query("siteDesignPackages").collect())).toEqual([]);
    const brief = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(brief).toMatchObject({ status: "complete" });
    expect(brief.error).toBeUndefined();
    const events = await t.run((ctx) => ctx.db.query("buildEvents").collect());
    expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining([
      "draft_start", "crew_page", "crew_built", "crew_page_done", "draft_done", "complete",
    ]));
    for (const retired of [
      "research", "research_searching", "research_candidate", "research_discovering", "research_skillui", "research_uploading", "research_done",
      "design_loaded", "layout_check", "crew_audit", "crew_agreed", "crew_sent_back", "crew_exhausted", "design_audit", "design_verdict",
    ]) {
      expect(events.map((event) => event.phase)).not.toContain(retired);
    }
    expect(await versions(t)).toHaveLength(1);
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "settled"]]);
    for (const call of agents.crew()) {
      expect(systemOf(call)).not.toMatch(/SkillUI|design reference/);
      expect(systemOf(call)).not.toContain("```clones");
    }
    expect(brief.events.map((event) => event.label)).not.toContain("Header, menu and footer sent back for changes");
  });
});

describe("an edit is made to the site as it stands", () => {
  test("an edit is handed the saved site, never a design package from the retired worker, and saved as it was written", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({
      build: () => siteReply({ summary: "Added this week's roast.", home: HOME.replace("Pier Roast", "Pier Roast, and this week's Kenya") }),
      review: () => AGREE,
    });
    const { site } = await firstSite(t, member);
    expect(agents.reviews()).toHaveLength(0);
    // A package the design worker saved for this site before it was retired.
    const RETIRED = "SkillUI Ultra design reference for this site. Build every page to its layout.";
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["PK skillui-ultra"], { type: "application/zip" }));
      await ctx.db.insert("siteDesignPackages", {
        userId: member.userId, siteId: site._id, storageId, referenceUrl: "https://harbor-reference.example/", prompt: RETIRED,
        inspectedPages: 1, buildEpoch: site.buildEpoch ?? 0, createdAt: Date.now(), format: "skillui-ultra-v1", routes: ["/"],
      });
    });

    await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "Add this week's roast" });
    await drain(t);

    expect(agents.reviews()).toHaveLength(0);
    expect(await reviews(t)).toEqual([]);
    expect(await versions(t)).toHaveLength(2);
    expect(agents.builds()).toHaveLength(1);
    expect(systemOf(agents.builds()[0])).toContain(`The site "${site.name}" currently looks like this.`);
    expect(systemOf(agents.builds()[0])).not.toContain(RETIRED);
    expect(systemOf(agents.builds()[0])).not.toMatch(/SkillUI|design reference/);
    // One call for the edit and nothing after it: no second agent is asked
    // whether the change matches before it is saved.
    expect(agents.crew()).toHaveLength(4);
    expect((await holds(t)).filter(([kind]) => kind === "edit")).toEqual([["edit", "settled"]]);
  });
});

describe("the check's own reading", () => {
  test("a clones block names an original, with its address, for each part", () => {
    expect(unnamedParts(CLONES)).toEqual([]);
    expect(unnamedParts(undefined)).toEqual(["header", "menu", "footer"]);
    expect(unnamedParts(CLONES.replace("Footer: Locomotive, https://locomotive.ca", "Footer: Locomotive"))).toEqual(["footer"]);
    // A description that mentions a header-like strip is not a second header.
    expect(unnamedParts(`${CLONES}\nheader-like strip: none`)).toEqual([]);
    expect(unnamedParts("**Header:** Lusion, https://lusion.co\n**Dropdown menu** — Lusion, https://lusion.co\n1. Footer: Lusion, https://lusion.co")).toEqual([]);
  });

  test("a verdict agrees only when every part is equal, and a disagreement has to ask for something", () => {
    expect(readVerdict(`Here you go:\n\`\`\`json\n${AGREE}\n\`\`\``)?.equal).toBe(true);
    const halfway = JSON.stringify({ equal: true, header: part(true), menu: part(false, "the menu drops from the left"), footer: part(true), fixes: [] });
    // Called equal overall while the menu is not: the differences become the fixes.
    expect(readVerdict(halfway)).toMatchObject({ equal: false, fixes: ["The dropdown menu: the menu drops from the left"] });
    expect(readVerdict(JSON.stringify({ equal: "false", header: part(false), menu: part(true), footer: part(true), fixes: [] }))).toBeNull();
    expect(readVerdict(JSON.stringify({ equal: "true", header: { ...part(true), equal: "true" }, menu: part(true), footer: part(true) }))?.equal).toBe(true);
    expect(readVerdict(JSON.stringify({ equal: true, header: part(true), footer: part(true) }))).toBeNull();
    expect(readVerdict("They look the same to me.")).toBeNull();
  });

  test("a rework that leaves styles out is caught before it reaches the reviewer", () => {
    const pages = [{ body: HOME }];
    expect(lostPageStyles(shell(), shell(".bar{height:96px}"), pages)).toEqual([]);
    expect(lostPageStyles(shell(), shell(".bar{height:96px}", ".hours{display:grid}"), pages)).toEqual(["menu-card"]);
    expect(elided("<style>/* ... */</style>")).toBe("/* ... */");
    expect(elided("<style>.a{}/* rest of the styles unchanged */</style>")).toBe("/* rest of the styles unchanged */");
    expect(elided("<nav><!-- links unchanged --></nav>")).toBe("<!-- links unchanged -->");
    expect(elided("<style>/* the header's bar */.bar{}</style><!--forge-page-->")).toBeNull();
  });

  test("the retired reviewer never holds a build", async () => {
    const site = { shell: shell(), pages: [{ path: "/", title: "Home", body: HOME }] };
    const before = await chromeHash(site);
    expect(designReviewOn()).toBe(false);
    expect(await needsReview("generate", null, site)).toBe(false);
    expect(await needsReview("edit", before, { ...site, pages: [{ path: "/", title: "Home", body: "<main>New</main>" }] })).toBe(false);
    expect(await needsReview("edit", before, { ...site, shell: shell(".bar{height:96px}") })).toBe(false);
    process.env.DESIGN_REVIEW = "on";
    expect(designReviewOn()).toBe(false);
    expect(await needsReview("generate", null, site)).toBe(false);
  });

  test("a reply carries its clones block, and a rework may send back the shell alone", () => {
    expect(parseReply(siteReply())).toMatchObject({ clones: CLONES, summary: "Built a harbour-side site for Harbor Roasters." });
    expect(parseReply(siteReply({ clones: null })).clones).toBeUndefined();
    const back = parseShellReply(reworkReply(shell(".bar{height:96px}")));
    expect(back).toMatchObject({ clones: CLONES, pages: [], summary: "Made the header 96px tall." });
    expect(back.shell).toContain(".bar{height:96px}");
    expect(() => parseShellReply("Made the header taller.\n\n```html shell\n<!doctype html><html><body>cut")).toThrow("shell is missing or unfinished");
  });
});
