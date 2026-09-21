# Sites router — what to put on Cloudways

This serves member websites at `https://<slug>.sites.forgenexxus.com` from the
Cloudways server at `138.197.83.241`, application `ghxskkxdmf`. A published
page still lives only in Convex; this is the doorway a branded hostname can
knock on, so Convex Pro is not needed for custom domains.

The main site is not touched. Every rule here is guarded by the hostname, and
`forgenexxus.com` and `www.forgenexxus.com` never match it.

```
visitor  →  <slug>.sites.forgenexxus.com     (GoDaddy: *.sites → 138.197.83.241)
         →  Cloudways nginx → Apache → public_html/.htaccess
         →  forge-sites-router.php           (extracts <slug>)
         →  polished-ram-883.convex.site/sites/<slug>
         →  the page, passed back unchanged
```

## Files

| In this repo | On the server |
|---|---|
| `forge-sites-router.php` | `/home/master/applications/ghxskkxdmf/public_html/forge-sites-router.php` |
| `htaccess-snippet.txt` | pasted into `/home/master/applications/ghxskkxdmf/public_html/.htaccess`, above `# BEGIN WordPress` |
| `nginx-proxy.conf` | not used by default — see the file |

## Steps

Do them in this order. The DNS can go in at any point; the rest is worth
having ready before it propagates.

### 1. Copy the router

```
scp -i cloudways_codex cloudways/sites-router/forge-sites-router.php \
  master@138.197.83.241:/home/master/applications/ghxskkxdmf/public_html/
```

Nothing in it needs editing unless the deployment name changes — the Convex
origin, the sites domain and the timeouts are the first few lines.

### 2. Add the rewrite

Back up the file first, because this is the one that can take the main site
down if it goes in wrong:

```
ssh -i cloudways_codex master@138.197.83.241
cd /home/master/applications/ghxskkxdmf/public_html
cp .htaccess .htaccess.before-forge-sites
```

Paste the contents of `htaccess-snippet.txt` **above** the `# BEGIN WordPress`
line. WordPress rewrites its own block when permalinks are saved and leaves
anything outside it alone, so the snippet survives.

Then load `https://forgenexxus.com` and the WordPress admin. If either is
unhappy, `cp .htaccess.before-forge-sites .htaccess` puts it back.

### 3. Point the hostname at the application

In the Cloudways panel: Application `ghxskkxdmf` → Domain Management → add
`*.sites.forgenexxus.com` as an additional domain. This is what makes nginx
hand those hostnames to this application instead of the default one.

If the panel refuses a wildcard, add `sites.forgenexxus.com` and ask Cloudways
support to map the wildcard to the application — it is a routine request, and
it is the one step here that cannot be done from SSH.

### 4. DNS at GoDaddy

Under `forgenexxus.com` → DNS → Records:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `*.sites` | `138.197.83.241` | 600 |
| A | `sites` | `138.197.83.241` | 600 |

The second is only needed if `sites.forgenexxus.com` itself should answer;
member sites do not use it. Leave the existing `forgenexxus.com` A record
(`138.197.83.241`) and the `www` record exactly as they are.

### 5. The certificate

A wildcard certificate cannot be issued by the HTTP challenge, so Cloudways'
one-click Let's Encrypt will not cover `*.sites.forgenexxus.com`. Two ways:

- **Cloudways SSL, wildcard option.** Application → SSL Certificate → Let's
  Encrypt → enter `*.sites.forgenexxus.com`. Cloudways prints a DNS TXT record
  for `_acme-challenge.sites.forgenexxus.com`; add it at GoDaddy and verify.
  Renewal asks again unless the panel automates it, so put a reminder at 60
  days.
- **certbot with DNS-01**, if the panel will not do it:
  ```
  certbot certonly --manual --preferred-challenges dns \
    -d '*.sites.forgenexxus.com'
  ```
  and install the result where Cloudways expects it.

Until a certificate exists, `https://` fails on these hostnames while `http://`
works. **Do not turn on Cloudways' "Force HTTPS" before the certificate is in
place** — it is application-wide and would break every member site at once.

### 6. Tell Convex

Only once a real site loads over HTTPS:

```
npx convex env set SITES_DOMAIN sites.forgenexxus.com
```

That is the switch that makes the app hand members branded links. Until it is
set, members get `https://polished-ram-883.convex.site/sites/<slug>`, which
keeps working afterwards too.

## Checking it

```
node scripts/check-sites-hosting.mjs --domain sites.forgenexxus.com --slug <a-real-slug>
```

It resolves against public DNS rather than the local resolver, then asks for
the page, so it tells apart a name that does not resolve, a missing
certificate, and a server that is not serving.

By hand, before DNS has propagated:

```
curl -H 'Host: <slug>.sites.forgenexxus.com' http://138.197.83.241/ -i
```

That goes straight at the server with the hostname the router reads, so it
tests the rewrite and the router without waiting for DNS or TLS.

## A member's own domain

Three things, per domain:

1. Add it to `FORGE_CUSTOM_DOMAINS` in `forge-sites-router.php`.
2. Add it to the hostname condition in `.htaccess`, inside the brackets.
3. Add it to the application in Cloudways Domain Management and issue a
   certificate for it.

The router then asks Convex `/site-by-host`, which looks the hostname up in
the `domains` table — so the member must also have added it in the app, and
pointed it here, before it serves anything.

## When something is wrong

- **The main site broke.** Restore `.htaccess.before-forge-sites`. The snippet
  is the only thing here that can affect `forgenexxus.com`.
- **A member site shows the WordPress home page.** The rewrite did not fire:
  either the snippet is below `# BEGIN WordPress`, or the hostname is not
  mapped to this application in Cloudways.
- **"This site isn't loading right now."** The router reached this server but
  not Convex. `error_log` in the application's PHP log has the reason.
- **"Nothing here yet."** The router worked and Convex says that slug is not
  published. Check the slug, and that the member has published.
