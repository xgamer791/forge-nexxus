import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
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
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com; font-src https://fonts.gstatic.com https://cdn.fontshare.com; img-src data: https:; base-uri 'none'; form-action 'none'",
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
  const host = request.headers.get("host") ?? new URL(request.url).host;
  return page(await ctx.runQuery(internal.sites.publishedHtmlForHost, { host }));
});
http.route({ path: "/", method: "GET", handler: byHost });
http.route({ path: "/index.html", method: "GET", handler: byHost });

// Published sites are served from the deployment's own origin at /sites/<slug>.
// The page is the model's single file; the policy keeps it to markup, styles
// and fonts, so a stray script in a build can never run on this origin.
http.route({
  pathPrefix: "/sites/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const slug = new URL(request.url).pathname.slice("/sites/".length).split("/")[0];
    return page(slug ? await ctx.runQuery(internal.sites.publishedHtml, { slug }) : null);
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
    const host = new URL(request.url).searchParams.get("host") ?? "";
    return page(host ? await ctx.runQuery(internal.sites.publishedHtmlForHost, { host }) : null);
  }),
});

export default http;
