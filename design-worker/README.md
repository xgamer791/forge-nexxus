# Forge design research worker

This Node worker runs Chromium and SkillUI ultra outside Convex. It searches
Los Angeles, New York, San Diego and Miami using Brave Search, inspects
candidate sites in Playwright, captures representative page and menu states,
then runs `skillui --mode ultra --screens 12`. It selects the homepage and up
to seven distinct page types, along with desktop and mobile menu states. The
12-screen limit gives SkillUI room to explore the shell and linked layouts.
It uploads the complete `.skill`
archive to a single-use Convex storage URL and streams actual stage events
back to the build action. A failed search, browser session, upload or SkillUI
command fails the build; the model is never asked to invent a reference.

## Deploy

Run the Dockerfile as an HTTPS service reachable from the Convex deployment.
The container installs SkillUI 1.3.4, Playwright 1.59.1 and Chromium. Give it
enough memory and CPU for Chromium and a persistent network connection for an
individual research job of up to six minutes. The package is stored in Convex;
the worker's temporary files are deleted after every job.

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
removed when the site is deleted or rebuilt. The generated prompt uses the
reference's structure and design tokens. `designgod.ts` controls typography;
the builder asks the existing Nano Banana Lite image route for original images
and writes copy from the user's brief.
