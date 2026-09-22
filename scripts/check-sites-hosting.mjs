// Says whether published sites can actually be reached, and what is missing
// when they cannot:
//   node scripts/check-sites-hosting.mjs
//   node scripts/check-sites-hosting.mjs --domain sites.forgenexxus.com --slug my-site
//
// Reads DNS the way a visitor's browser would and then asks for a page over
// HTTPS, so it fails where the real thing fails: a name that does not resolve,
// a certificate that was never issued for the name, or a server that is not
// serving. Nothing here touches the deployment's data.
import { Resolver } from "node:dns/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const deployment = flag("deployment", "polished-ram-883");
const domain = flag("domain", process.env.SITES_DOMAIN ?? "");
const slug = flag("slug", "example-site");
const deploymentHost = `${deployment}.convex.site`;

// Public resolvers, not this machine's: a stale or split-horizon local resolver
// is exactly the thing that makes a broken domain look fine from one desk.
const resolver = new Resolver();
resolver.setServers(["8.8.8.8", "1.1.1.1"]);

const lines = [];
let failed = false;
function say(ok, label, detail) {
  if (!ok) failed = true;
  lines.push(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// Resolves a name the way a browser does: a CNAME chain is fine as long as
// something at the end of it has an address.
async function resolves(host) {
  try {
    const addresses = await resolver.resolve4(host);
    if (addresses.length) return { ok: true, detail: `A ${addresses[0]}` };
  } catch { /* Fall through to the CNAME below. */ }
  try {
    const [target] = await resolver.resolveCname(host);
    if (target) return { ok: true, detail: `CNAME ${target}` };
  } catch { /* Nothing answers for this name. */ }
  return { ok: false, detail: "no A, AAAA or CNAME record (NXDOMAIN)" };
}

// A member host has to be answered by the sites router, which says so in a
// header of its own. WordPress answering instead shows as a redirect to the
// apex, or as a page without that header -- both look like success by status
// alone.
async function serves(url, { viaRouter = false } = {}) {
  try {
    const response = await fetch(url, { redirect: "manual" });
    if (viaRouter && response.status >= 300 && response.status < 400) {
      const to = response.headers.get("location") ?? "nowhere";
      return { ok: false, detail: `HTTP ${response.status} to ${to}: WordPress answered, not the sites router` };
    }
    if (viaRouter && !response.headers.get("x-forge-sites-router")) {
      return { ok: false, detail: `HTTP ${response.status} without X-Forge-Sites-Router: something other than the sites router answered` };
    }
    // 404 is the deployment answering: it served our "Nothing here yet" page
    // for a slug that is not published, which is the routing working.
    return { ok: response.status < 500, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

const origin = await resolves(deploymentHost);
say(origin.ok, `${deploymentHost} resolves`, origin.detail);
if (origin.ok) {
  const served = await serves(`https://${deploymentHost}/sites/${slug}`);
  say(served.ok, `${deploymentHost}/sites/<slug> serves`, served.detail);
}

if (!domain) {
  lines.push("");
  lines.push("No sites domain given, so sites are served from the deployment's own");
  lines.push(`origin: https://${deploymentHost}/sites/<slug>. That needs no DNS.`);
  lines.push("Pass --domain sites.forgenexxus.com to check the branded domain, and");
  lines.push("see HOSTING.md before setting SITES_DOMAIN on the deployment.");
} else {
  const apex = await resolves(domain);
  say(apex.ok, `${domain} resolves`, apex.detail);
  const wildcard = await resolves(`${slug}.${domain}`);
  say(wildcard.ok, `${slug}.${domain} resolves (the wildcard)`, wildcard.detail);
  if (wildcard.ok) {
    // A name that resolves but has no certificate is the second half of this:
    // DNS done, nothing issued for the name yet.
    const served = await serves(`https://${slug}.${domain}/`, { viaRouter: true });
    say(served.ok, `https://${slug}.${domain}/ serves`, served.detail);
    // A site is built in pages, and each one is its own address on the host.
    // A page the site does not have still has to reach the router, which
    // passes on the deployment's 404.
    const inner = await serves(`https://${slug}.${domain}/about`, { viaRouter: true });
    say(inner.ok, `https://${slug}.${domain}/about reaches the router (a site's other pages)`, inner.detail);
  }
  if (!wildcard.ok) {
    lines.push("");
    lines.push("The wildcard does not resolve, so every published site link is dead.");
    lines.push("Do not set SITES_DOMAIN until it does. HOSTING.md has the records.");
  }
}

console.log(lines.join("\n"));
process.exit(failed ? 1 : 0);
