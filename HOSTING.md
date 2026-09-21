# Where published sites are served

A member's site is served by the Convex deployment, not by GitHub Pages and
not by the WordPress host. `convex/http.ts` answers in two ways:

- **By path**, at `https://<deployment>.convex.site/sites/<slug>`. This works
  on any deployment with no DNS at all.
- **By host**, for `<slug>.<SITES_DOMAIN>` and for a member's own custom
  domain. This needs DNS *and* Convex.

`SITES_DOMAIN` chooses between them. Unset, sites are served by path. Set, a
site's address becomes `https://<slug>.<SITES_DOMAIN>` and that is the link
the app hands out, the thread announces, and Preview opens.

**Set `SITES_DOMAIN` only when the domain already answers.** It is the last
step of setting a domain up, not the first.

## What went wrong before

`sitesDomain()` used to default to `sites.forgenexxus.com` whether or not
anyone had configured it. Nothing at GoDaddy pointed that name anywhere and
Convex had never been asked to hold a certificate for it, so every member got
a link to `https://<slug>.sites.forgenexxus.com` and every one of them failed
with `ERR_NAME_NOT_RESOLVED`. The name had no records of any kind — not a
Convex 404 and not a certificate error, but a name that did not exist.

The default is gone. A deployment that has not been told about a domain now
serves working links from its own origin.

## Turning on `sites.forgenexxus.com`

Three things must be true, in this order. Skipping any of them leaves members
with dead links, which is the failure above.

### 1. Convex Pro, and the domain registered on the deployment

Custom domains are a [Convex Pro
feature](https://docs.convex.dev/production/custom-domains). In the Convex
dashboard, open the `polished-ram-883` deployment → Settings → URL & Deploy
Key → Custom Domains, and add the domain for **HTTP Actions** (not for the
Convex API).

This step is not optional and DNS cannot substitute for it. Convex terminates
TLS, and it will only present a certificate for a hostname it has been told
to hold. A name pointed at Convex that Convex does not know about fails the
handshake before any request is routed.

### 2. The DNS records, at GoDaddy

`forgenexxus.com` is on GoDaddy nameservers (`ns65.domaincontrol.com`,
`ns66.domaincontrol.com`). Convex shows the records to create when you add the
domain — **use exactly what the dashboard shows**, including any validation
record. It is the authoritative source and it is what the certificate check
reads.

Expect something of this shape, in GoDaddy's DNS manager under
`forgenexxus.com` → DNS → Records:

| Type | Name | Value | TTL |
|---|---|---|---|
| CNAME | `*.sites` | `polished-ram-883.convex.site` | 600 |

plus whatever validation record Convex asks for, entered the same way (its
**Name** is relative to `forgenexxus.com`, so drop the `.forgenexxus.com`
suffix from what the dashboard prints).

Leave the existing `forgenexxus.com` A record (`138.197.83.241`, Cloudways)
alone. It serves the marketing site and nothing here touches it.

**Open question before you start.** Convex's documentation does not say
whether a *wildcard* custom domain is supported. If it is not, then
`*.sites.forgenexxus.com` will never hold a certificate, and per-site
subdomains need one of:

- each `<slug>.sites.forgenexxus.com` registered as its own custom domain when
  a site publishes, through the [management
  API](https://docs.convex.dev/management-api/create-custom-domain); or
- a proxy in front — a Cloudflare Worker on `*.sites.forgenexxus.com` that
  forwards to `https://polished-ram-883.convex.site/sites/<slug>`, which also
  gives you the wildcard certificate.

Ask support@convex.dev before committing to the wildcard. Until that is
answered, leave `SITES_DOMAIN` unset and sites keep working by path.

### 3. `SITES_DOMAIN` on the deployment

Once the domain resolves and serves, and not before:

```
npx convex env set SITES_DOMAIN sites.forgenexxus.com
```

To go back to path-based addresses, remove it:

```
npx convex env remove SITES_DOMAIN
```

## Checking it

```
node scripts/check-sites-hosting.mjs
node scripts/check-sites-hosting.mjs --domain sites.forgenexxus.com --slug pure-x-aminos
```

It resolves each name against public DNS (8.8.8.8 and 1.1.1.1, not this
machine's resolver) and then asks for a page over HTTPS, so it separates the
three failures: a name that does not resolve, a certificate Convex was never
told to mint, and a deployment that is not serving. Run it before setting
`SITES_DOMAIN`, and again after.

## What flipping it does to sites already published

Nothing needs migrating. A site's slug is stored; only the address built from
it changes, and the app reads that address from the server everywhere it shows
one. Sites published while `SITES_DOMAIN` was unset keep their slug and move
to `https://<slug>.sites.forgenexxus.com` as soon as it is set.

The old `/sites/<slug>` path keeps working either way, so a link someone saved
earlier does not break.

## A member's own custom domain

`convex/domains.ts` hands the member one record to create, pointing their
hostname at the site's address — `<slug>.sites.forgenexxus.com` where there is
a sites domain, and `polished-ram-883.convex.site` where there is not.

The same rule from step 1 applies: **every custom domain must also be
registered on the deployment in the Convex dashboard**, or it will not get a
certificate. `domains.verify` only checks DNS; it cannot see whether Convex
holds the domain, so a domain can verify and still fail to load until it is
registered.
