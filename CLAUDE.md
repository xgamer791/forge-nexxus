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

## Rule 5: client version number

The number at the top-right of the prompt is the Forge Nexxus client version.
It is a plain integer, not a hash.

**Read `VERSION.md` before you finish any change.** Every change triggers a
bump — there is no skip for prompt-only or backend-only work. Increment the
number there, paint it on both surfaces, say `Latest version: N` at the end of
every completed task, and push to `main`. That file is the source of truth.

## Rule 6: do not test your work unless you are asked to

**No test run is part of finishing.** Do not run `npm test`, do not run
`npm run typecheck`, and do not write a test to satisfy yourself that a change
works. Ship it. The member asks for a test run when they want one, and only
then is it part of the job.

This is a deliberate reversal of the habit, and it wins over anything else in
this file or in a skill that asks for verification first:

- A change is finished when it is written, the version is bumped, and it is
  deployed. Nothing waits on a green suite.
- When a change alters behaviour a test already asserts, update that test in
  the same commit — writing the new truth down is not a test run.
- `npm run build` is not a test. It is how `src/` reaches the browser, so it is
  still required whenever `src/` changed; without it the client ships stale.
- `npx convex deploy` runs TypeScript itself, so a type error stops the deploy
  and says so. That is the check, and it happens at the deploy rather than
  before it.

If something is too risky to ship unverified, say so in the summary and ask —
do not quietly run the suite instead.

## Rule 7: deploy the moment the work is done

**Every completed change is deployed in the same session, to Convex and to
GitHub, without being asked.** A change that is only committed is not shipped:
nobody sees it, and the next session inherits a deployment behind the code.

This is standing permission to push to `main` and to deploy. Do not ask for it
again.

- **Convex** — `npx convex deploy --yes --typecheck disable --codegen disable`
  with `CONVEX_DEPLOY_KEY` from the environment. It lands on
  `polished-ram-883`. A session that cannot reach `convex.cloud` ships it by
  merging to `main`, where the Actions Convex step runs the same command with
  the repository secret.
- **GitHub** — commit, then push `main`. Pages deploys `docs/` from there, and
  the same run deploys Convex again, which is a no-op when the code is already
  up. Work done on a feature branch is fast-forwarded into `main` to ship;
  push the branch too, so nothing lives only on this machine.
- **Both, every time.** Backend-only work still ships the client, because the
  version number on both surfaces moved with it (Rule 5). Frontend-only work
  still deploys Convex, because a no-op deploy costs nothing and a skipped one
  is how a deployment drifts behind `main`.
- Say what was deployed at the end of the task, and name the version.

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
8. Deploy it — Rule 7. A schema or function change reaches nobody through
   Pages, so `npx convex deploy` is the half of the release that carries it,
   and pushing `main` is the half that carries `docs/`. Say in your summary
   that both happened.

## Tests

The suite exists and is kept truthful, but running it is not part of finishing
a change — Rule 6. Run `npm test` when the member asks for it, and when a
change makes an existing assertion wrong, correct that assertion in the same
commit rather than leaving it to fail for whoever comes next.

Every Convex test file loads the whole directory with
`import.meta.glob("./**/*.*s")`. No module uses `"use node"`; keep it that way
unless something genuinely needs Node, and if it ever does, exclude that file
from the glob so convex-test can still load the rest.

## Before pushing

- `npm run build` — required whenever `src/` changed, because that is what puts
  `src/` in front of the browser. Not a check; part of the change.
- The version bumped and painted on both surfaces — Rule 5.
- Then deploy Convex and push `main` — Rule 7.

`npm run typecheck` and `npm test` are run on request only. The deploy
typechecks `convex/` on its way out, so a type error still stops it.

## Standing access: Convex + DeepSeek + Gemini (every Claude session)

Secrets live in gitignored `.env.local` on the Windows GOAT checkout and in GitHub Actions secrets. **Never paste keys into chat.**

- **Convex deploy:** `CONVEX_DEPLOY_KEY` + `CONVEX_DEPLOYMENT=dev:polished-ram-883` in `.env.local`. Also `CONVEX_DEPLOY_KEY` GitHub Actions secret — pushing to `main` runs Convex deploy in CI.
- **Chat/build:** DeepSeek v4.1 Flash. Convex `AI_MODEL=deepseek-flash`, `AI_BASE_URL=https://api.deepseek.com/v1`, `AI_API_KEY` set. `AI_MODEL_LABEL` is unset so the fallback pretty name is used. Hardcoded fallbacks in `convex/generate.ts` match that route. DeepSeek requests never send Gemini's `reasoning_effort` field. If someone points `AI_BASE_URL` / `AI_MODEL` at Gemini (`generativelanguage.googleapis.com`), high effort is still sent (`AI_REASONING_EFFORT` accepts `low` / `medium` / `high`; unset lands on `high`).
- **Images:** Gemini Nano Banana 2 Lite. `GEMINI_API_KEY` (same value as Convex `AI_IMAGE_API_KEY`) in `.env.local` and GitHub secret `GEMINI_API_KEY`. `AI_IMAGE_MODEL=gemini-3.1-flash-lite-image`. Pictures stay on this native image route; they never go through the chat model.
- **Verify without secrets:** `npx convex run generate:routing` on polished-ram-883. It returns three rows: `chat` and `build` both on `deepseek-flash` at host `api.deepseek.com` with `reasoningEffort: null` (with `build.sameAsChat: true` while `AI_BUILD_MODEL` is unset), and `image` on `gemini-3.1-flash-lite-image` with `pinnedToLite: false`. There is no `misrouted` or `refuseReason` field any more — the route guard was removed, so nothing is judged before it is tried. A session that cannot reach the deployment can run `npx vitest run convex/routing.test.ts convex/buildFlow.test.ts` instead, which drives the same settings through the real build pipeline.
- **When the route looks right and builds still fail:** `npx convex run probe:chat` makes one small call to the configured chat route and reports what came back — HTTP status, which fields the reply carried, how many characters went to `content` and how many to a reasoning field, `finish_reason`, and the provider's own error. It describes the key (length, stray whitespace from a paste, masked ends) but never returns it, and scrubs the key out of anything the provider echoes. `generate:routing` says where a turn is sent; this says what answers. `deepseek-flash` is a reasoning model: its thinking lands in `reasoning_content` and is billed inside `completion_tokens`, which is what `max_tokens` caps — a real build measured 15,592 reasoning + 11,344 content tokens. A build now carries a ceiling of 96000 and a conversation 32000 in `convex/generate.ts`, so no environment variable is needed for a build to have room to think and still write a site in pages. `AI_MAX_TOKENS` still overrides both where it is set, so a value below what a site needs is a build that fails: `npx convex run generate:routing` now reports the ceiling each route actually uses, and clearing the variable is what hands a deployment back the defaults. It is **not** set on polished-ram-883 — routing there reports 96000 for a build and 32000 for chat, which are the defaults — so an earlier note here saying it had been set to 393216 was wrong, and a build was running inside the old 24000 until this was fixed. Read the ceiling from `routing` rather than from this file. Empty `content` beside a large `reasoningChars` means the budget went on thinking; the same request buys the same answer, so Forge asks again inside a wider ceiling — never above a cap the provider itself named — and tells the model to keep its planning short.
- **Cloud Claude:** if this session cannot reach `convex.cloud`, ship Convex by merging to `main` and watching the Actions Convex step (needs `CONVEX_DEPLOY_KEY` secret, already set). Do not ask the user to paste keys.

