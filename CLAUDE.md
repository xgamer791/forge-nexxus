# Forge Nexxus — standing rules

Claude Code loads this file automatically at the start of every session in this
repository, so treat it as always in effect. Re-read it before changing how any
user-facing state is stored, and follow it over habit or convenience.

**Rule 4 is a hard rule and outranks the rest.** The frontend-design skill is
written out in full there, and where it and anything else disagree — another
rule here, a convention already in `docs/`, habit, or a deadline — the skill
wins.

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

## Rule 4: the frontend-design skill is a hard rule, and it is below

**The frontend-design skill below is mandatory design direction for every
visual change, every time, and it supersedes every other rule in this file. Do
not skip the plan → review → build → critique process.** There is no change
small enough to be exempt from it and no deadline that earns an exemption.

Design work is anything a user sees or reads: a screen, a sheet, a control, an
icon, a layout, spacing, colour, a chip, an empty state, an error, a line of
copy — whether it is new or being reshaped. A one-line CSS change is design
work. Renaming a button is design work.

The skill is not something to remember to load. It is written out below, so it
is in context from the first message of every session here and nothing has to
go and fetch it. Loading it from anywhere else is redundant; skipping it is not
possible, because it is already in front of you. The vendored copy at
`.claude/skills/frontend-design/SKILL.md` is where it came from and what to
re-read when upstream changes; the text below is what governs.

Forge already has a visual language — the tokens, radii, type scale and
components in `docs/styles.css` — and Rule 3 puts every change at both widths.
Reach for an existing token or component first; when something genuinely needs
a shape the system does not have, the skill decides what that shape is rather
than the nearest default. Where the skill and something already here disagree,
the skill wins — including against a convention this file or `docs/styles.css`
already established. Say what moved and why, so the system follows the skill
rather than drifting away from it.

What follows is the skill as Forge's own building agent receives it, with the
handful of lines that speak to *that* agent's job rewritten for this one. You
are working on the Forge Nexxus app in `docs/`, not on a customer's website.

---

### Frontend Design

Approach this as the design lead at a design studio known for giving every
client a distinct visual identity that is not mistaken for anyone else's. This
client has already rejected proposals that felt cliché or templated, and is
paying for a distinctive point of view: make deliberate, opinionated choices
about palette, typography, and layout that are specific to this brief, and take
aesthetic risk if justified.

#### Ground your designs in the subject matter

If the brief does not identify what the product or subject matter is, settle it
yourself before designing and build on that reading. Decide one concrete
subject, the design's audience, and the design's primary job. Here the subject
is Forge Nexxus itself: a website builder used by small business owners, most
of them on a phone, who want the thing they came to do finished. The screen you
are changing, the flow it sits in, and what a member is trying to get done on
it are what you have; read them for the hint. The subject's industry, subject
matter, materials, and vernacular are where distinctive visual choices come
from — a design for a toy for girls aged 8–11 will be very aesthetically
different from a dashboard for financial analysts. Build with the brief's real
content and subject matter throughout.

#### Design principles

For web designs, the hero is the first thing viewers will see. Open with the
most characteristic thing in the subject's world, in the form that is most
appropriate: a headline, an image, an animation, a live demo, an interactive
moment, or other treatments. Be deliberate with your choice: a big number with
a small label, supporting stats, and a gradient accent is the default
treatment, so only use it if that's truly the best option.

Typography carries the personality of the page. You don't need a different
typeface for display or headline text and body content: Forge uses one family
for the whole product — Satoshi, set in `--font` — and its weights, sizes and
widths carry the hierarchy.

Choose your typefaces deliberately, not the default families you would reach
for on any other project, and set a clear type scale following the default
guidance of The Elements of Typographic Style with intentional weights, widths,
and spacing. When type is used as a headline or visual element, use the type
treatment itself as an active part of the design, not a neutral delivery
vehicle for the content.

Default to line lengths of less than 80 characters. Serif typefaces can have
slightly longer line lengths; give serif body text slightly more line-height
than a sans-serif.

Avoid these default typographic treatments; they are the commonest tells of a
generated page:
- Accenting just a single word or phrase in a headline, like putting one word
  in italic/bold or a different color.
- Using all caps for labels.
- Adding unnecessary typographic labels above content.

Visual structure is information. Structural devices like outlines, borders,
numbering, eyebrows, dividers, labels, etc., encode useful information about
the content rather than decorate it. Many generic designs use numbered markers
(01 / 02 / 03), but that's only appropriate if the content actually is a
sequence — like a stepped process or a timeline. Before adding numbered
markers, check the content really is a sequence.

Use non-user-triggered motion sparingly and deliberately, only to draw
attention. A single orchestrated moment — one page-load sequence or one reveal
— lands better than scattered effects; fade-and-slide-up entrances on each
section and hover transitions on every card are the generic default and read as
AI-generated. Motion that answers a person's action (opening, expanding,
confirming) is welcome when it shows what changed.

Consider written content carefully. Often a design brief may not contain real
content, and it's up to you to come up with copy and placeholder content. Copy
can make a design feel as templated as the design itself. See the below section
on writing for more guidance.

#### Process: plan, review against the brief, build, critique

For calibration, AI-generated design right now clusters around some traits:
1. a warm cream background (near #F4F1EA) with a high-contrast serif display
   and a terracotta or warm-clay accent (often near #D97757 — Anthropic's own
   Claude-interaction accent, so on a user's brief it reads as a tell);
2. a near-black background with a single bright acid-green or vermilion accent;
3. a broadsheet-style layout with hairline rules, zero border-radius, and dense
   newspaper-like columns;
4. the SaaS-card kit: content chopped into identical rounded cards, one
   border-radius on everything regardless of hierarchy, the same soft grey
   shadow (rgba(0,0,0,.1)) under each, and gradient washes as decoration;
5. template chrome that appears whatever the subject: a tracked-out ALL-CAPS
   eyebrow label above every heading; meta strings joined with middle dots
   ('A · B · C'); labels built as 'WORD — fragment' with a spaced em dash;
   tinted near-black (#0B0B0B, #111) standing in for black; a monospace face
   for small data labels; a '→' appended to link and button text.

All traits are legitimate for some briefs, but they are defaults rather than
choices, and they appear regardless of subject. Where the brief pins down a
visual direction, follow it exactly — the brief's own words always win,
including when it asks for one of these looks. Where it leaves an axis free,
don't spend that freedom on one of these defaults. As with a hired human
designer, there's often a careful balance between doing what you're good at and
taking each project as a chance to experiment and learn.

Work in two passes. First, brainstorm a short design plan based on the client's
design brief: create a compact token system with color, type, layout, and
principles.
- Color: describe the core base palette as 4–6 named hex values.
- Type: the one family, and the weights and sizes that carry the hierarchy.
- Layout: a layout concept, using one-sentence prose descriptions and ASCII
  wireframes to ideate and compare. Include alignment guidance; should the
  content be left aligned, center aligned, justified?
- Principles: the high-level guidance for what makes this page unique.

Then review that plan against the brief before building: if any part of it
reads like the generic default you would produce for any similar page (work
through a similar prompt to see if you arrive somewhere similar) rather than a
choice made for this specific brief — revise that part. Say which part you
revised and why: unlike the building agent, your plan is reviewable and belongs
in the reply. Only after you've confirmed the relative uniqueness of your
design plan should you start to write the code, following the revised plan.

When writing the code, be careful of structuring your CSS selector
specificities. It's easy to generate CSS classes that cancel each other out
(especially with a type-based selector like .section and an element-based
selector like .cta). This can happen often with padding/margin between
sections.

#### Restraint and self-critique

Spend your boldness in one place. Let one element be the memorable thing, keep
everything around it quiet and disciplined, and cut any decoration that does
not serve the brief. Build to a quality floor without announcing it: responsive
down to mobile, visible keyboard focus, reduced motion respected, visually
accessible, harmonious color palettes. Critique your own work as you build
against the brief and the anti-default list above, taking screenshots to review
— Chromium is on this machine and a picture is worth 1000 tokens, and a
screenshot at a phone width and a desktop width is what Rule 3 asks for anyway.
Consider Chanel's advice: before leaving the house, take a look in the mirror
and remove one accessory.

#### More on writing in design

Words appear in a design for one reason: to make it easier to understand and
use. They are design content, not decoration. Bring the same intentionality and
minimalism to copywriting that you would bring to spacing and color. Before
writing anything, ask what the design needs to say, and how it can best be said
to help the person navigate the experience.

Write from the end user's perspective. Name things by what users will
understand in simple language, not by how the system is built. A user manages
notifications, not webhook config. Describe what something is or does in plain
terms rather than selling it. Being specific and legible to new users is always
better than being clever.

Use active voice as default. A CTA says exactly what happens when it is used:
"Save changes," not "Submit." An action keeps the same name through the whole
flow, so the button that says "Publish" produces a toast that says "Published."
The vocabulary of an interface is the signposting for someone navigating the
product. Cohesion and consistency are how people learn their way around.

Treat failure and emptiness as moments for direction, not mood. Explain what
went wrong and how to fix it, in the interface's voice rather than a person's.
Errors don't apologize, and they are never vague about what happened. An empty
screen is an invitation to act.

Keep the tone conversational: plain verbs, sentence case, no filler, with tone
matched to the brand and the audience. Let each written element do exactly one
job.

## Rule 5: client version number

The number at the top-right of the prompt is the Forge Nexxus client version.
It is a plain integer, not a hash.

**Read `VERSION.md` before you finish any change a user can see.** Increment
the number there, paint it on both surfaces, say `Latest version: N` in your
summary, and push to `main`. That file is the source of truth.

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

## Standing access: Convex + Gemini (every Claude session)

Secrets live in gitignored `.env.local` on the Windows GOAT checkout and in GitHub Actions secrets. **Never paste keys into chat.**

- **Convex deploy:** `CONVEX_DEPLOY_KEY` + `CONVEX_DEPLOYMENT=dev:polished-ram-883` in `.env.local`. Also `CONVEX_DEPLOY_KEY` GitHub Actions secret — pushing to `main` runs Convex deploy in CI.
- **Gemini:** `GEMINI_API_KEY` (same value as Convex `AI_API_KEY` / `AI_IMAGE_API_KEY`) in `.env.local` and GitHub secret `GEMINI_API_KEY`. Chat/build model is `gemini-3.8-flash` via OpenAI-compat base `https://generativelanguage.googleapis.com/v1beta/openai`. Images stay `gemini-3.1-flash-lite-image`.
- **Verify without secrets:** `npx convex run generate:routing` on polished-ram-883. It returns three rows: `chat` and `build` both on `gemini-3.8-flash` at host `generativelanguage.googleapis.com` (with `build.sameAsChat: true` while `AI_BUILD_MODEL` is unset), and `image` on `gemini-3.1-flash-lite-image` with `pinnedToLite: false`. There is no `misrouted` or `refuseReason` field any more — the route guard was removed, so nothing is judged before it is tried. A session that cannot reach the deployment can run `npx vitest run convex/routing.test.ts convex/buildFlow.test.ts` instead, which drives the same settings through the real build pipeline.
- **Cloud Claude:** if this session cannot reach `convex.cloud`, ship Convex by merging to `main` and watching the Actions Convex step (needs `CONVEX_DEPLOY_KEY` secret, already set). Do not ask the user to paste keys.

