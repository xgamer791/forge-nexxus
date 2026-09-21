# Website onboarding

The full-screen setup route is live. `ENABLED` in `docs/onboarding.js` is the
one switch for it; drafts saved in Convex survive it being turned off and on.

The pipeline runs start to finish with no step that can strand a member:
answers → private strategy → page written by DeepSeek Flash → pictures made by
Gemini Nano Banana 2 Lite → version saved → address picked and published on the
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

Every new website uses the same ten questions in `convex/onboardingQuestions.ts`.
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
written to the Convex log, and a member reads the reason only when it is theirs
to act on — out of credits, or a plan that ended.

Pictures never decide whether a site gets built. Each one is its own `image`
request with its own hold, so a thin balance makes fewer pictures rather than
no site, and one that cannot be made is replaced with a quiet placeholder.

The underlying generator still creates a single-file static website: one page
whose sections are the site's pages, with a nav that links to each. Separate
URLs per page are not part of this build. Requested commerce, memberships and
booking features guide the layout but must not be represented as working
integrations until those services are implemented.

## Deployment

The `main` workflow deploys Convex before GitHub Pages. Set the repository
Actions secret `CONVEX_DEPLOY_KEY` to the production deployment used by the
`convex-url` meta tag. A missing key stops publication and preserves the existing
live frontend. Tests and typechecking are not run in this release workflow.

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
