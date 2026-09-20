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

## Rule 3: both surfaces, every time

**Never ship a change to one surface only.** Anything a user can see or do —
a flow, a control, a layout, a piece of copy — lands on the phone *and* on the
desktop website in the same session. "Mobile first" is not "mobile only", and
desktop is never caught up later.

`docs/` is one app, so this is a layout obligation rather than a second
codebase: the same HTML, CSS and JS serve both. What differs is width.

- `--shell` is the content column: 640px, widened at the desktop breakpoint.
  Everything that docks to it — composer, sheets, drawer, overlays — is
  positioned from that variable, never from a hardcoded width.
- The desktop layer lives in one `@media(min-width:900px)` block at the end of
  `docs/styles.css`, with the pointer affordances in `@media(hover:hover)`
  beside it. Add to those rather than starting a second design: the tokens,
  radii, type scale and components are shared, and a component that needs a
  desktop shape gets it there.
- Check a change at a phone width *and* at a desktop width before calling it
  done. If a feature only makes sense on one, say so out loud rather than
  quietly leaving the other behind.

## Rule 4: all design work goes through the frontend-design skill

**Invoke the `frontend-design` skill before any design work. No exceptions.**

Design work is anything a user sees or reads: a screen, a sheet, a control, an
icon, a layout, spacing, colour, a chip, an empty state, an error, a line of
copy — whether it is new or being reshaped. A one-line CSS change is design
work. Renaming a button is design work. There is no change small enough to
skip the skill and no deadline that earns an exemption.

It is checked into this repository at `.claude/skills/frontend-design/SKILL.md`
so it loads in every session here with nothing to install. Use it twice: on the
way in to plan, and on the way out to critique what was built.

Forge already has a visual language — the tokens, radii, type scale and
components in `docs/styles.css` — and Rule 3 puts every change at both widths.
The skill is how that language gets extended and kept honest, not a competitor
to it:

- Reach for an existing token or component first. When something genuinely
  needs a shape the system does not have, the skill decides what that shape is
  rather than the nearest default.
- Its quality floor is the floor here: responsive to phone width, visible
  keyboard focus, reduced motion respected, harmonious colour.
- Its guidance on writing governs every string in `docs/` — active voice, an
  action named the same thing through a whole flow, an empty state that
  invites rather than apologises, an error that says what went wrong and what
  to do next.
- Run its self-critique pass before calling anything done.

Where the skill and something already here disagree, follow one and say which,
and why. Silently picking either is the only wrong answer.

## The name

The product is **Forge Nexxus**. Do not rename or rebrand it — not the title,
the sign-in hero, the sender name, the badge, the docs, or anything else.
"Forge" on its own is its short form and stays as it is.

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
