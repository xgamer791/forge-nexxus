/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import http from "./http";
import { composePage, designSource, normalizePath } from "./pages";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const fresh = () => convexTest(schema, modules);

beforeEach(() => {
  process.env.SITES_DOMAIN = "sites.forgenexxus.com";
});
afterEach(() => {
  delete process.env.SITES_DOMAIN;
});

// Serving a site's other pages means a catch-all on `/`, and a catch-all on
// `/` is only safe because of how Convex picks a route: exact paths win
// outright, and prefixes are tried longest-first. That is a property of
// somebody else's router, so it is asserted here against the real route table
// rather than reasoned about. If a Convex upgrade ever changes it, the Stripe
// webhook and the auth callbacks start going to member sites, and this fails
// first.
describe("the catch-all cannot swallow a route that is not a member's site", () => {
  const route = (path: string, method: "GET" | "POST" = "GET") =>
    http.lookup(path, method)?.[2] ?? null;

  test("exact paths beat every prefix", () => {
    expect(route("/")).toBe("/");
    expect(route("/index.html")).toBe("/index.html");
    expect(route("/site-by-host")).toBe("/site-by-host");
    expect(route("/stripe/webhook", "POST")).toBe("/stripe/webhook");
    expect(route("/.well-known/openid-configuration")).toBe("/.well-known/openid-configuration");
    expect(route("/.well-known/jwks.json")).toBe("/.well-known/jwks.json");
  });

  test("a longer prefix beats the catch-all", () => {
    expect(route("/sites/bakery")).toBe("/sites/*");
    expect(route("/sites/bakery/about")).toBe("/sites/*");
    expect(route("/api/auth/callback/google")).toBe("/api/auth/callback/*");
  });

  test("only an address nothing else claimed reaches a member's site", () => {
    expect(route("/about")).toBe("/*");
    expect(route("/shop/shirts")).toBe("/*");
    // The webhook path is a POST route, so a GET of it is not a webhook and is
    // free to be a page. Prefix tables are kept per method.
    expect(route("/stripe/webhook")).toBe("/*");
  });
});

describe("one address names one page", () => {
  test("the shapes a visitor might type all mean the same page", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath(undefined)).toBe("/");
    expect(normalizePath("/index.html")).toBe("/");
    expect(normalizePath("/about")).toBe("/about");
    expect(normalizePath("/about/")).toBe("/about");
    expect(normalizePath("/About")).toBe("/about");
    expect(normalizePath("/about.html")).toBe("/about");
    expect(normalizePath("/about/index.html")).toBe("/about");
    expect(normalizePath("//about//")).toBe("/about");
    expect(normalizePath("about")).toBe("/about");
    expect(normalizePath("/our%20story")).toBe("/our story");
    expect(normalizePath("/shop/shirts")).toBe("/shop/shirts");
  });

  test("an address that names nothing is refused rather than resolved", () => {
    expect(normalizePath("/../secrets")).toBe(null);
    expect(normalizePath("/shop/../../etc")).toBe(null);
    expect(normalizePath("/%E0%A4%A")).toBe(null);
  });
});

describe("a shell and its pages make a document", () => {
  const SHELL =
    '<!doctype html><html lang="en"><head><title><!--forge-title--></title>' +
    "<style>body{margin:0}</style></head><body><nav>Forge</nav>" +
    "<!--forge-page--><footer>Bye</footer></body></html>";
  const version = {
    html: undefined,
    shell: SHELL,
    pages: [
      { path: "/", title: "Home", body: "<h1>Home</h1>" },
      { path: "/about", title: "About us", body: "<h1>About</h1>" },
    ],
  };

  test("the page goes in the shell and brings its own title", () => {
    const home = composePage(version, "/")!;
    expect(home).toContain("<title>Home</title>");
    expect(home).toContain("<h1>Home</h1>");
    // Everything the pages share is in there once, from the shell.
    expect(home).toContain("<nav>Forge</nav>");
    expect(home).toContain("<footer>Bye</footer>");
    expect(home).not.toContain("<h1>About</h1>");
    expect(home).not.toContain("forge-page");

    const about = composePage(version, "/about")!;
    expect(about).toContain("<title>About us</title>");
    expect(about).toContain("<h1>About</h1>");
    expect(about).toContain("<nav>Forge</nav>");
  });

  test("the addresses a visitor might type reach the page", () => {
    for (const path of ["/about/", "/About", "/about.html", "/about/index.html"]) {
      expect(composePage(version, path)).toContain("<h1>About</h1>");
    }
    for (const path of ["/", "", "/index.html"]) {
      expect(composePage(version, path)).toContain("<h1>Home</h1>");
    }
  });

  test("a page the site does not have is nothing, not an empty frame", () => {
    expect(composePage(version, "/contact")).toBe(null);
    expect(composePage(version, "/../about")).toBe(null);
  });

  test("a title is text in the shell's title, never markup", () => {
    const composed = composePage(
      { ...version, pages: [{ path: "/", title: "Bread & Butter</title><script>", body: "<p>x</p>" }] },
      "/",
    )!;
    expect(composed).toContain("<title>Bread &amp; Butter&lt;/title&gt;&lt;script&gt;</title>");
    expect(composed).not.toContain("<script>");
  });

  test("a shell that lost its marker still serves the page", () => {
    const noMarker = '<!doctype html><html><head><title>Site</title></head><body><nav>n</nav></body></html>';
    const composed = composePage(
      { html: undefined, shell: noMarker, pages: [{ path: "/", title: "Home", body: "<h1>Hi</h1>" }] },
      "/",
    )!;
    expect(composed).toContain("<h1>Hi</h1>");
    expect(composed).toContain("<nav>n</nav>");
    expect(composed.indexOf("<h1>Hi</h1>")).toBeLessThan(composed.indexOf("</body>"));
  });
});

describe("a site built before pages existed is untouched", () => {
  const PAGE = '<!doctype html><html lang="en"><head><title>Shop</title></head><body><h1>Shop</h1></body></html>';
  const old = { html: PAGE, shell: undefined, pages: undefined };

  test("its one document is its home page, and it has no others", () => {
    expect(composePage(old, "/")).toBe(PAGE);
    expect(composePage(old, "/index.html")).toBe(PAGE);
    expect(composePage(old, "/about")).toBe(null);
  });

  test("a version with nothing in it serves nothing", () => {
    expect(composePage({ html: undefined, shell: undefined, pages: undefined }, "/")).toBe(null);
    // A shell with no pages is not a site; it must not serve the bare frame.
    expect(composePage({ html: undefined, shell: "<html></html>", pages: [] }, "/")).toBe(null);
  });
});

describe("what a design is, for telling two builds apart", () => {
  test("the order the model listed pages in is not part of the design", () => {
    const a = {
      html: undefined,
      shell: "S",
      pages: [
        { path: "/", title: "Home", body: "H" },
        { path: "/about", title: "About", body: "A" },
      ],
    };
    const b = { ...a, pages: [a.pages[1], a.pages[0]] };
    expect(designSource(a)).toBe(designSource(b));
  });

  test("a different body, or a different address, is a different design", () => {
    const base = { html: undefined, shell: "S", pages: [{ path: "/", title: "T", body: "H" }] };
    expect(designSource({ ...base, pages: [{ path: "/", title: "T", body: "OTHER" }] })).not.toBe(
      designSource(base),
    );
    expect(designSource({ ...base, pages: [{ path: "/x", title: "T", body: "H" }] })).not.toBe(
      designSource(base),
    );
    // Rewriting the headings is not a redesign.
    expect(designSource({ ...base, pages: [{ path: "/", title: "NEW", body: "H" }] })).toBe(
      designSource(base),
    );
  });

  test("a one-document version is its document", () => {
    expect(designSource({ html: "<html>x</html>", shell: undefined, pages: undefined })).toBe(
      "<html>x</html>",
    );
  });
});

// The routes end to end, on a published site, through the same handlers a
// visitor reaches.
describe("a published site answers on every page it has", () => {
  const SHELL =
    '<!doctype html><html lang="en"><head><title><!--forge-title--></title></head>' +
    "<body><nav>Forge</nav><!--forge-page--></body></html>";

  async function publishedSite(
    t: ReturnType<typeof fresh>,
    slug: string,
    version: { html?: string; shell?: string; pages?: { path: string; title: string; body: string }[] },
  ) {
    const { userId, sessionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: `${slug}@example.com` });
      const sessionId = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 60_000,
      });
      return { userId, sessionId };
    });
    await t.mutation(internal.billing.grantPlan, { userId, plan: "starter" });
    const as = t.withIdentity({ subject: `${userId}|${sessionId}` });
    const { siteId } = await as.mutation(api.sites.create, { name: slug });
    await t.run(async (ctx) => {
      const versionId = await ctx.db.insert("siteVersions", {
        userId,
        siteId,
        ...version,
        summary: "Built",
        requestKind: "generate",
        createdAt: Date.now(),
      });
      await ctx.db.patch(siteId, {
        currentVersionId: versionId,
        publishedVersionId: versionId,
        status: "published",
        slug,
        publishedAt: Date.now(),
      });
    });
    return { siteId: siteId as Id<"sites">, as };
  }

  test("/sites/<slug> serves the home page and /sites/<slug>/<path> the others", async () => {
    const t = fresh();
    await publishedSite(t, "bakery", {
      shell: SHELL,
      pages: [
        { path: "/", title: "Bakery", body: "<h1>Bakery</h1>" },
        { path: "/about", title: "About", body: "<h1>Our story</h1>" },
      ],
    });

    const home = await t.fetch("/sites/bakery");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<h1>Bakery</h1>");

    const trailing = await t.fetch("/sites/bakery/");
    expect(trailing.status).toBe(200);
    expect(await trailing.text()).toContain("<h1>Bakery</h1>");

    const about = await t.fetch("/sites/bakery/about");
    expect(about.status).toBe(200);
    const text = await about.text();
    expect(text).toContain("<h1>Our story</h1>");
    expect(text).toContain("<title>About</title>");
    expect(text).toContain("<nav>Forge</nav>");
    expect(about.headers.get("content-security-policy")).toContain("default-src 'none'");

    expect((await t.fetch("/sites/bakery/nowhere")).status).toBe(404);
    expect((await t.fetch("/sites/nobody-home/about")).status).toBe(404);
  });

  test("a site answers on its own host, on every page", async () => {
    const t = fresh();
    await publishedSite(t, "bakery", {
      shell: SHELL,
      pages: [
        { path: "/", title: "Bakery", body: "<h1>Bakery</h1>" },
        { path: "/about", title: "About", body: "<h1>Our story</h1>" },
      ],
    });
    const host = "bakery.sites.forgenexxus.com";

    const home = await t.fetch("/", { headers: { host } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<h1>Bakery</h1>");

    // The catch-all: the address a visitor typed, on the site's own host.
    const about = await t.fetch("/about", { headers: { host } });
    expect(about.status).toBe(200);
    expect(await about.text()).toContain("<h1>Our story</h1>");

    expect((await t.fetch("/nowhere", { headers: { host } })).status).toBe(404);
    // A host nobody has pointed here gets nothing, on any address.
    expect((await t.fetch("/about", { headers: { host: "stranger.example.com" } })).status).toBe(404);
  });

  test("the router in front of the sites domain can ask for a page by path", async () => {
    const t = fresh();
    await publishedSite(t, "bakery", {
      shell: SHELL,
      pages: [
        { path: "/", title: "Bakery", body: "<h1>Bakery</h1>" },
        { path: "/about", title: "About", body: "<h1>Our story</h1>" },
      ],
    });
    const host = "bakery.sites.forgenexxus.com";

    const about = await t.fetch(`/site-by-host?host=${host}&path=%2Fabout`);
    expect(about.status).toBe(200);
    expect(await about.text()).toContain("<h1>Our story</h1>");

    // A router that has not been updated sends no path, and still gets the
    // home page rather than a 404.
    const home = await t.fetch(`/site-by-host?host=${host}`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<h1>Bakery</h1>");

    expect((await t.fetch(`/site-by-host?host=${host}&path=%2Fnowhere`)).status).toBe(404);
  });

  test("a site published before pages existed serves exactly what it served", async () => {
    const t = fresh();
    const PAGE = '<!doctype html><html lang="en"><head><title>Shop</title></head><body><h1>Shop</h1></body></html>';
    const { siteId, as } = await publishedSite(t, "shop", { html: PAGE });

    expect(await (await t.fetch("/sites/shop")).text()).toBe(PAGE);
    expect(await (await t.fetch("/", { headers: { host: "shop.sites.forgenexxus.com" } })).text()).toBe(PAGE);
    // It has one page, so every other address on it is still nothing.
    expect((await t.fetch("/sites/shop/about")).status).toBe(404);
    expect((await t.fetch("/about", { headers: { host: "shop.sites.forgenexxus.com" } })).status).toBe(404);
    // And the preview shows the same document it always did.
    expect((await as.query(api.sites.currentHtml, { siteId }))?.html).toBe(PAGE);
  });

  test("the preview shows the home page of a site that has several", async () => {
    const t = fresh();
    const { siteId, as } = await publishedSite(t, "bakery", {
      shell: SHELL,
      pages: [
        { path: "/", title: "Bakery", body: "<h1>Bakery</h1>" },
        { path: "/about", title: "About", body: "<h1>Our story</h1>" },
      ],
    });
    const preview = await as.query(api.sites.currentHtml, { siteId });
    expect(preview?.html).toContain("<h1>Bakery</h1>");
    expect(preview?.html).not.toContain("<h1>Our story</h1>");
  });
});
