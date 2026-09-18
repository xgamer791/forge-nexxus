# Forge Nexxus

A mobile website builder backed by Convex. A member describes the site they want in the composer, Forge builds it as one self-contained page, and each follow-up prompt edits it. The build thread is where that conversation lives, the drawer lists their sites, and a site can be previewed and published to a public address. Everything runs on monthly credits: each plan grants an allowance per period, top-ups add more, and nothing rolls over. Users never see AI spend — only their credits — because the model is called server-side with the deployment's own key.

Live app: https://xgamer791.github.io/forge-nexxus/

`CLAUDE.md` holds the standing rules for working on this repository, the first being that all user data lives in Convex.

## Hosting

Standard GitHub Pages only, using the existing `.github/workflows/pages.yml` workflow and `docs/` output. Keep all asset paths relative to support `/forge-nexxus/`. `docs/forge-data.js` is a built artifact (see below) and is committed so Pages needs no build step.

## Local preview

Run `npm run dev`, then open http://localhost:4173/forge-nexxus/ . Any static server can also serve `docs/` directly. Rebuilding the data bundle or running the tests needs `npm install` first.

## What is in the app

- **Sign-in gate** (`docs/auth.js`): guests never reach the app. Building needs an account so credits belong to someone; a magic link, Google or Apple all create one.
- **Drawer**: New site, the account's sites (most recently edited first, with rename and delete), a credits card showing the plan, what is left of this period and when it resets, and the account footer.
- **Settings**: Profile (name, linked sign-in methods, sign out, delete account), Appearance, Plan & credits (current plan and meter, plan cards, top-up packs, downgrade at period end), Usage (the credit ledger), and Domains (custom hostnames pointed at a site, gated by plan).
- **Composer**: the first prompt creates a site named after it and builds the first version; later prompts edit it. The reply appears in the thread as "Building your site…" until the build lands, and as a failure (with the reason) if it does not. A guest who somehow reaches it is sent to sign in.
- **Site bar and preview**: the bar above the composer names the active site and its state; Preview opens the latest build in a sandboxed frame (no scripts, no access to the app's origin) with Publish, Unpublish and the public address.

## Convex

- `convex/` holds the schema, Convex Auth setup (`auth.ts`), and the site, conversation, message, domain, billing, user, and settings functions. `npx convex dev` pushes them to the deployment named in `.env.local` (`CONVEX_DEPLOYMENT` plus `CONVEX_DEPLOY_KEY`, never committed) and regenerates `convex/_generated/`.
- `sites` is what a user builds. Each site owns a conversation (its build thread); `sites.create` makes both, `sites.remove` deletes the thread, its messages and the site's domains, and `messages.send` bumps the site's `updatedAt` so the drawer orders by last edit. Only members create sites, and a plan caps how many an account holds.
- `domains` are hostnames pointed at a site. `domains.add` normalises a pasted URL to its host, refuses duplicates, and needs a plan with `customDomains`. A domain is `pending` until publishing verifies its DNS.
- `subscriptions` is one row per member: the plan, the period, `credits` left this period, `reserved` by requests still running, and `granted` (the period's allowance plus its top-ups, which is the meter's full mark). Periods are one calendar month; when one ends the leftover expires, a scheduled downgrade lands, and the new allowance is granted. `creditLedger` records every movement and `creditHolds` tracks in-flight requests.
- `generate.run` is the build. It records the prompt and a pending reply, holds the credits for the request (`generate` for a first build, `edit` after), sends the system prompt, the current page and the recent thread to any OpenAI-compatible chat completions endpoint, and stores the returned page as a `siteVersions` row before settling the hold. A failed call marks the reply `failed` with a scrubbed reason and releases the hold, so a build that produced nothing costs nothing. The endpoint, key and model come from `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL`; until they are set the build is refused with "Site generation isn't set up on this deployment yet".
- Publishing: `sites.publish` assigns a slug from the name once (kept through unpublishing, so links keep working) and pins the current version; `convex/http.ts` serves it at `<deployment>.convex.site/sites/<slug>` with a content-security-policy that allows markup, inline styles and Google Fonts only. `sites.currentHtml` backs the preview.
- `plans.ts` is the catalog: the four plans, the top-up packs, and what each kind of request costs. It is product configuration rather than user data, served to the client by `billing.catalog` so nothing in `docs/` carries a price.
- Spending is reserve → run → settle. `billing.reserve` holds a request's credits in one transaction (so a burst of requests cannot overspend), `billing.settle` turns the hold into a spend for what the request actually cost (never more than the hold), and `billing.release` gives it back after a failure. These are internal mutations for the generation pipeline; a client can only read its balance.
- Payments are not wired yet. `billing.checkout` is the seam for Stripe Checkout and currently tells the user payments are not open. Until then, put an account on a plan or give it credits from the Convex dashboard with the internal mutations `billing.grantPlan` (`{ email, plan: "pro" }`) and `billing.grantTopUp` (`{ email, pack: "topup-50" }` or `{ email, credits: 25 }`).
- `settings` stores the Appearance choices per user. The device keeps a `forge-settings` copy in `localStorage` to paint before Convex answers, and a signed-in account's saved values replace it.
- Sign-in goes through `auth.signIn`, a thin wrapper around Convex Auth's own action: a guest's data moves to the account they sign in to, and a member's free subscription is created on their first sign-in.
- `users.deleteAccount` removes everything the account owns, its auth accounts and sessions, and the user row; the client then signs out and starts a fresh guest session.
- Deploying is a separate step from the Pages deploy: pushing to `main` publishes `docs/`, but new tables and functions only exist once someone with the deploy key runs `npx convex deploy`. A client calling a function the deployment does not have yet fails with `Could not find public function for '<module>:<name>'`. The `connections`, `workspaces` and `apps` tables from the previous direction are gone from the schema; if the deployment still holds rows in them, clear those tables in the dashboard before the push.
- The browser talks to whichever deployment `<meta name="convex-url">` in `docs/index.html` names. Change that meta to point a build at production.
- `src/` is the vanilla-JS client: `data.js` owns the session lifecycle (guest sign-in, token refresh, magic-link and OAuth code exchange, sign-out) and exposes `sites`, `messages`, `domains`, `billing`, `settings` and `account`; `browser.js` wires it to the real Convex clients. `npm run build` bundles it to `docs/forge-data.js`, which `docs/app.js` reads as the `ForgeData` global.
- `npm test` runs the Convex functions in-memory with convex-test plus the session lifecycle tests; `npm run typecheck` checks `convex/`. `node scripts/smoke-convex.mjs <deployment url>` exercises a live deployment end to end over HTTP.

### Deployment environment variables

Set with `npx convex env set NAME value` against the target deployment.

| Variable | Purpose |
|---|---|
| `SITE_URL` | Where sign-in links and OAuth callbacks return to, e.g. `https://xgamer791.github.io/forge-nexxus` |
| `JWT_PRIVATE_KEY`, `JWKS` | Session token signing keys (RS256 pair) |
| `AUTH_RESEND_KEY` | Resend API key for magic-link email; `AUTH_EMAIL_FROM` overrides the sender once a domain is verified |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google OAuth client. Authorized redirect URI: `https://<deployment>.convex.site/api/auth/callback/google` |
| `AUTH_APPLE_ID`, `AUTH_APPLE_SECRET` | Sign in with Apple Services ID and client secret. Return URL: `https://<deployment>.convex.site/api/auth/callback/apple` |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | The chat completions endpoint that builds sites: any OpenAI-compatible base URL (e.g. `https://api.openai.com/v1`, `https://api.anthropic.com/v1`, `https://api.z.ai/api/paas/v4`, an OpenRouter or Gemini compatibility URL), its key, and the model name. `AI_MAX_TOKENS` (default 10000) caps the reply. |
| `STRIPE_SECRET_KEY` | Reserved for Stripe Checkout; nothing reads it yet. `billing.checkout` is where it will be used. |

Apple's client secret is a JWT that expires within six months; generate it with `node scripts/apple-client-secret.mjs --team TEAMID --key KEYID --client SERVICES_ID --p8 ./AuthKey_KEYID.p8` and set the new value before the old one lapses.

## Layout requirements

The prompt docks to the browser viewport with a 20px bottom gap. Bottom sheets meet the viewport edge and the navigation drawer spans its height. These must remain independent of the app container height. iOS safe-area top padding and native system fonts are retained; the operating-system status bar and Dynamic Island are not drawn by the app. The build thread scrolls in the space between the top bar and the prompt and replaces the greeting once a site has messages. The account sheet opens from the drawer footer.

## Review

`?reference` provides a 430 × 932 logical reference frame. `&screen=attachments`, `account`, `navigation`, `settings`, `appearance`, `profile`, `plan`, `usage`, `domains`, or `preview` exposes each menu for comparison. `&theme=light` or `&theme=dark` sets the Appearance theme. Test normal production layout separately: with a 932px viewport and a deliberately shortened 873px container, the prompt bottom must remain 912px and bottom sheets must end at 932px. Native iOS browser behavior still requires device verification.
