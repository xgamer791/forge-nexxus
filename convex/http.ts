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

// The page is the model's single file, so the policy keeps it to markup, styles
// and fonts: a stray script in a build can never run on an origin of ours.
function page(html: string) {
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
}

function notFound() {
  return new Response(NOT_FOUND, {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// A published site answers on its own hostname: the branded
// `<slug>.sites.forgenexxus.com` address every plan gets, or a hostname a member
// on a plan with custom domains has pointed here. A build is one page, so it
// answers at the root and nowhere else; everything else on the hostname gets the
// same "nothing here" page rather than the router's bare text, which is what a
// visitor to someone's own domain should see.
const serveHost = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  if (url.pathname !== "/") return notFound();
  const hosted = await ctx.runQuery(internal.sites.hostedHtml, { host });
  if (!hosted) return notFound();
  // Being asked for the name at all means its DNS now points here.
  if (hosted.domainId !== null) {
    await ctx.runMutation(internal.domains.markVerified, { id: hosted.domainId });
  }
  return page(hosted.html);
});

http.route({ path: "/", method: "GET", handler: serveHost });
// Every other route registers a longer prefix or an exact path, both of which
// win in the router, so this only picks up what would otherwise be a bare 404.
http.route({ pathPrefix: "/", method: "GET", handler: serveHost });

// The address a site had before the deployment had an apex to brand, kept
// working so that a link given out earlier never dies.
http.route({
  pathPrefix: "/sites/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const slug = new URL(request.url).pathname.slice("/sites/".length).split("/")[0];
    const html = slug ? await ctx.runQuery(internal.sites.publishedHtml, { slug }) : null;
    return html ? page(html) : notFound();
  }),
});

export default http;
