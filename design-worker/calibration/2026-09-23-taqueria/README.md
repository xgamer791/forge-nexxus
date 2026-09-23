# Layout check on the taco pair, 2026-09-23

Reference: tacosinplano.com, measured by `node cli.mjs capture`. There are 7
routes, each measured at phone (390), tablet (768) and desktop (1440) widths,
and every capture was steady.
Draft: the El Farolito site Forge built before the measured path existed.
Its /menu was compared with /food-menu and its /catering with /cater.

- `reference.json`: the measured reference. It holds geometry only: no words,
  images, colours or fonts.
- `reference-spec.txt`: the builder's spec, written from `reference.json`.
- `draft-audit.json`, `draft-report.txt`: the draft's scores and the
  measured differences the check would send back to the builder.
- `masks/`: the reference|draft layout mask pairs for every route, width and
  region.
- `draft-shots/`: the draft as the check rendered it.

This run used the 0.95 thresholds in force at the time. Scores don't depend on
the threshold, and at today's 0.85 every region on every route still fails. The
text was measured line by line here; the block-level text in `layout.mjs` moves
the draft's highest scores by about a point. Screenshots of the reference site
are not kept here. `node cli.mjs capture https://tacosinplano.com/ --out <dir>`
makes them again.
