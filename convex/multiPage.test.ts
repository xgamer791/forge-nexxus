/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { crewCall, type CrewCall } from "./crewMock";
import { builtSite, parseReply } from "./generate";
import { QUESTION_SET, QUESTIONS } from "./onboardingQuestions";
import { serializeSite } from "./pages";
import schema from "./schema";

// A build with pages, from the model's reply to the address a visitor types:
// the parser, the pictures made once for the whole site, the version that is
// stored, and the page that is served. Nothing is seeded past what a member
// does; the scheduler runs for real.
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

const KEY = "sk-test-secret-key";
const PNG = btoa("not really a png, but bytes are bytes");
const PICTURE =
  '<img src="forge-image:1" data-forge-image="Morning light on the roastery counter" ' +
  'data-forge-aspect="16:9" alt="The roastery counter" width="1600" height="900">';

// The shell names the business in its <title> and carries no title marker, so
// the page's own title has to take its place. The picture sits on two pages,
// which is one picture.
const SHELL =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Harbor Roasters</title>' +
  '<meta name="description" content="Coffee roasted on the pier"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<style>body{margin:0}</style></head><body>" +
  '<nav><a href="/">Home</a> <a href="/contact">Contact</a></nav><!--forge-page--><footer>Harbor Roasters</footer></body></html>';
const HOME = `<h1>Harbor Roasters</h1>${PICTURE}`;
const CONTACT = `<h1>Find us</h1>${PICTURE}<p>Pier 4, Port Ellen.</p>`;
const siteReply = (summary: string, contact = CONTACT) =>
  `${summary}\n\n\`\`\`html shell\n${SHELL}\n\`\`\`\n\n` +
  `\`\`\`html path="/" title="Harbor Roasters"\n${HOME}\n\`\`\`\n\n` +
  `\`\`\`html path="/contact" title="Find us"\n${contact}\n\`\`\``;

const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

// A first build's crew, writing the same two-page site: the header with the
// nav, the footer, and each page's two halves. The picture sits on both
// pages, which is one picture.
const HEADER = '<style>.site-header{padding:16px}</style><header class="site-header"><nav><a href="/">Home</a> <a href="/contact">Contact</a></nav></header>';
const FOOTER = "<footer>Harbor Roasters</footer>";
function crewSite(contact = "<p>Pier 4, Port Ellen.</p>") {
  return (call: CrewCall) => {
    const block = (markup: string, title?: string) =>
      `Built the ${call.part}.\n\n\`\`\`html part="${call.part}"${title ? ` title="${title}"` : ""}\n${markup}\n\`\`\``;
    if (call.part === "header") return block(HEADER);
    if (call.part === "footer") return block(FOOTER);
    if (call.path === "/") {
      return call.part === "body1" ? block(`<section><h1>Harbor Roasters</h1>${PICTURE}</section>`, "Harbor Roasters") : block("<section><p>Roasted on the pier.</p></section>");
    }
    return call.part === "body1" ? block(`<section><h1>Find us</h1>${PICTURE}</section>`, "Find us") : block(`<section>${contact}</section>`);
  };
}

// One fetch for every provider, as in buildFlow.test.ts: the strategist is
// told apart by what it was asked, a first build's crew by its turn, and every
// other chat call is a thread build.
function stubProviders(build: (call: number) => string, crew: (call: CrewCall) => string = crewSite()) {
  const calls: { url: string; body: any }[] = [];
  let builds = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (/generateContent/.test(url)) {
        return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG } }] } }] });
      }
      const system = body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
      if (/private website strategist/.test(system)) {
        return json({ choices: [{ message: { content: "Lead with the roastery. One clear call." } }] });
      }
      const member = crewCall(body);
      if (member) return json({ choices: [{ message: { content: crew(member) } }] });
      builds += 1;
      return json({ choices: [{ message: { content: build(builds) } }] });
    }),
  );
  return {
    calls,
    pictures: () => calls.filter((call) => /generateContent/.test(call.url)).length,
    builds: () => calls.filter((call) => /chat\/completions/.test(call.url)),
  };
}

beforeEach(() => {
  process.env.AI_BASE_URL = "https://ai.example/v1/";
  process.env.AI_API_KEY = KEY;
  process.env.AI_MODEL = "forge-test";
  process.env.AI_IMAGE_API_KEY = "img-test-secret-key";
  process.env.CONVEX_SITE_URL = "https://forge-test.convex.site";
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AI_BUILD_MODEL", "AI_BUILD_BASE_URL", "AI_BUILD_API_KEY", "AI_REASONING_EFFORT", "AI_IMAGE_API_KEY", "CONVEX_SITE_URL"]) {
    delete process.env[name];
  }
});

describe("parseReply reads a site in blocks", () => {
  test("the shell, every page, its address and its title", () => {
    const parsed = parseReply(siteReply("Built a two-page site for the roastery."));
    expect(parsed.summary).toBe("Built a two-page site for the roastery.");
    expect(parsed.html).toBe(null);
    expect(parsed.shell).toBe(SHELL);
    expect(parsed.pages).toEqual([
      { path: "/", title: "Harbor Roasters", body: HOME },
      { path: "/contact", title: "Find us", body: CONTACT },
    ]);
    expect(builtSite(parsed)).toEqual({ shell: SHELL, pages: parsed.pages });
  });

  test("a page's address is normalised and a repeat of one is not a second page", () => {
    const reply =
      "Done.\n\n```html shell\n" + SHELL + "\n```\n\n" +
      "```html path=\"/\"\n<h1>Home</h1>\n```\n\n" +
      "```html path=\"/About/\"\n<h1>First</h1>\n```\n\n" +
      "```html path=\"/about.html\"\n<h1>Second</h1>\n```";
    const parsed = parseReply(reply);
    expect(parsed.pages!.map((page) => [page.path, page.body])).toEqual([
      ["/", "<h1>Home</h1>"],
      ["/about", "<h1>First</h1>"],
    ]);
  });

  test("a title the fence did not carry comes from the heading, else the address", () => {
    const reply =
      "Done.\n\n```html shell\n" + SHELL + "\n```\n\n" +
      "```html path=\"/\"\n<h1>Welcome <em>in</em></h1>\n```\n\n" +
      "```html path=\"/our-story\"\n<p>No heading here.</p>\n```\n\n" +
      "```html /contact\n<p>Bare address, no attributes.</p>\n```";
    expect(parseReply(reply).pages!.map((page) => [page.path, page.title])).toEqual([
      ["/", "Welcome in"],
      ["/our-story", "Our Story"],
      ["/contact", "Contact"],
    ]);
  });

  test("a site the token cap cut off is refused, not stored in part", () => {
    const whole = siteReply("Built it.");
    // The shell never closed.
    expect(() => parseReply(whole.replace(/```\n\n```html path="\/"/, "\n\n```html path=\"/\""))).toThrow("complete site");
    // The last page never closed.
    expect(() => parseReply(whole.slice(0, whole.length - 3))).toThrow("complete site");
    // Pages with no shell to go in.
    expect(() => parseReply("Done.\n\n```html path=\"/\"\n<h1>Home</h1>\n```")).toThrow("complete site");
    // A shell whose pages do not include the home page.
    expect(() => parseReply("Done.\n\n```html shell\n" + SHELL + "\n```\n\n```html path=\"/about\"\n<h1>About</h1>\n```")).toThrow("no home page");
    // An address that cannot be served is not quietly dropped.
    expect(() => parseReply("Done.\n\n```html shell\n" + SHELL + "\n```\n\n```html path=\"/../x\"\n<p>x</p>\n```")).toThrow("cannot be served");
  });

  test("a reply in the old one-document form is still a whole site", () => {
    const page = '<!doctype html><html lang="en"><head><title>Shop</title></head><body><h1>Shop</h1></body></html>';
    const parsed = parseReply(`Built it.\n\n\`\`\`html\n${page}\n\`\`\``);
    expect(parsed).toEqual({ html: page, summary: "Built it." });
    expect(builtSite(parsed)).toEqual({ html: page });
    expect(builtSite(parseReply("Just talking about your site."))).toBe(null);
  });

  test("what the model is handed back on an edit is what it wrote", () => {
    const site = builtSite(parseReply(siteReply("Built it.")))!;
    const again = parseReply(`Changed the story.\n\n${serializeSite(site)}`);
    expect(builtSite(again)).toEqual(site);
    expect(again.summary).toBe("Changed the story.");
  });
});

// The first build of a site is the onboarding build; a thread turn edits it.
// Asking for messages is what gives the site its second page, /contact.
const ONBOARDING: Partial<Record<(typeof QUESTIONS)[number]["id"], string>> = {
  name: "Harbor Roasters", offer: "Coffee on the pier", features: "Send you a message",
};
async function onboarded(t: T, member: Awaited<ReturnType<typeof createBuilder>>) {
  const id = await member.as.mutation(api.onboarding.start, {});
  for (let index = 0; index < QUESTIONS.length; index += 1) {
    const answer = ONBOARDING[QUESTIONS[index].id] ?? "";
    await member.as.mutation(api.onboarding.save, { id, index, answer, advance: true, questionSet: QUESTION_SET });
  }
  await member.as.mutation(api.onboarding.submit, { id });
  await t.finishAllScheduledFunctions(() => {});
  const brief = (await t.run((ctx) => ctx.db.get(id)))!;
  expect(brief.status).toBe("complete");
  expect(brief.error).toBeUndefined();
  return (await t.run((ctx) => ctx.db.get(brief.siteId!)))!;
}

describe("a build with pages, start to finish", () => {
  test("stores the shell and pages, makes each picture once, and serves every page", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => siteReply("Built a two-page site for the roastery."));
    const site = await onboarded(t, member);

    // The picture appears on two pages and was asked for once.
    expect(providers.pictures()).toBe(1);
    const [version] = await t.run((ctx) => ctx.db.query("siteVersions").collect());
    expect(version.html).toBeUndefined();
    expect(version.shell).toContain('<nav><a href="/">Home</a> <a href="/contact">Contact</a></nav>');
    expect(version.shell).toContain("<!--forge-page-->\n<footer>Harbor Roasters</footer>");
    expect(version.pages!.map((page) => [page.path, page.title])).toEqual([["/", "Harbor Roasters"], ["/contact", "Find us"]]);
    const images = await t.run((ctx) => ctx.db.query("siteImages").collect());
    expect(images).toHaveLength(1);
    const url = await t.run((ctx) => ctx.storage.getUrl(images[0].storageId));
    for (const page of version.pages!) {
      expect(page.body).not.toContain("forge-image:");
      expect(page.body).toContain(url);
    }

    // Published, and every page answers at its address with the shell around it.
    expect(site.status).toBe("published");
    const contact = await t.fetch(`/sites/${site.slug}/contact`);
    expect(contact.status).toBe(200);
    const served = await contact.text();
    expect(served).toContain("<title>Find us</title>");
    expect(served).toContain("<h1>Find us</h1>");
    // Read from the origin by a browser, so the nav is pointed under the slug.
    expect(served).toContain(`<nav><a href="/sites/${site.slug}/">Home</a> <a href="/sites/${site.slug}/contact">Contact</a></nav>`);
    expect(served).toContain("<footer>Harbor Roasters</footer>");
    expect(served).not.toContain("<h1>Harbor Roasters</h1>");
    expect(served).not.toContain("forge-page");
    expect(await (await t.fetch(`/sites/${site.slug}`)).text()).toContain("<title>Harbor Roasters</title>");
    // A site with pages knows its addresses; the rest are nothing.
    expect((await t.fetch(`/sites/${site.slug}/nowhere`)).status).toBe(404);

    // The preview shows the home page.
    const preview = await member.as.query(api.sites.currentHtml, { siteId: site._id });
    expect(preview?.html).toContain("<h1>Harbor Roasters</h1>");
    expect(preview?.html).not.toContain("<h1>Find us</h1>");
  });

  test("an edit is handed the whole site in the blocks it came in, and returns a new version of it", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const providers = stubProviders(() => siteReply("Added the opening hours.", "<h1>Find us</h1><p>Open from 7am.</p>"));
    const site = await onboarded(t, member);
    await member.as.action(api.generate.run, { conversationId: site.conversationId, prompt: "Add the opening hours to the contact page" });

    // The strategist, the onboarding crew, then the edit. Captured before the
    // audit's drain, which also runs the memory note.
    const edit = providers.builds().at(-1)!;
    const handed = edit.body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
    expect(handed).toContain("```html shell\n<!doctype html>");
    expect(handed).toContain('<nav><a href="/">Home</a> <a href="/contact">Contact</a></nav>');
    expect(handed).toContain('```html path="/contact" title="Find us"');
    expect(handed).toContain("return the whole updated site, every block");

    // The edit is saved as it was written.
    await t.finishAllScheduledFunctions(() => {});
    const versions = await t.run((ctx) => ctx.db.query("siteVersions").collect());
    expect(versions).toHaveLength(2);
    expect(versions[1].pages!.find((page) => page.path === "/contact")!.body).toContain("Open from 7am.");
    expect(await (await t.fetch(`/sites/${site.slug}/contact`)).text()).toContain("Open from 7am.");
  });

  test("a first build's part that stopped short is asked for again, whole, and the site still lands in blocks", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    // The contact page's top half never closed its block the first time.
    const whole = crewSite();
    let cut = true;
    const providers = stubProviders(() => siteReply("Built it."), (call) => {
      const reply = whole(call);
      if (call.path === "/contact" && call.part === "body1" && cut) {
        cut = false;
        return reply.slice(0, -3);
      }
      return reply;
    });
    await onboarded(t, member);

    const tops = providers.calls.filter((call) => /chat\/completions/.test(call.url) && crewCall(call.body)?.path === "/contact" && crewCall(call.body)?.part === "body1");
    expect(tops).toHaveLength(2);
    expect(tops[1].body.messages.at(-1).content).toContain("Your last reply for this part could not be used: the top half stopped before its block closed.");
    const [version] = await t.run((ctx) => ctx.db.query("siteVersions").collect());
    expect(version.pages!.map((page) => page.path)).toEqual(["/", "/contact"]);
    expect(version.html).toBeUndefined();
  });
});

describe("the site as files", () => {
  test("one file per page, named for its address, linked to each other, badge-free on a paid plan", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    stubProviders(() => siteReply("Built it."), crewSite('<a href="/">Back home</a><a href="/contact#hours">Hours</a>'));
    const site = await onboarded(t, member);

    const exported = await member.as.query(api.sites.exportPages, { siteId: site._id });
    expect(exported!.files.map((file) => file.name)).toEqual(["index.html", "contact.html"]);
    const [home, contact] = exported!.files;
    expect(home.html).toContain("<title>Harbor Roasters</title>");
    expect(home.html).toContain('<nav><a href="index.html">Home</a> <a href="contact.html">Contact</a></nav>');
    expect(contact.html).toContain("<title>Find us</title>");
    expect(contact.html).toContain('<a href="index.html">Back home</a><a href="contact.html#hours">Hours</a>');
    expect(contact.html).not.toContain("forge-page");
    expect(contact.html).not.toContain("Built with Forge");

    // Nobody else's, and not a free plan's.
    const stranger = await createBuilder(t, "s@example.com");
    expect(await stranger.as.query(api.sites.exportPages, { siteId: site._id })).toBe(null);
    await t.mutation(internal.billing.grantPlan, { userId: member.userId, plan: "free" });
    expect(await member.as.query(api.sites.exportPages, { siteId: site._id })).toBe(null);
  });

  test("a site built before pages existed is its one document", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    const page = '<!doctype html><html lang="en"><head><title>Shop</title></head><body><h1>Shop</h1><a href="/">Top</a></body></html>';
    // Every build writes pages now, so the old one-document site is seeded as it was saved.
    const site = await t.run(async (ctx) => {
      const conversationId = await ctx.db.insert("conversations", { userId: member.userId, title: "Shop", updatedAt: Date.now() });
      const siteId = await ctx.db.insert("sites", { userId: member.userId, conversationId, name: "Shop", status: "draft", createdAt: Date.now(), updatedAt: Date.now() });
      const versionId = await ctx.db.insert("siteVersions", { userId: member.userId, siteId, html: page, summary: "Built it.", requestKind: "generate", createdAt: Date.now() });
      await ctx.db.patch(siteId, { currentVersionId: versionId });
      return (await ctx.db.get(siteId))!;
    });
    const exported = await member.as.query(api.sites.exportPages, { siteId: site._id });
    expect(exported!.files).toHaveLength(1);
    expect(exported!.files[0].name).toBe("index.html");
    expect(exported!.files[0].html).toContain('<a href="index.html">Top</a>');
  });
});

describe("the site read straight from this deployment's origin", () => {
  test("a browser gets links it can follow under /sites/<slug>; the sites router gets the page untouched", async () => {
    const t = fresh();
    const member = await createBuilder(t, "m@example.com");
    stubProviders(() => siteReply("Built it."));
    const site = await onboarded(t, member);

    const browser = await (await t.fetch(`/sites/${site.slug}/contact`)).text();
    expect(browser).toContain(`<nav><a href="/sites/${site.slug}/">Home</a> <a href="/sites/${site.slug}/contact">Contact</a></nav>`);

    const routed = await (
      await t.fetch(`/sites/${site.slug}/contact`, { headers: { "user-agent": "ForgeNexxus-SitesRouter/1.0" } })
    ).text();
    expect(routed).toContain('<nav><a href="/">Home</a> <a href="/contact">Contact</a></nav>');
    // And the branded host, asked for by host, is never rewritten either.
    process.env.SITES_DOMAIN = "sites.forgenexxus.com";
    const branded = await (await t.fetch("/contact", { headers: { host: `${site.slug}.sites.forgenexxus.com` } })).text();
    expect(branded).toContain('<a href="/contact">Contact</a>');
  });
});
