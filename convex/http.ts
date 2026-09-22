import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { rewriteRootLinks } from "./pages";
import { webhook } from "./stripe";

const http = httpRouter();
auth.addHttpRoutes(http);

// Stripe posts here; the handler verifies the signature before anything else.
http.route({ path: "/stripe/webhook", method: "POST", handler: webhook });

// Two servers show this same page for the same reason -- this deployment, and
// the router in front of the sites domain -- so the copy here and the copy in
// `cloudways/sites-router/forge-sites-router.php` are kept identical. The
// gutter is what keeps the line off the edge of a narrow phone.
const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not published</title><style>body{margin:0;min-height:100vh;box-sizing:border-box;padding:24px 16px;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;background:#121315;color:#e9ebee;text-align:center}p{color:#9fa1a4}</style></head><body><main><h1>Nothing here yet</h1><p>This site isn't published, or the address has changed.</p></main></body></html>`;

// Every build publishes itself, and Preview opens this address, so a page a
// browser kept from a minute ago would show a member the site they just
// changed as though they had not. The page is always asked for again.
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // Rebuild publishes a new page to the same URL. public/max-age=0 still lets
  // Cloudways Varnish keep a HIT for hours; no-store is what stops that.
  "cache-control": "private, no-store, max-age=0, must-revalidate",
  "surrogate-control": "no-store",
  // This only stops a browser from reading the page as some other kind of
  // file. It limits nothing the page does.
  "x-content-type-options": "nosniff",
  // No content-security-policy, by the owner's decision: a published page runs
  // its scripts, loads from any host and submits its forms, as a page on any
  // ordinary host does.
} as const;

function page(html: string | null) {
  if (!html) {
    return new Response(NOT_FOUND, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(html, { status: 200, headers: PAGE_HEADERS });
}

// A site's own address — `<slug>.sites.forgenexxus.com` — and any custom domain
// pointed at it land on the root of this deployment with their own Host. The
// host is what says which site the visitor asked for.
const byHost = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  // A doorway in front of this deployment -- the sites router on the hosting,
  // a CDN, anything that terminates TLS for a branded hostname -- cannot pass
  // the visitor's Host upstream without breaking TLS to this deployment, so it
  // sends its own and says who was actually asked in `x-forwarded-host`. That
  // is read first, because when it is there it is the address the visitor
  // typed; `host` is right when someone arrives here directly. Forwarded or
  // not, the host only ever finds a published page: a name nobody has pointed
  // here gets the same nothing an unknown slug does, so trusting the header
  // gives away no more than the address already does.
  const forwarded = (request.headers.get("x-forwarded-host") ?? "").split(",")[0].trim();
  const host = forwarded || request.headers.get("host") || url.host;
  return page(
    await ctx.runQuery(internal.sites.publishedHtmlForHost, { host, path: url.pathname }),
  );
});
http.route({ path: "/", method: "GET", handler: byHost });
http.route({ path: "/index.html", method: "GET", handler: byHost });
// Every other address on a site's own host: `/about`, and anything else the
// site has a page for. A prefix of `/` is the shortest one there is, and the
// router tries exact paths first and then prefixes longest-first, so this is
// reached only for an address nothing above it claimed -- never `/stripe/webhook`,
// never `/sites/…`, never an auth route. A path this site has no page at gets
// the same 404 an unpublished site gets.
http.route({ pathPrefix: "/", method: "GET", handler: byHost });

// Published sites are served from the deployment's own origin at
// /sites/<slug>, and their other pages at /sites/<slug>/<path>.
http.route({
  pathPrefix: "/sites/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const rest = new URL(request.url).pathname.slice("/sites/".length);
    const cut = rest.indexOf("/");
    const slug = cut === -1 ? rest : rest.slice(0, cut);
    const path = cut === -1 ? "/" : rest.slice(cut);
    const html = slug ? await ctx.runQuery(internal.sites.publishedHtml, { slug, path }) : null;
    // A page links to its other pages by path, which is right on the site's own
    // host. A browser reading the site here instead, under /sites/<slug>, would
    // follow `/about` to this deployment's root and find nothing, so the links
    // are pointed under the slug for it. The sites router fetches from here too,
    // to serve the branded host, and names itself so its copy is left alone: a
    // link rewritten for it would break on the very host it is for.
    const proxied = (request.headers.get("user-agent") ?? "").startsWith("ForgeNexxus-SitesRouter");
    return page(html !== null && !proxied ? rewriteRootLinks(html, (to) => `/sites/${slug}${to === "/" ? "/" : to}`) : html);
  }),
});

// What the router in front of the sites domain asks, for a host it cannot
// answer from the slug alone -- a member's own domain. It is the same answer
// `/` gives to a visitor who arrives here directly, and it exists because a
// proxy cannot pass the visitor's Host header upstream without breaking TLS
// to this deployment. Naming a host reveals nothing: these pages are public,
// and a host nobody has pointed here gets the same 404 as an unknown slug.
http.route({
  path: "/site-by-host",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const params = new URL(request.url).searchParams;
    const host = params.get("host") ?? "";
    // The address the visitor asked that router for. A router that has not
    // been updated to send one is asking about the home page, which is the
    // only page it knew sites to have.
    const path = params.get("path") ?? "/";
    return page(
      host ? await ctx.runQuery(internal.sites.publishedHtmlForHost, { host, path }) : null,
    );
  }),
});

export default http;
