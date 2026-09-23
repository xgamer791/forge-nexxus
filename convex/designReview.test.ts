/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  chromeHash,
  DESIGN_REVIEWER,
  elided,
  lostPageStyles,
  needsReview,
  readVerdict,
  unnamedParts,
} from "./designCheck";
import { DESIGN_GOD } from "./designgod";
import { FED } from "./fed";
import { FORGE_MD } from "./forgeMd";
import { parseReply, parseShellReply } from "./generate";
import { QUESTIONS } from "./onboardingQuestions";
import schema from "./schema";

// The second agent. A build's header, dropdown menu and footer go to a
// separate design reviewer before the build is saved, and come back to the
// design agent until the reviewer agrees. The scheduler runs for real, so a
// check and its reworks run the way they would on Convex.
const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);
type T = ReturnType<typeof fresh>;

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

const ANSWERS = [
  "Harbor Roasters",
  "Small-batch coffee roasted on the pier",
  "Neighbours and visitors in Port Ellen",
  "Contact you",
  "",
  "Collect inquiries",
  "Warm and welcoming",
  "",
  "",
  "",
  "Pier Roast 250g — £11",
];

async function answerEverything(member: Member) {
  const id = await member.as.mutation(api.onboarding.start, {});
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    await member.as.mutation(api.onboarding.save, { id, index, answer: ANSWERS[index], advance: true });
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
const HEADER_FIX = "Make the header 96px tall with 40px side padding, as the original is.";
const DISAGREE = JSON.stringify({
  equal: false,
  header: part(false, "the header is 64px tall with 16px side padding; the original's is 96px tall with 40px"),
  menu: part(true),
  footer: part(true),
  fixes: [HEADER_FIX],
});

const PNG = btoa("not really a png, but bytes are bytes");
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const answer = (content: string) => json({ choices: [{ message: { content } }] });

type Call = { url: string; body: any };
const systemOf = (call: Call) =>
  call.body.messages.filter((message: any) => message.role === "system").map((message: any) => message.content).join("\n");
const lastUser = (call: Call) => call.body.messages.filter((message: any) => message.role === "user").at(-1)?.content ?? "";

// The design agent and the design reviewer, told apart by their instructions.
// The strategist and the memory note are answered so they stay out of the way.
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
      return answer(agents.build(++builds));
    }),
  );
  const chat = () => calls.filter((call) => /chat\/completions/.test(call.url));
  return {
    builds: () => chat().filter((call) => !/You are Forge's design reviewer|private website strategist|You maintain Forge's memory/.test(systemOf(call))),
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

// A member's first site, built from the questions and let through by the reviewer.
async function firstSite(t: T, member: Member) {
  const id = await answerEverything(member);
  await member.as.mutation(api.onboarding.submit, { id });
  await drain(t);
  const row = (await t.run((ctx) => ctx.db.get(id)))!;
  const site = (await t.run((ctx) => ctx.db.get(row.siteId!)))!;
  return { id, site };
}

describe("a first build waits for the design reviewer", () => {
  test("the reviewer sends the header back, the rework is checked again, and only then is the site saved", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({
      build: (call) => (call === 1 ? siteReply() : reworkReply(shell(".bar{height:96px;padding:0 40px}"))),
      review: (call) => (call === 1 ? DISAGREE : AGREE),
    });

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    // One build, one rework, and a verdict on each.
    expect(agents.builds()).toHaveLength(2);
    expect(agents.reviews()).toHaveLength(2);

    // The reviewer is its own agent: its own instructions and the rules for
    // reference, never the design agent's instructions or house rules.
    const [first, second] = agents.reviews();
    expect(first.body.messages[0].content).toBe(DESIGN_REVIEWER);
    expect(systemOf(first)).toContain(DESIGN_GOD);
    expect(systemOf(first)).not.toContain("You are Forge, the website-building agent");
    expect(systemOf(first)).not.toContain(FORGE_MD);
    expect(systemOf(first)).not.toContain(FED);
    expect(first.body.model).toBe("forge-test");
    expect(first.body.max_tokens).toBe(32000);
    // It is shown what the design agent says it cloned, and the shell it built,
    // before any picture has been made.
    expect(lastUser(first)).toContain(fence("clones", CLONES));
    expect(lastUser(first)).toContain(shell());
    expect(lastUser(first)).toContain("forge-image:1");
    expect(lastUser(first)).toContain("Round 1 of the design check.");
    // The second round checks the fixes it asked for, then everything again.
    expect(lastUser(second)).toContain("Round 2 of the design check.");
    expect(lastUser(second)).toContain(`- ${HEADER_FIX}`);
    expect(lastUser(second)).toContain(".bar{height:96px;padding:0 40px}");

    // The design agent gets its own instructions back, its site and originals,
    // and the fixes, and is asked for the shell alone.
    const rework = agents.builds()[1];
    expect(systemOf(rework)).toContain("You are Forge, the website-building agent");
    expect(systemOf(rework)).toContain("Its header, dropdown menu and footer are clones of these originals");
    expect(lastUser(rework)).toContain("did not agree they are equal");
    expect(lastUser(rework)).toContain(`- ${HEADER_FIX}`);
    expect(lastUser(rework)).toContain("every page you do not return stays exactly as it is");

    // One version: the reworked shell, the pages as they were, the picture made,
    // and the originals kept beside it.
    const [version] = await versions(t);
    expect(await versions(t)).toHaveLength(1);
    expect(version.shell).toContain(".bar{height:96px;padding:0 40px}");
    expect(version.shell).toContain(PAGE_STYLES);
    expect(version.pages?.[0].body).toContain('<div class="menu-card">Pier Roast</div>');
    expect(version.pages?.[0].body).not.toContain("forge-image:");
    expect(version.clones).toBe(CLONES);

    // The progress log says the work went back and then passed, before it was saved.
    const brief = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(brief.status).toBe("complete");
    expect(brief.events.map((event) => event.label)).toEqual([
      "Answers submitted",
      "Build brief saved and read",
      "Agent started building your website",
      "Header, menu and footer sent back for changes",
      "Header, menu and footer passed the design check",
      "Page written",
      "Pictures made for your site",
      "Website received from the agent",
      "Website saved and ready",
    ]);

    // The check is over: its verdicts stay, the site it held does not.
    const [review] = await reviews(t);
    expect(review).toMatchObject({ source: "onboarding", status: "passed", round: 2, clones: CLONES });
    expect(review.shell).toBeUndefined();
    expect(review.pages).toBeUndefined();
    expect(review.verdicts.map((verdict) => [verdict.round, verdict.equal, verdict.header])).toEqual([[1, false, false], [2, true, true]]);

    // The credits settle once, and the run reads as a finished build.
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "settled"]]);
    const [run] = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(run).toMatchObject({ status: "complete", imageMade: 1 });
    const events = await t.run((ctx) => ctx.db.query("buildEvents").withIndex("by_run", (q) => q.eq("runId", run._id)).collect());
    expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining([
      "design_review", "design_verdict", "design_revision", "design_revision_done", "images", "saving", "complete",
    ]));
    expect(events.filter((event) => event.phase === "design_verdict").map((event) => event.detail?.round)).toEqual([1, 2]);
  });

  test("a build the reviewer never agrees to is not saved, and its credits go back", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    process.env.DESIGN_REVIEW_ROUNDS = "1";
    const agents = stubAgents({
      build: (call) => (call === 1 ? siteReply() : reworkReply(shell(".bar{height:80px}"))),
      review: () => DISAGREE,
    });

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    // One rework allowed: two verdicts, and then the build stops.
    expect(agents.reviews()).toHaveLength(2);
    expect(agents.builds()).toHaveLength(2);
    expect(await versions(t)).toEqual([]);
    const brief = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(brief.status).toBe("failed");
    expect(brief.error).toBe(
      "The header, menu and footer still didn't pass the design check after one round of changes, so this build wasn't saved. Try again. Your answers are saved.",
    );
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "released"]]);
    const [run] = await t.run((ctx) => ctx.db.query("buildRuns").collect());
    expect(run).toMatchObject({ status: "failed", errorClass: "design_check" });
    const [review] = await reviews(t);
    expect(review).toMatchObject({ status: "failed", round: 2 });
    expect(review.shell).toBeUndefined();
  });

  test("a reply that names no originals goes back without asking the reviewer to guess", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({
      build: (call) => (call === 1 ? siteReply({ clones: null }) : reworkReply(shell(".bar{height:96px}"))),
      review: () => AGREE,
    });

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    // No model was asked about a clone of nothing; the rework was asked for
    // the originals, and the reviewer checked that.
    expect(agents.reviews()).toHaveLength(1);
    const rework = agents.builds()[1];
    expect(lastUser(rework)).toContain("Your reply had no clones block.");
    expect(lastUser(rework)).toContain("Name the Awwwards original you cloned for the header in the clones block");
    expect(lastUser(rework)).toContain("Name the Awwwards original you cloned for the dropdown menu in the clones block");
    expect(lastUser(rework)).toContain("Name the Awwwards original you cloned for the footer in the clones block");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });
    const [version] = await versions(t);
    expect(version.clones).toBe(CLONES);
    expect(version.shell).toContain(".bar{height:96px}");
  });

  test("a rework that drops the pages' styles is not used, and the design agent is told what it dropped", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({
      build: (call) =>
        call === 1 ? siteReply()
          : call === 2 ? reworkReply(shell(".bar{height:96px}", "/* the rest of the styles are unchanged */"))
            : call === 3 ? reworkReply(shell(".bar{height:96px}", ".hours{display:grid}"))
              : reworkReply(shell(".bar{height:96px}")),
      review: (call) => (call === 1 ? DISAGREE : AGREE),
    });

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await drain(t);

    expect(agents.builds()).toHaveLength(4);
    // Each go is told why the one before it was not used, and neither of the
    // unusable ones reached the reviewer.
    expect(lastUser(agents.builds()[2])).toContain(
      "Your last rework could not be used: the shell has a comment standing in for part of it (/* the rest of the styles are unchanged */).",
    );
    expect(lastUser(agents.builds()[3])).toContain("Your last rework could not be used: the shell dropped the styles the pages use for .menu-card. Keep every one of them.");
    expect(agents.reviews()).toHaveLength(2);
    const [version] = await versions(t);
    expect(version.shell).toContain(PAGE_STYLES);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "complete" });
  });

  test("a build cancelled during its check ends the check without asking the reviewer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({ build: () => siteReply(), review: () => AGREE });

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    // The build runs by hand, so the check it schedules waits.
    await t.action(internal.onboarding.build, { id, attempt: 1 });
    const [open] = await reviews(t);
    expect(open).toMatchObject({ status: "checking", round: 1 });

    await member.as.mutation(api.onboarding.cancel, {});
    await t.action(internal.designReview.check, { id: open._id });

    expect(agents.reviews()).toHaveLength(0);
    const [ended] = await reviews(t);
    expect(ended.status).toBe("cancelled");
    expect(ended.shell).toBeUndefined();
    expect(await versions(t)).toEqual([]);
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "released"]]);
  });

  test("the onboarding watchdog waits while the check is moving and speaks once it goes quiet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({ build: () => siteReply(), review: () => AGREE });

    const id = await answerEverything(member);
    await member.as.mutation(api.onboarding.submit, { id });
    await t.action(internal.onboarding.build, { id, attempt: 1 });
    const [open] = await reviews(t);

    // Heard from just now: the watchdog leaves the build building.
    await t.mutation(internal.onboarding.expire, { id, attempt: 1 });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "building" });
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "held"]]);

    // Quiet for longer than a step can run: the watchdog ends it.
    await t.run((ctx) => ctx.db.patch(open._id, { updatedAt: Date.now() - 11 * 60_000 }));
    await t.mutation(internal.onboarding.expire, { id, attempt: 1 });
    const brief = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(brief.status).toBe("failed");
    expect(brief.error).toBe("The build stopped responding. Your answers are saved. Try building again.");
    expect((await holds(t)).filter(([kind]) => kind === "generate")).toEqual([["generate", "released"]]);
    const [ended] = await reviews(t);
    expect(ended.status).toBe("failed");
    expect(ended.shell).toBeUndefined();

    // A check that wakes up after that does nothing.
    await t.action(internal.designReview.check, { id: open._id });
    expect(agents.reviews()).toHaveLength(0);
    expect(await versions(t)).toEqual([]);
  });
});

describe("an edit waits for the reviewer only when it changes the header, menu or footer", () => {
  test("a page-only edit is saved at once; a new header is checked first", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const edits: string[] = [];
    // The second verdict waits to be let go, so the thread can be read while
    // the reviewer is still reading the new header.
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    const agents = stubAgents({
      build: (call) => (call === 1 ? siteReply() : edits.shift()!),
      review: async (call) => {
        if (call === 2) await held;
        return AGREE;
      },
    });
    const { site } = await firstSite(t, member);
    expect(agents.reviews()).toHaveLength(1);

    // Same shell, new home page: nothing for the reviewer to look at.
    edits.push(siteReply({ summary: "Added this week's roast.", home: HOME.replace("Pier Roast", "Pier Roast, and this week's Kenya") }));
    await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "Add this week's roast" });
    expect(agents.reviews()).toHaveLength(1);
    expect(await versions(t)).toHaveLength(2);
    // The edit was told what the header, menu and footer were cloned from.
    expect(systemOf(agents.builds()[1])).toContain(fence("clones", CLONES));

    // A new header waits: the reply stays pending while the reviewer reads it.
    edits.push(siteReply({ summary: "Moved the menu into the header.", shell: shell(".bar{position:sticky;top:0}") }));
    const { messageId } = await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "Keep the menu on screen" });
    const pending = (await t.run((ctx) => ctx.db.get(messageId)))!;
    expect(pending.status).toBe("pending");
    expect(pending.body).toBe("Checking the header, menu and footer…");
    expect(await versions(t)).toHaveLength(2);

    letGo();
    await drain(t);
    expect(agents.reviews()).toHaveLength(2);
    const landed = (await t.run((ctx) => ctx.db.get(messageId)))!;
    expect(landed.status).toBeUndefined();
    expect(landed.body).toBe("Moved the menu into the header.");
    expect(landed.versionId).toBeDefined();
    const saved = (await t.run((ctx) => ctx.db.get(landed.versionId!)))!;
    expect(saved.shell).toContain(".bar{position:sticky;top:0}");
    expect((await holds(t)).filter(([kind]) => kind === "edit")).toEqual([["edit", "settled"], ["edit", "settled"]]);
  });

  test("an edit the reviewer never agrees to leaves the site as it was and says why in the thread", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    let reviewed = 0;
    const agents = stubAgents({
      build: (call) => (call === 1 ? siteReply() : siteReply({ shell: shell(".bar{height:40px}") })),
      review: () => (++reviewed === 1 ? AGREE : DISAGREE),
    });
    const { site } = await firstSite(t, member);
    process.env.DESIGN_REVIEW_ROUNDS = "0";

    const { messageId } = await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "A slimmer header" });
    await drain(t);

    expect(agents.reviews()).toHaveLength(2);
    const said = (await t.run((ctx) => ctx.db.get(messageId)))!;
    expect(said.status).toBeUndefined();
    expect(said.versionId).toBeUndefined();
    expect(said.body).toBe("The header, menu and footer still didn't pass the design check, so this build wasn't saved. Try again.");
    const after = (await t.run((ctx) => ctx.db.get(site._id)))!;
    expect(after.currentVersionId).toBe(site.currentVersionId);
    expect(await versions(t)).toHaveLength(1);
    expect((await holds(t)).filter(([kind]) => kind === "edit")).toEqual([["edit", "released"]]);
  });

  test("the thread watchdog waits while the check is moving and speaks once it goes quiet", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const agents = stubAgents({
      build: (call) => (call === 1 ? siteReply() : siteReply({ shell: shell(".bar{height:120px}") })),
      review: () => AGREE,
    });
    const { site } = await firstSite(t, member);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { messageId } = await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "A taller header" });
    const open = (await reviews(t)).find((review) => review.source === "thread")!;
    expect(open.status).toBe("checking");

    await t.mutation(internal.generate.expire, { assistantId: messageId, holdId: open.holdId });
    expect(await t.run((ctx) => ctx.db.get(messageId))).toMatchObject({ status: "pending" });

    await t.run((ctx) => ctx.db.patch(open._id, { updatedAt: Date.now() - 11 * 60_000 }));
    await t.mutation(internal.generate.expire, { assistantId: messageId, holdId: open.holdId });
    const said = (await t.run((ctx) => ctx.db.get(messageId)))!;
    // The turn already answered, so the thread is where this is said.
    expect(said.status).toBeUndefined();
    expect(said.body).toBe("The build stopped responding. Try again.");
    expect((await holds(t)).filter(([kind]) => kind === "edit")).toEqual([["edit", "released"]]);
    expect((await reviews(t)).find((review) => review._id === open._id)?.status).toBe("failed");
    expect(agents.reviews()).toHaveLength(1);
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

  test("a new site is always checked; an edit only when its shell changed", async () => {
    const site = { shell: shell(), pages: [{ path: "/", title: "Home", body: HOME }] };
    const before = await chromeHash(site);
    expect(await needsReview("generate", null, site)).toBe(true);
    expect(await needsReview("edit", before, { ...site, pages: [{ path: "/", title: "Home", body: "<main>New</main>" }] })).toBe(false);
    // Whitespace and comments are not a new header.
    expect(await needsReview("edit", before, { ...site, shell: site.shell.replace("<!--forge-page-->", "\n  <!--forge-page-->\n") })).toBe(false);
    expect(await needsReview("edit", before, { ...site, shell: shell(".bar{height:96px}") })).toBe(true);
    process.env.DESIGN_REVIEW = "0";
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
