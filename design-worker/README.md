# Forge design research worker

This Node worker runs Chromium and SkillUI ultra outside Convex. It searches
Los Angeles, New York, San Diego and Miami using Brave Search, inspects
candidate sites in Playwright, discovers the homepage and up to five linked
pages, then runs `skillui --url <reference> --mode ultra --screens 5 --format both`.
Page discovery selects the homepage and at most five linked pages. The
five-screen cap is the product's page cap. The CLI writes `CLAUDE.md`,
`SKILL.md`, `DESIGN.md`, tokens and screens; the build consumes that package
and does not invent a design system.
It uploads that extract (the three documents, the tokens, and the discovered
routes) to a single-use Convex storage URL and streams actual stage events
back to the build action. `POST /audit` checks one page at a time: header
(1 auditor), body (2 auditors) and footer (1 auditor). A page is not complete
unless every auditor agrees. A failed search, browser session, upload, SkillUI
command or audit fails the build; the model is never asked to invent a reference.

## Deploy

Run the Dockerfile as an HTTPS service reachable from the Convex deployment.
The container installs SkillUI 1.3.4 (`npm install -g skillui`), Playwright
1.59.1 and Chromium. Ultra mode needs that Chromium. Give it
enough memory and CPU for Chromium and a persistent network connection for an
individual research job of up to six minutes. The package is stored in Convex;
the worker's temporary files are deleted after every job.
Avoid a low virtual-memory limit (`ulimit -v`): Chromium and Node's WebAssembly
allocator can fail even when resident memory is available. The inspection
browser closes before SkillUI starts its own Chromium sessions, and the final
archive streams from disk to Convex instead of being loaded into Node memory.

Worker environment:

* `DESIGN_WORKER_TOKEN`: a long random bearer token shared only with Convex.
* `BRAVE_SEARCH_API_KEY`: Brave Web Search API credential.
* `PORT`: optional, defaults to 8080.

Convex environment:

* `DESIGN_WORKER_URL`: the worker's HTTPS origin, with no path.
* `DESIGN_WORKER_TOKEN`: the same bearer token.

`GET /health` reports process health. `POST /research` is authenticated and
streams JSON lines; do not expose the worker without TLS and the bearer token.
The build log reports city searches, inspection, SkillUI execution and upload
from actual worker events. Inspect it with `diagnostics:inspectRecent` or in
the member's Build activity view.

If no worker or API key is configured, onboarding fails with the saved answers
intact. This is intentional: a website cannot be built without its design
package. Existing legacy sites need a rebuild before their next paid edit.

The saved package belongs to the site, survives additional page work and is
removed when the site is deleted or rebuilt. The generated prompt is the SkillUI Ultra extract. `designgod.ts` controls font
families;
the builder asks the existing Nano Banana Lite image route for original images
and writes copy from the user's brief.
