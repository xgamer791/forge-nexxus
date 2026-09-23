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

## Standing access: Convex + DeepSeek + Gemini (every Claude session)

Secrets live in gitignored `.env.local` on the Windows GOAT checkout and in GitHub Actions secrets. **Never paste keys into chat.**

- **Convex deploy:** `CONVEX_DEPLOY_KEY` + `CONVEX_DEPLOYMENT=dev:polished-ram-883` in `.env.local`. Also `CONVEX_DEPLOY_KEY` GitHub Actions secret — pushing to `main` runs Convex deploy in CI.
- **Chat:** DeepSeek v4.1 Flash. Convex `AI_MODEL=deepseek-flash`, `AI_BASE_URL=https://api.deepseek.com/v1`, `AI_API_KEY` set. `AI_MODEL_LABEL` is unset so the fallback pretty name is used. Hardcoded fallbacks in `convex/generate.ts` match that route. **Planning and builds:** DeepSeek v4.1 Flash at `max` reasoning, on the chat route (since 2026-09-22). `AI_BUILD_MODEL`, `AI_BUILD_BASE_URL` and `AI_BUILD_API_KEY` are unset, which is what sends planning and a build to the chat route; all three must be set or cleared together, because a build key left behind is sent to whichever host the build route lands on. The earlier route was Z.ai GLM 5.3 (`AI_BUILD_MODEL=glm-5.3`, `AI_BUILD_BASE_URL=https://api.z.ai/api/paas/v4`, general API, not the Coding Plan host); its key is parked on the deployment as `ZAI_API_KEY`, which nothing reads, so switching back is setting those three again with `AI_BUILD_API_KEY` taken from it. What follows about GLM applies only when that route is set. GLM 5.3 only accepts thinking enabled, at `low`, `high` or `max`. Planning asks for `max`. Designing and writing the site asks for `high`. That split is fixed for this model; `AI_REASONING_EFFORT` does not flatten the two into one level. **Thinking:** DeepSeek documents `reasoning_effort` for V4-Pro and V4.1-Flash with three levels — `low`, `high`, `max` — alongside `thinking: {"type": "enabled"|"disabled"}`, thinking on by default at `high` ([thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/), [changelog 2026-08-13](https://api-docs.deepseek.com/updates/)). So every build before this ran at `high`, the default, with no field sent. Three turns, three levels: a build asks for `max`, the strategist's brief asks for `max` because a thin brief is not something effort downstream can recover, and a reply or the memory note asks for `high`, which is also this provider's own default, said out loud so the request means it. `generate:routing` reports all three. Setting `AI_REASONING_EFFORT` overrides every turn with one value. Planning and the build share the GLM route. Chat stays on DeepSeek. The two budgets behind the chat route were widened to leave room for the thinking either way — memory to 24000 tokens over 180s, the strategist to 32000 — because a ceiling that only fits the answer comes back empty when the thinking is billed inside it. Measured here, one puzzle three times each: disabled 0/0/0 characters, `low` 863/991/1,704, nothing sent 2,162/2,221/4,767, `max` 1,850/2,264/3,616 — effort is a ceiling on willingness, not a quota, so `max` only pulls away from `high` on work hard enough to want it. DeepSeek takes seven names for those three efforts and maps them itself — `minimal`/`low` → low, `medium`/`high`/`xhigh` → high, `max`/`ultra` → max — so all seven are passed through as written and `generate:routing` reports what was actually sent. Gemini's vocabulary is the narrower one (low, medium, high), and a name it lacks meets the nearest it has. `temperature`, `presence_penalty` and `frequency_penalty` are documented as inert while thinking is on, so Forge no longer sends `temperature` to these models. `deepseek-flash` is a rolling alias — the 2026-09-10 entry retires V4 Flash and routes the old `deepseek-v4-flash` name to V4.1 Flash — so the model behind it can move without the id changing. That field was once Gemini's alone, on the grounds that it broke every other provider — measured on this route it does not: asked one puzzle, `deepseek-v4-pro` thought 1,409–1,617 characters at `low` against 4,702–15,856 at `high`, `deepseek-flash` 2,574 against 6,836, and every call answered 200. So it is sent for the models in `EFFORT_MODELS` and on a Gemini host, and nowhere else: an unmeasured provider still gets a plain body. A chat turn stays plain even on those models, because the strategist and the memory note ride that route and neither should pay for a long think. `AI_REASONING_EFFORT` accepts `low` / `medium` / `high`; unset lands on `high`.
- **Images:** Gemini Nano Banana 2 Lite. `GEMINI_API_KEY` (same value as Convex `AI_IMAGE_API_KEY`) in `.env.local` and GitHub secret `GEMINI_API_KEY`. `AI_IMAGE_MODEL=gemini-3.1-flash-lite-image`. Pictures stay on this native image route; they never go through the chat model.
- **Verify without secrets:** `npx convex run generate:routing` on polished-ram-883. It returns `chat` on `deepseek-flash` at host `api.deepseek.com` (`maxTokens` 32000, `reasoningEffort: "high"`), `strategy` on `deepseek-flash` at the same host with `reasoningEffort: "max"`, `build` on `deepseek-flash` at the same host with `reasoningEffort: "max"`, `maxTokens: 96000` and `sameAsChat: true`, `review` (the design auditors) on the build route with `on: true`, `sameAsBuild: true`, `reasoningEffort: "max"` and `maxTokens: 32000`, and `image` on `gemini-3.1-flash-lite-image` with `pinnedToLite: false`. There is no `misrouted` or `refuseReason` field any more — the route guard was removed, so nothing is judged before it is tried. A session that cannot reach the deployment can run `npx vitest run convex/routing.test.ts convex/buildFlow.test.ts` instead, which drives the same settings through the real build pipeline.
- **When the route looks right and builds still fail:** `npx convex run probe:chat` makes one small call to the configured chat route and reports what came back — HTTP status, which fields the reply carried, how many characters went to `content` and how many to a reasoning field, `finish_reason`, and the provider's own error. It describes the key (length, stray whitespace from a paste, masked ends) but never returns it, and scrubs the key out of anything the provider echoes. `generate:routing` says where a turn is sent; this says what answers. `deepseek-flash` is a reasoning model: its thinking lands in `reasoning_content` and is billed inside `completion_tokens`, which is what `max_tokens` caps — a real build measured 15,592 reasoning + 11,344 content tokens. A build now carries a ceiling of 96000 and a conversation 32000 in `convex/generate.ts`, so no environment variable is needed for a build to have room to think and still write a site in pages. `AI_MAX_TOKENS` still overrides both where it is set, so a value below what a site needs is a build that fails: `npx convex run generate:routing` now reports the ceiling each route actually uses, and clearing the variable is what hands a deployment back the defaults. It is **not** set on polished-ram-883 — routing there reports 96000 for a build and 32000 for chat, which are the defaults — so an earlier note here saying it had been set to 393216 was wrong, and a build was running inside the old 24000 until this was fixed. Read the ceiling from `routing` rather than from this file. Empty `content` beside a large `reasoningChars` means the budget went on thinking; the same request buys the same answer, so Forge asks again inside a wider ceiling — never above a cap the provider itself named — and tells the model to keep its planning short.
- **When a build stops part way:** replies are streamed, and nothing stops one for being slow. A stall is only what the stream itself shows — the connection dropping (`stream_dropped`), the provider erroring part way (`provider_stream_error`), or the model repeating the same passage of its thinking (`looping`). A page that had begun is carried on from where it stopped; a reply that stopped before its page began gets one fresh go. The only clock left is the action's own ten minutes: a reply still going when the words' share runs out (480s, the rest kept for pictures and the save) is recorded as `out_of_time` with the phase it was in, never as a stall. `npx convex run diagnostics:inspectStalls` lists recent stops with where each reply had got to, and `npx convex run probe:stream` makes one small streamed call through the same reader. `AI_STREAM=0` turns streaming off for a provider that cannot stream. Every build that fails, and every build a reply stopped part way through, is emailed with its whole log to support@forgenexxus.com through Resend the moment it ends (`convex/support.ts`; `SUPPORT_EMAIL` and `SUPPORT_EMAIL_FROM` change the address and sender, `SUPPORT_REPORTS=0` stops them), and the run's log records whether the email went. `npx convex run support:test` sends one test report and says what Resend answered. **Paused on polished-ram-883** (`SUPPORT_REPORTS=0`) until forgenexxus.com is verified in Resend: Resend refuses the shared `onboarding@resend.dev` sender for any address but the account owner's, and refuses `reports@forgenexxus.com` until the domain is verified. `SUPPORT_EMAIL_FROM` is already `Forge Nexxus <reports@forgenexxus.com>`, so once the domain is verified, turning reports on is `npx convex env remove SUPPORT_REPORTS` and then `npx convex run support:test` to confirm one arrives. Sign-in links share that sender (`AUTH_EMAIL_FROM` is unset), so email sign-in only reaches the Resend account owner until the same fix is made for them.
- **Design (SkillUI Ultra, crews and auditors):** research runs in the design worker (`design-worker/`): Brave finds a reference, the page discovery agent chooses its pages -- five at most -- and `skillui --url <reference> --mode ultra --screens 5 --format both` extracts its design. The `.skill` package is stored per site with its extract and its tokens as a foundation stylesheet (`convex/siteDesign.ts`). Every first build and rebuild is written a page at a time by a crew (`convex/crew.ts`, `convex/buildDraft.ts`): a builder and an auditor for the header, two of each for the body, one of each for the footer. Each auditor checks its part against the extract the moment it is written; a page is kept only once all four agree, and a part still sent back after three rounds stops the build and returns its credits. The crews run on the page-at-a-time checkpoint steps as they were: each step is an action of its own on a 400s clock (`PAGE_STEP_MS`), a builder the clock stops while writing is saved and carried on from that character in the next step (`draft_partial`), three steps in a row that save nothing stop the build, and so does a part carried on more than four times or a draft past its step ceiling. SkillUI runs untimed in the worker and stops only when Convex closes its request. Edits made in the thread are checked by the same auditors before they save (`convex/designGate.ts`). The auditors ride the `review` route. `npx convex run buildDraft:inspect` shows each page's crew and `npx convex run designGate:inspect` each edit's verdicts. The retired Awwwards reviewer (`convex/designReview.ts`) stays off.
- **Cloud Claude:** if this session cannot reach `convex.cloud`, ship Convex by merging to `main` and watching the Actions Convex step (needs `CONVEX_DEPLOY_KEY` secret, already set). Do not ask the user to paste keys.

