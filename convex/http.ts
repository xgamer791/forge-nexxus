import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { webhook } from "./stripe";

const http = httpRouter();
auth.addHttpRoutes(http);

// Stripe posts here; the handler verifies the signature before anything else.
http.route({ path: "/stripe/webhook", method: "POST", handler: webhook });

const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not published</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;background:#121315;color:#e9ebee;text-align:center}p{color:#9fa1a4}</style></head><body><main><h1>Nothing here yet</h1><p>This site isn't published, or the address has changed.</p></main></body></html>`;

// Published sites are served from the deployment's own origin at /sites/<slug>.
// The page is the model's single file; the policy keeps it to markup, styles
// and fonts, so a stray script in a build can never run on this origin.
http.route({
  pathPrefix: "/sites/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const slug = new URL(request.url).pathname.slice("/sites/".length).split("/")[0];
    const html = slug ? await ctx.runQuery(internal.sites.publishedHtml, { slug }) : null;
    if (!html) {
      return new Response(NOT_FOUND, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: https:; base-uri 'none'; form-action 'none'",
      },
    });
  }),
});

export default http;
