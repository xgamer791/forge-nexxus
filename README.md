# Forge Nexxus

Mobile UI rebuilt from the supplied screenshots, now backed by Convex. Conversations and messages persist per user: every visitor starts as an anonymous guest, and signing in (email magic link, Google, or Apple) carries the guest's conversations over to the account. The connections sheet, model sheet, attachment menu, and the rest of Settings are still presentation-only.

Live app: https://xgamer791.github.io/forge-nexxus/

## Hosting

Standard GitHub Pages only, using the existing `.github/workflows/pages.yml` workflow and `docs/` output. Keep all asset paths relative to support `/forge-nexxus/`. `docs/forge-data.js` is a built artifact (see below) and is committed so Pages needs no build step.

## Local preview

Run `npm run dev`, then open http://localhost:4173/forge-nexxus/ . Any static server can also serve `docs/` directly. Rebuilding the data bundle or running the tests needs `npm install` first.

## Convex

- `convex/` holds the schema, Convex Auth setup (`auth.ts`), and the conversation, message, and user functions. `npx convex dev` pushes them to the deployment named in `.env.local` (`CONVEX_DEPLOYMENT` plus `CONVEX_DEPLOY_KEY`, never committed) and regenerates `convex/_generated/`.
- Sign-in goes through `auth.signIn`, a thin wrapper around Convex Auth's own action: when the caller is a guest and the sign-in lands on a different user, the guest's conversations move to that user. This is what makes guest → account migration work for every provider.
- The browser talks to whichever deployment `<meta name="convex-url">` in `docs/index.html` names. Change that meta to point a build at production.
- `src/` is the vanilla-JS client: `data.js` owns the session lifecycle (guest sign-in, token refresh, magic-link and OAuth code exchange, sign-out) and `browser.js` wires it to the real Convex clients. `npm run build` bundles it to `docs/forge-data.js`, which `docs/app.js` reads as the `ForgeData` global.
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

Apple's client secret is a JWT that expires within six months; generate it with `node scripts/apple-client-secret.mjs --team TEAMID --key KEYID --client SERVICES_ID --p8 ./AuthKey_KEYID.p8` and set the new value before the old one lapses.

## Layout requirements

The prompt docks to the browser viewport with a 20px bottom gap. Bottom sheets meet the viewport edge and the navigation drawer spans its height. These must remain independent of the app container height. iOS safe-area top padding and native system fonts are retained; the operating-system status bar and Dynamic Island are not drawn by the app. The conversation thread scrolls in the space between the top bar and the prompt and replaces the greeting once a conversation has messages. The account sheet opens from the drawer footer.

## Review

`?reference` provides a 430 × 932 logical reference frame. `&screen=connections`, `models`, `attachments`, `account`, `navigation`, `settings`, or `appearance` exposes each menu for comparison. `&theme=light` or `&theme=dark` sets the Appearance theme. Test normal production layout separately: with a 932px viewport and a deliberately shortened 873px container, the prompt bottom must remain912px and bottom sheets must end at932px. Native iOS browser behavior still requires device verification.
