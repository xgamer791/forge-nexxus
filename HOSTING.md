# Where published sites are served

A member's site is built and stored by Convex. Where a visitor reaches it
depends on one deployment variable, `SITES_DOMAIN`:

| `SITES_DOMAIN` | A site's address | What has to exist |
|---|---|---|
| unset | `https://polished-ram-883.convex.site/sites/<slug>` | nothing — works on any deployment |
| `sites.forgenexxus.com` | `https://<slug>.sites.forgenexxus.com` | DNS, the Cloudways router, and a wildcard certificate |

`convex/http.ts` serves the page either way. The path route answers by slug,
and `/site-by-host` answers by hostname for a member's own domain.

**Set `SITES_DOMAIN` only when the branded domain already answers.** It is the
last step of setting one up, not the first — it is what makes the app hand
members branded links, and a link handed out before the hosting is ready is a
dead link.

## What went wrong before

`sitesDomain()` used to default to `sites.forgenexxus.com` whether or not
anyone had configured it. Nothing at GoDaddy pointed that name anywhere, so
every member got a link to `https://<slug>.sites.forgenexxus.com` and every
one of them failed with `ERR_NAME_NOT_RESOLVED`. The name had no records of
any kind — not a 404, not a certificate error, but a name that did not exist.

The default is gone. A deployment that has not been told about a domain serves
working links from its own origin.

## The branded domain, through Cloudways

`<slug>.sites.forgenexxus.com` resolves to the Cloudways server that already
runs the WordPress site (`138.197.83.241`), and a small PHP router there
fetches the page from Convex and passes it back. Convex is still the only
place a published page lives.

**[`cloudways/sites-router/README.md`](cloudways/sites-router/README.md) is the
install: the files, the exact paths on the server, and the order.** In short:

1. Copy `forge-sites-router.php` into the application's `public_html`.
2. Paste the `.htaccess` snippet above `# BEGIN WordPress`.
3. Add `*.sites.forgenexxus.com` to application `ghxskkxdmf` in Cloudways
   Domain Management.
4. GoDaddy: `*.sites` A → `138.197.83.241`.
5. Issue a wildcard certificate (DNS-01 — the HTTP challenge cannot do
   wildcards).
6. `npx convex env set SITES_DOMAIN sites.forgenexxus.com`.

The main WordPress site is not touched. Every rule is guarded by hostname and
`forgenexxus.com` never matches.

### Why not Convex custom domains

Convex can serve a custom domain itself, which would drop the proxy hop —
but it is a [Pro plan feature](https://docs.convex.dev/production/custom-domains),
and its documentation does not say whether a *wildcard* domain is supported at
all. Since every member site is its own subdomain, an unsupported wildcard
would mean registering each slug individually. The Cloudways router needs
neither, and the server is already paid for. If Convex Pro is taken later and
confirms wildcard support, pointing DNS straight at Convex and deleting the
router is a small change: nothing in the app knows which of the two is
answering.

## Checking it

```
node scripts/check-sites-hosting.mjs
node scripts/check-sites-hosting.mjs --domain sites.forgenexxus.com --slug <a-real-slug>
```

It resolves each name against public DNS (8.8.8.8 and 1.1.1.1, not this
machine's resolver) and then asks for a page over HTTPS, so it separates the
failures: a name that does not resolve, a certificate that is missing, and a
server that is not serving. Run it before setting `SITES_DOMAIN`, and again
after.

Before DNS has propagated, this reaches the router directly:

```
curl -H 'Host: <slug>.sites.forgenexxus.com' http://138.197.83.241/ -i
```

## What switching it on does to sites already published

Nothing needs migrating. A site's slug is stored; only the address built from
it changes, and every screen reads that address from the server. Sites
published while `SITES_DOMAIN` was unset keep their slug and move to
`https://<slug>.sites.forgenexxus.com` as soon as it is set.

The `/sites/<slug>` path keeps working either way, so a link someone saved
earlier does not break.

## A member's own custom domain

`convex/domains.ts` hands the member one record to create, pointing their
hostname at the site's address — `<slug>.sites.forgenexxus.com` where there is
a sites domain, and `polished-ram-883.convex.site` where there is not.

`domains.verify` only checks that DNS points here. It cannot see whether the
server will serve the domain, so a domain can verify and still not load until
the three server-side steps in the router's README are done: the hostname in
the router's list, in the `.htaccess` condition, and in Cloudways with a
certificate. Until custom domains are automated, treat each one as a manual
setup after the member's DNS is verified.
