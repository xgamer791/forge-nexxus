// Where a published site answers. Every site gets a branded address under the
// deployment's own apex -- `<slug>.sites.forgenexxus.com` -- whatever plan its
// owner is on, and a member on a plan with `customDomains` can point a hostname
// they own at one as well.
//
// These are pure helpers over the deployment's environment, so that `sites.ts`
// and `domains.ts` can both reason about a hostname without importing each
// other. Nothing here reads the database.

// Labels of letters, digits and inner hyphens, then a real top-level domain.
export const HOSTNAME = /^(?=.{1,253}$)((?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

// Hostnames that are never a member's to point anywhere, whatever the apex is.
const RESERVED_SUFFIXES = ["convex.site", "convex.cloud"];

// What a user pastes is often a URL; keep just the host they meant. Also what a
// request's `Host` header is reduced to before anything is looked up, since a
// browser may send a port and a resolver may send a trailing dot.
export function normalizeHostname(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

// The apex that branded addresses sit under, e.g. `sites.forgenexxus.com`.
// Null until the deployment names one in `SITES_DOMAIN`, which is what keeps a
// deployment whose DNS is not set up yet serving sites at the path address
// instead of handing out links to a host that does not resolve.
export function sitesDomain() {
  const apex = normalizeHostname(process.env.SITES_DOMAIN ?? "");
  return HOSTNAME.test(apex) ? apex : null;
}

// The deployment's own HTTP host: what a custom domain's DNS record points at.
export function deploymentHost() {
  const origin = process.env.CONVEX_SITE_URL;
  if (!origin) return null;
  try {
    return new URL(origin).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

// A site's branded address, or null when the deployment has no apex yet.
export function brandedHostFor(slug: string) {
  const apex = sitesDomain();
  return apex ? `${slug}.${apex}` : null;
}

// The slug a branded address names, or null when `host` is not one of ours.
// Only a single label counts: `a.b.<apex>` is nobody's address.
export function slugFromHost(host: string) {
  const apex = sitesDomain();
  if (!apex) return null;
  const suffix = `.${apex}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return label && !label.includes(".") ? label : null;
}

// Hostnames a member may not claim as their own: the branded apex and anything
// under it, because those are Forge's addresses to hand out, and the
// deployment's own host, because pointing a name at it is what a custom domain
// already does.
export function isReservedHost(host: string) {
  const under = (root: string) => host === root || host.endsWith(`.${root}`);
  const apex = sitesDomain();
  if (apex && under(apex)) return true;
  const deployment = deploymentHost();
  if (deployment && under(deployment)) return true;
  return RESERVED_SUFFIXES.some(under);
}
