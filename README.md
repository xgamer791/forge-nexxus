# Forge Nexxus

Mobile UI rebuilt from the supplied screenshots, now backed by Convex. Conversations and messages persist per user: every visitor starts as an anonymous guest, and signing in (email magic link, Google, or Apple) carries the guest's conversations over to the account. Connect is backed too: Recents and the Cloud and Repo pickers render the workspaces saved against the account, nothing is seeded, and Appearance preferences follow the account rather than the device. Settings → Remote Workspaces adds real SSH and SFTP servers, verifies them with a live handshake, and keeps their credentials encrypted on the deployment. The model sheet, attachment menu, and the rest of Settings are still presentation-only.

Live app: https://xgamer791.github.io/forge-nexxus/

`CLAUDE.md` holds the standing rules for working on this repository, the first being that all user data lives in Convex.

## Hosting

Standard GitHub Pages only, using the existing `.github/workflows/pages.yml` workflow and `docs/` output. Keep all asset paths relative to support `/forge-nexxus/`. `docs/forge-data.js` is a built artifact (see below) and is committed so Pages needs no build step.

## Local preview

Run `npm run dev`, then open http://localhost:4173/forge-nexxus/ . Any static server can also serve `docs/` directly. Rebuilding the data bundle or running the tests needs `npm install` first.

## Convex

- `convex/` holds the schema, Convex Auth setup (`auth.ts`), and the conversation, message, user, connection, and settings functions. `npx convex dev` pushes them to the deployment named in `.env.local` (`CONVEX_DEPLOYMENT` plus `CONVEX_DEPLOY_KEY`, never committed) and regenerates `convex/_generated/`.
- `connections` stores each user's cloud and repo workspaces (`kind`, `name`, `detail`, `connected`, `usedAt`). The Connect sheet lists them under Recents, `Connect > Cloud` and `Connect > Repo` open filtered pickers over the same rows, and one workspace per kind is Connected at a time. No rows are seeded, so every list is empty until `connections.add` is called; the sign-in flow that supplies them comes later.
- `settings` stores the Appearance choices (theme, tool-call density, the toggles, and the font selections) per user, so they survive signing out and back in. The device keeps a `forge-settings` copy in `localStorage` to paint before Convex answers, and a signed-in account's saved values replace it.
- `workspaces` stores the remote servers a user can open a shell on (`protocol`, `host`, `port`, `username`, `environment`, `connected`). `workspaces.list` strips `secret` and `userId`, so a credential never reaches a browser. `convex/remote.ts` is a Node action module (`"use node"`) holding the parts that need real Node: `remote.test` opens a throwaway handshake against details that have not been saved, `remote.create` seals the credential with AES-256-GCM before storing it, and `remote.connect` decrypts, handshakes, and only then marks the workspace connected. One workspace is connected at a time.
- Sessions are per call, not long-lived: Convex actions are stateless, so "Connected" means the stored credential opened a session just now, and each later command opens its own.
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
| `WORKSPACE_KEY` | 32 bytes of base64 that seal Remote Workspace credentials. Generate with `npx convex env set WORKSPACE_KEY "$(openssl rand -base64 32)"`. Rotating it makes every saved credential unreadable, so saved workspaces must be re-added. |

Apple's client secret is a JWT that expires within six months; generate it with `node scripts/apple-client-secret.mjs --team TEAMID --key KEYID --client SERVICES_ID --p8 ./AuthKey_KEYID.p8` and set the new value before the old one lapses.

## Layout requirements

The prompt docks to the browser viewport with a 20px bottom gap. Bottom sheets meet the viewport edge and the navigation drawer spans its height. These must remain independent of the app container height. iOS safe-area top padding and native system fonts are retained; the operating-system status bar and Dynamic Island are not drawn by the app. The conversation thread scrolls in the space between the top bar and the prompt and replaces the greeting once a conversation has messages. The account sheet opens from the drawer footer.

## Review

`?reference` provides a 430 × 932 logical reference frame. `&screen=connections`, `cloud-picker`, `repo-picker`, `models`, `attachments`, `account`, `navigation`, `settings`, or `appearance` exposes each menu for comparison. `&theme=light` or `&theme=dark` sets the Appearance theme. Test normal production layout separately: with a 932px viewport and a deliberately shortened 873px container, the prompt bottom must remain912px and bottom sheets must end at932px. Native iOS browser behavior still requires device verification.
