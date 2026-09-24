# Forge design research worker

This Node worker runs Chromium and SkillUI Ultra outside Convex. It finds the
reference a site's design comes from, chooses which of its pages the site
will have, and extracts the reference's design:

1. **Search.** Brave Search looks for businesses like the member's in Los
   Angeles, New York, San Diego and Miami, and candidate sites are inspected in
   Playwright; the best one is chosen. A site that already has a reference
   (a rebuild) is researched again at the same address with no search.
2. **Page discovery agent** (`discover.mjs`). It opens the reference's home
   page and reads the links its header and navigation carry, the phone menu's
   included, in the site's own order. It keeps the home page and the site's own
   destinations -- never a legal, account, cart, search or feed page, a file,
   or another host -- **five pages at most**. The footer's links only fill the
   list when the header has too few. The builders write exactly these pages.
3. **SkillUI Ultra** (`skillui.mjs`). `skillui --url <reference> --mode ultra
   --screens 5 --format both` crawls the reference in the same Chromium and
   writes its package: `SKILL.md`, `CLAUDE.md`, `DESIGN.md`, the layout,
   component, interaction, animation and visual-guide references, the colour,
   spacing and type tokens, scroll, page and section screenshots, and the whole
   of it as a `.skill` zip. Five screens match the five-page rule. The run gets
   its own temporary `HOME`, so SkillUI's copy of the skill for Claude Code never
   outlives the job. Nothing times it: a crawl takes as long as it takes, and
   it stops early only when the request it answers is closed.
4. **Upload.** The `.skill` package streams from disk to a single-use Convex
   storage URL and stays with the site. The job answers with the **extract**
   (the package's own text, cut to fit a model's turn, with no Google Fonts or
   bundled font files), the **foundation** (its tokens as CSS custom properties,
   light surfaces white per DESIGN_GOD) and the chosen pages.

Every stage streams to the build as it happens (`searching`, `candidate`,
`discovering`, `skillui`, `uploading`), and the member's build log shows each
one. A failed search, browser session, discovery, SkillUI run or upload fails
the job; so does a SkillUI run without its ultra outputs (DESIGN.md,
LAYOUT.md, page screenshots and the `.skill` archive), including one that
could not start Chromium. The model is never asked to invent a reference.

What the builds do with it is in `convex/`: every page is written by its own
crew of builders -- one for the header, two for the body, one for the footer --
each working to the extract (`convex/crew.ts`, `convex/buildDraft.ts`).

## Deploy

Run the Dockerfile as an HTTPS service reachable from the Convex deployment.
The container installs SkillUI 1.3.4, Playwright 1.59.1 and Chromium; SkillUI
drives the Playwright the worker installs. Give it enough memory and CPU for
Chromium and a persistent network connection for a research job that runs as
long as its crawl does. Convex holds the request open for up to seven minutes
(`convex/siteDesign.ts`), and when it closes the request the worker stops the
job's browser and its SkillUI run at once rather than finishing work nobody
is waiting for. Avoid a low virtual-memory limit (`ulimit -v`): Chromium and
Node's WebAssembly allocator can fail even when resident memory is available.
The inspection browser closes before SkillUI starts its own Chromium, and the
worker's temporary files are deleted after every job.

Worker environment:

* `DESIGN_WORKER_TOKEN`: a long random bearer token shared only with Convex.
* `BRAVE_SEARCH_API_KEY`: Brave Web Search API credential.
* `PORT`: optional, defaults to 8080.

Convex environment:

* `DESIGN_WORKER_URL`: the worker's HTTPS origin, with no path.
* `DESIGN_WORKER_TOKEN`: the same bearer token.

`GET /health` reports process health. `POST /research` is authenticated and
streams JSON lines; do not expose the worker without TLS and the bearer token.
Inspect a run with `npx convex run diagnostics:inspectRecent`, or in the
member's Build activity view.

If no worker is configured, onboarding fails with the saved answers intact.
This is intentional: a website cannot be built without its design package.
A site whose saved reference is from before SkillUI Ultra is extracted again
at the same address on its next rebuild, and edits wait for that rebuild.

## Checks

`npm test` runs `checks/*-check.mjs`: the discovery agent's choice of pages;
how a SkillUI package is read, turned into the extract and turned into the
foundation, against a package written in the shape SkillUI 1.3.4 writes; and
how the CLI is run -- in its own home, untimed, and stopped only when its
request is closed -- against a stand-in for it.
