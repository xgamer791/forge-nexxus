# Forge design research worker

This Node worker runs Chromium outside Convex. It searches Los Angeles, New
York, San Diego and Miami with Brave Search, inspects candidate sites in
Playwright, and measures the chosen site: the homepage and the header's own
pages, at every width, including the opened menu. The capture is a
`forge-measured-v1` reference. The worker uploads that JSON to a single-use
Convex storage URL and streams stage events back to the build action.

A later build is checked the same way. `POST /audit` loads the saved reference
and measures the site's pages against it. The layout check in `layout.mjs`
requires every region — full page, header, opened menu, body and footer — to
agree at 0.85 or better. A failed search, browser session, upload or layout
check fails the build. The model is never asked to invent a reference, and a
site that does not pass is not saved.

## Deploy

Run the Dockerfile as an HTTPS service reachable from the Convex deployment.
The image installs Playwright 1.59.1 and Chromium, then copies every module
`server.mjs` loads (`capture.mjs`, `reference.mjs`, `layout.mjs`, `spec.mjs`)
along with `package.json` and the lockfile. `node server.mjs` is the command.
Give the container enough memory and CPU for Chromium, and a persistent
network connection for a research or audit job of up to six minutes. The
reference is stored in Convex; the worker's temporary files are deleted after
every job, keeping only the newest few on disk for inspection.
Avoid a low virtual-memory limit (`ulimit -v`): Chromium and Node's WebAssembly
allocator can fail even when resident memory is available.

Worker environment:

* `DESIGN_WORKER_TOKEN`: a long random bearer token shared only with Convex.
* `BRAVE_SEARCH_API_KEY`: Brave Web Search API credential. Required for a new
  site's city research. A rebuild that already has a reference URL is measured
  again at that address and does not search.
* `PORT`: optional, defaults to 8080.

Convex environment:

* `DESIGN_WORKER_URL`: the worker's HTTPS origin, with no path.
* `DESIGN_WORKER_TOKEN`: the same bearer token.

`GET /health` reports process health. `POST /research` and `POST /audit` are
authenticated and stream JSON lines. Do not expose the worker without TLS and
the bearer token.

Research events are `searching`, `candidate`, `inspecting`, `measuring` and
`uploading`, then `complete` with `storageId`, `referenceUrl`, `prompt` and
`inspectedPages`. Audit events are `rendering` and `comparing`, then `complete`
with `passed` and `fixes`. The build log records those events. Inspect it with
`diagnostics:inspectRecent` or in the member's Build activity view.

If no worker or API key is configured, onboarding fails with the saved answers
intact. This is intentional: a website cannot be built without its measured
reference, and a built site that fails the layout check is not saved. Existing
sites saved before this reference need a rebuild before their next paid edit.

The saved reference belongs to the site, survives additional page work and is
removed when the site is deleted or rebuilt. The generated prompt is the
measured spec: routes, section geometry and type sizes. `designgod.ts` controls
typography; the builder asks the existing Nano Banana Lite image route for
original images and writes copy from the user's brief. Pictures are made after
the layout check.
