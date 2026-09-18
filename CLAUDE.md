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
  workspaces, servers, repos, conversations, or names — not "for now", not as
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

### Credentials

Secrets a user gives us (SSH keys, passphrases, passwords) are sealed before
storage and never returned to a client:

- They are encrypted in `convex/remote.ts` with the deployment's `WORKSPACE_KEY`
  and stored only as ciphertext.
- Any query a browser can call strips the secret. `workspaces.list` is the
  pattern: it drops `secret` and `userId` before returning a row.
- Editing a credential replaces it. Nothing reads one back out to prefill a form.
- Error strings are scrubbed before they leave the server, so a key or password
  never rides out in a failure message.

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

## Node actions

`convex/remote.ts` starts with `"use node"` because it needs `node:crypto` and
`ssh2`. convex-test cannot load it, so every Convex test file excludes it:
`import.meta.glob(["./**/*.*s", "!./remote.ts"])`. Keep pure logic out of that
module so it stays testable.

## Checks before pushing

- `npm run typecheck` — `convex/`
- `npm run build` — required whenever `src/` changed
- `npm test` — Convex functions and the session lifecycle
