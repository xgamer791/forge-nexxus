# Website onboarding

The full-screen setup route is live. `ENABLED` in `docs/onboarding.js` is the
one switch for it; drafts saved in Convex survive it being turned off and on.

The pipeline runs start to finish with no step that can strand a member:
answers → private strategy → page written by the deployment's text model →
pictures made by its image model → version saved → address picked and published on the
hand-off screen → custom domain from the globe.

Paid members answer the questions before their first build. An empty planning
thread, draft row, cached browser flag or URL does not satisfy that gate — but
a failed build does not lock anyone in: the failed screen always offers Try
building again, Edit my answers (or Manage billing when credits or the plan
stopped it) and Back to dashboard, and New site brings the saved brief back.
Free members keep dashboard access; only the preview waits for a plan. The
globe stays open to them because it is where joining a plan is offered, and
the preview HTML query enforces the entitlement on the server.

A finished build publishes itself, and its first address is Forge's to give:
the server assigns `<slug>.sites.forgenexxus.com` — from the business name when
that makes a real address, from two plain words and a short tail when it does
not — and puts the build on it in the same transaction that saves it. Nothing
in this flow asks for an address, and nothing waits on one; the first question
asks what the business is called because the site needs a name on it, not
because a URL does. So the hand-off screen opens on a site that is already live. It shows
the address, View my website — a real link that opens the site in a new tab
while the same press lands the member in their dashboard — Go to my dashboard,
and Change the address or connect a domain, which opens the globe. The address
can be changed once from there, and a custom domain is one tab along (the form
on plans with custom domains, the plan offer on those without).

Publish my website remains as the fallback for a finished site that is not
live — a claim that failed, or a site taken offline. It is one button with no
field: the server assigns the address as the site goes live. Open it as a draft
sits beside it, so publishing is never the only way on.

Every new website uses the same eleven questions in `convex/onboardingQuestions.ts`.
The last one — *What do you sell, and what does it cost?* — is what a products
section is built from: one product or service per line, with a price where the
member wants one shown. It is optional, and prices reach a site only through
it, because the agent may not invent one. New questions are appended rather
than slotted in beside a related one: answers are stored by position, so moving
an existing question would relabel every brief already saved. `FINAL_STEP` is
read from the list on both surfaces, so Build stays on the last question.
Answers, current step, uploads and the build state belong to the signed-in user
in `siteOnboarding`. Text autosaves; Continue waits for its write. Reloads and
other devices can resume. Required answers are the name and offering. Other
preferences can be skipped and are resolved by the builder without questions.

Each submitted answer schedules a private strategy update against the answered
snapshot. Stale updates cannot replace newer strategies. These provider calls
use the existing chat credit hold/settlement flow. The final build uses the
normal generation credit hold; failed generation releases that hold.

The scheduled builder writes `website-build-brief.md` content to Convex storage,
reads that saved file, and passes its complete questions, answers, private
strategy, and supplied assets to the building agent. It must build from that
context without discussing its strategy or asking follow-up questions. Unknown
business facts are omitted. Strategy is never returned by the browser query.
Image and text uploads are saved in Convex storage and removed with their site
or account. Reference URLs are inspiration, not a claim that they were crawled.

Progress comes from committed backend events: answers submitted, brief saved
and read, agent started, page written, pictures made, page received, and
version saved. The interface displays an indeterminate activity indicator
between events, never an estimated percentage or timed completion. The durable
scheduled build continues if the tab closes. The build gives the words up to
seven minutes and the pictures the rest of an action's ten; a watchdog at nine
and a half marks an abandoned attempt failed, releases its hold, and allows
retry; stale completions cannot overwrite a retry.

The build is hard to stall. A provider that stumbles (a dropped connection, a
rate limit, a 5xx) is asked once more; a provider whose output cap is lower than
the request says so and is asked again inside it; a page cut off at the cap is
continued where it stopped instead of failed; and a reply that talked instead
of building is asked for once more while there is time. What stopped a build is
written to the Convex log and, in the same words, to the failed screen — the
provider's answer, a clock that ran out, a balance that fell short — with keys
scrubbed and the line cut short, so nobody has to open the logs to learn why.
Every attempt ends on `complete` or `failed`: a log that cannot be written or
a model that never answers fails the attempt at once rather than leaving it
queued for the watchdog to find, a press on Try building again
queues exactly one more attempt, and a rebuild scraps the old page, its
pictures and its thread and bumps the site's build epoch before it queues, so a
page still arriving from before the press cannot land on the fresh site. Thread
builds have a watchdog of their own past the action's ten minutes, which fails
a reply the platform stopped and gives its hold back.

Pictures never decide whether a site gets built. Each one is its own `image`
request with its own hold, so a thin balance makes fewer pictures rather than
no site, and one that cannot be made is replaced with a quiet placeholder.

A build is a site in pages: one shell — the head, the stylesheet, the nav and
the footer every page shares — and a page for each part of the site the nav
links to, each at its own address: `/about`, `/menu`, `/contact`. Every page
answers at the site's address and in the preview, where a strip of the site's
pages moves between them.

What those pages are is decided by the brief, not by a fixed running order.
Every job the member picks in *What does your website need to do?* gets a real
home on the site: someone who sells products gets a products page or section,
one who takes bookings gets a booking one. The surface is built even though no
payment, calendar or form delivery sits behind it yet — a shop with no checkout
is still a shop — and its actions lead somewhere true: the contact page, an
anchor on the page, or a store link the brief supplies. What is not wired up is never drawn
as though it worked: no cart, no checkout, no confirmed order or signed-in
account, and no invented price, stock count or review.

The instructions that produce all this are split so nothing contradicts: the
build contract in `convex/generate.ts` owns output format and page structure,
`forge.md` owns Forge's house rules (identity, what the site must cover,
typography, images, safety), and the injected `frontend-design.md` skill owns
method. `forge.md` used to restate the skill for three hundred lines and
disagree with the contract about typefaces; `scripts/prompts.test.ts` now keeps
the three in their lanes, holds the whole stack under a size budget, and fails
if the markdown files and their embedded copies in `convex/` drift apart.

## Deployment

The `main` workflow deploys Convex before GitHub Pages only when the repository
Actions secret `CONVEX_DEPLOY_KEY` holds a deploy key for the deployment named
by the `convex-url` meta tag. Without it the step prints `Skipping Convex
deploy` and the frontend still ships, so the app on Pages runs ahead of the
functions it calls: a press that needs a function the deployment lacks fails
with `Could not find public function`, and the building screen says which one.
Tests and typechecking are not run in this release workflow.

The frontend bundle is a required shipping artifact, generated with
`npm run build`; this command bundles the client and does not run tests.

## Design direction

The frontend-design skill is applied within Forge's existing visual system:
dark background `#121315`, dark text `#e9ebee`, light background `#f2f2f7`,
light text `#1c1c1e`, surface `#ffffff`, and light border `#d1d1d6` are inherited
through the existing theme tokens. System UI type, rounded fields and pill
actions match the dashboard. Questions are left aligned in one readable column;
the build screen is centered around the Forge mark and real progress events.
Each forward/back action uses an opacity fade, disabled for reduced motion.
The desktop layout uses the existing 900px breakpoint and shared shell width.

Design critique: the new route avoids a stretched dialog and repeated cards;
the question, answer, and next action carry the hierarchy. Contrast, safe-area
spacing, focus states and reduced-motion styles are implemented in the source.
No tests, typecheck, browser preview or screenshot checks were run, per request.
