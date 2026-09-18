# Forge Nexxus — standing rules

Claude Code loads this file automatically at the start of every session in this
repository, so treat it as always in effect. Re-read it before changing how any
user-facing state is stored, and follow it over habit or convenience.

## Rule 1: all user data lives in the database

**Every piece of user state belongs in Convex, owned by a `userId`.** If a user
can type it, toggle it, pick it, name it, connect it, upload it, or reorder it,
it is user data and it goes in a Convex table. It must survive a reload, a new
device, and signing out and back in.

Guests count. An anonymous visitor is a real `users` row, so guest data is
stored the same way and is carried into the account they sign in to.

### Never

- **Hardcoded sample rows** in `docs/index.html` or `docs/app.js`. No fake
  sites, domains, plans, credits, conversations, or names — not "for now", not as
  a design placeholder. A list with nothing in it renders empty.
- **`localStorage` as the source of truth** for anything the user set.
- **State that only exists in a JS variable** and dies on reload.
- **Per-device state** where the user would expect it to follow the account.

### `localStorage` is only for

- Session tokens and the auth handshake (`forge-auth-*`).
- A mirror of what Convex already holds, written *from* the server value, used
  to paint before Convex answers (`forge-settings`, `forge-theme`).
- A pointer to something the database owns (`forge-conversation` holds an id).

Every read of it is wrapped in `try`/`catch` and works when it comes back empty.

### Credentials and keys

Secrets never belong to a browser and never belong to a user row:

- The AI, image and video providers are called with the deployment's own keys
  (`npx convex env set`), from server-side functions. A user never supplies a
  provider key and never sees provider spend — only their credits.
- Any secret a user does give us is sealed before storage and never returned
  to a client. Queries a browser can call strip it, editing replaces it, and
  error strings are scrubbed before they leave the server.

### Plans and credits

- The plan catalog (`convex/plans.ts`) is product configuration, not user
  data. It is served by `billing.catalog`; `docs/` never carries a price, an
  allowance, or a request cost of its own.
- A member's balance is server-authoritative. Spending is reserve → run →
  settle through the internal mutations in `convex/billing.ts`; nothing a
  client can call adds credits, and nothing spends them without a hold.
- Guests cannot build. Anything that creates a site or moves credits goes
  through `requireMemberId`, because a guest row costs nothing to make.

## Rule 2: empty means empty

A user who has added nothing sees an empty list and an empty state, never an
example. Sections with no rows hide themselves; counts hide at zero.

## Adding a new kind of user data

1. Add the table to `convex/schema.ts` with a `userId` field and a `by_user`
   index.
2. Add a module under `convex/` with its queries and mutations. Queries return
   `[]` or `null` when there is no signed-in user; mutations go through
   `requireUserId` / a `requireOwned…` helper in `convex/access.ts`.
3. Register the module in `convex/_generated/api.d.ts` by hand. `npx convex dev`
   cannot run in this environment, and `api.js` uses `anyApi`, so only the types
   need the new entry.
4. Expose it on the client in `src/data.js`, then re-export it in
   `src/browser.js`.
5. Render it in `docs/app.js` from the subscription — never from markup.
6. Carry it in `adoptGuestData()` in `convex/auth.ts` so a guest keeps it when
   they sign in.
7. Run `npm run build` to rebuild `docs/forge-data.js`. `src/` changes do not
   reach the browser without it.
8. Say in your summary that `npx convex deploy` is still required: pushing to
   `main` deploys `docs/` through GitHub Pages, but schema and function changes
   only reach the Convex deployment when someone with the deploy key pushes
   them.

## Tests

Every Convex test file loads the whole directory with
`import.meta.glob("./**/*.*s")`. No module uses `"use node"`; keep it that way
unless something genuinely needs Node, and if it ever does, exclude that file
from the glob so convex-test can still load the rest.

## Checks before pushing

- `npm run typecheck` — `convex/`
- `npm run build` — required whenever `src/` changed
- `npm test` — Convex functions and the session lifecycle
