# Website onboarding

The full-screen setup route is parked. `ENABLED` in `docs/onboarding.js` is
`false`, so members land on the dashboard. Flip that flag to restore this flow.
Drafts already saved in Convex stay put.

Paid members cannot open the dashboard until a site has a saved generated
version. An empty planning thread, draft row, cached browser flag or URL does
not satisfy that gate. Free members keep dashboard access; preview and domain
controls are disabled, and the preview HTML query enforces the same entitlement.

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
and read, agent started, page received, and version saved. The interface displays
an indeterminate activity indicator between events, never an estimated
percentage or timed completion. The durable scheduled build continues if the
tab closes. A five-minute watchdog marks an abandoned attempt failed, releases
its hold, and allows retry; stale completions cannot overwrite a retry.

The underlying generator still creates a single-file static website. Requested
commerce, memberships and booking features guide the layout but must not be
represented as working integrations until those services are implemented.

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
