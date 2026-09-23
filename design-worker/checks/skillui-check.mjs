// Checks for the worker's own logic: the page discovery agent's choice of
// pages, and how a SkillUI Ultra package is read, turned into the extract and
// turned into the foundation stylesheet. No browser and no network: the
// package is a folder written here in the shape SkillUI 1.3.4 writes.
// `npm test` in design-worker/ runs these.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chooseRoutes, MAX_PAGES, normalizePath, publicUrl } from "../discover.mjs";
import { extractPrompt, foundationCss, readPackage, runSkillUI, SCREENS } from "../skillui.mjs";

test("the discovery agent keeps the home page and the site's own pages, five at most", () => {
  const routes = chooseRoutes("https://www.tacos.example/", [
    "https://www.tacos.example/food-menu",
    "https://tacos.example/Food-Menu/",
    "https://www.tacos.example/privacy-policy",
    "https://www.tacos.example/cart",
    "https://www.tacos.example/menu.pdf",
    "https://elsewhere.example/about",
    "mailto:hola@tacos.example",
    "https://www.tacos.example/drink-menu#top",
    "https://www.tacos.example/specials?ref=nav",
    "https://www.tacos.example/events",
    "https://www.tacos.example/party",
    "https://www.tacos.example/cater",
  ]);
  assert.equal(MAX_PAGES, 5);
  assert.equal(SCREENS, 5);
  assert.deepEqual(routes.map((route) => route.path), ["/", "/food-menu", "/drink-menu", "/specials", "/events"]);
  assert.equal(routes[2].url, "https://www.tacos.example/drink-menu");
  assert.equal(routes[3].url, "https://www.tacos.example/specials");
});

test("addresses follow the same rules as the pages Convex serves", () => {
  assert.equal(normalizePath("/About/"), "/about");
  assert.equal(normalizePath("/menu.html"), "/menu");
  assert.equal(normalizePath("/index.html"), "/");
  assert.equal(normalizePath("/a/../b"), null);
  assert.equal(publicUrl("http://localhost:3000/"), null);
  assert.equal(publicUrl("https://10.0.0.4/"), null);
  assert.equal(publicUrl("https://tacos.example/#menu"), "https://tacos.example/");
});

async function writePackage(dir, { layout = "## Containers\n- max-width 1200px", pages = ["home.png"], skill = true } = {}) {
  const root = path.join(dir, "reference-tacos-example-design");
  await fs.mkdir(path.join(root, "references"), { recursive: true });
  await fs.mkdir(path.join(root, "tokens"), { recursive: true });
  await fs.mkdir(path.join(root, "screens", "pages"), { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), [
    "# Tacos Design System",
    "Use the warm red accent on every call to action.",
    "Load https://fonts.googleapis.com/css2?family=Poppins before anything else.",
    "![Home](screens/pages/home.png)",
    "",
    "# Full Reference Files",
    "## Design System Tokens (DESIGN.md)",
    "the embedded copy",
  ].join("\n"));
  await fs.writeFile(path.join(root, "CLAUDE.md"), "Read SKILL.md first.");
  await fs.writeFile(path.join(root, "references", "DESIGN.md"), "## Colors\n- accent #c2410c\n- fonts/poppins-400.woff2 is bundled");
  await fs.writeFile(path.join(root, "references", "LAYOUT.md"), layout);
  await fs.writeFile(path.join(root, "references", "COMPONENTS.md"), "## Buttons\n- pill, 48px tall");
  await fs.writeFile(path.join(root, "tokens", "colors.json"), JSON.stringify({
    core: {
      background: { value: "#f4f1ea", role: "background" },
      "text-primary": { value: "#1c1917", role: "text-primary" },
      accent: { value: "#c2410c", role: "accent" },
    },
    status: { danger: { value: "#b91c1c", role: "danger" } },
    extended: { "Salsa Green": { value: "#15803d", role: "other" }, broken: { value: "red;}body{display:none", role: "other" } },
  }));
  await fs.writeFile(path.join(root, "tokens", "spacing.json"), JSON.stringify({ base: { value: "8px" }, scale: { xs: { value: "4px" }, md: { value: "16px" } } }));
  await fs.writeFile(path.join(root, "tokens", "typography.json"), JSON.stringify({ scale: { h1: { fontFamily: "Poppins", fontSize: "56px", fontWeight: "700", lineHeight: "1.1" } } }));
  for (const name of pages) await fs.writeFile(path.join(root, "screens", "pages", name), "png");
  if (skill) await fs.writeFile(path.join(root, "reference-tacos-example-design.skill"), "PK");
  return root;
}

test("a package is read back only when every ultra output is there", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skillui-check-"));
  try {
    const root = await writePackage(dir);
    const pkg = await readPackage(dir);
    assert.equal(pkg.skillDir, root);
    assert.equal(pkg.screens, 1);
    assert.equal(path.basename(pkg.skillFile), "reference-tacos-example-design.skill");
    assert.equal(pkg.tokens.colors.core.accent.value, "#c2410c");

    const none = await fs.mkdtemp(path.join(os.tmpdir(), "skillui-check-"));
    await assert.rejects(readPackage(none), /wrote no design package/);
    await fs.rm(none, { recursive: true, force: true });

    const thin = await fs.mkdtemp(path.join(os.tmpdir(), "skillui-check-"));
    await writePackage(thin, { layout: "", pages: [], skill: false });
    await assert.rejects(readPackage(thin), /no usable design reference \(missing LAYOUT\.md, page screenshots, the \.skill package\)/);
    await fs.rm(thin, { recursive: true, force: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the extract carries the package's own text and the chosen pages, and no foreign fonts or image embeds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skillui-check-"));
  try {
    await writePackage(dir);
    const pkg = await readPackage(dir);
    const routes = [{ path: "/", url: "https://tacos.example/" }, { path: "/food-menu", url: "https://tacos.example/food-menu" }];
    const extract = extractPrompt({ source: "https://tacos.example/", routes, pkg });
    assert.match(extract, /^SKILLUI ULTRA DESIGN REFERENCE: https:\/\/tacos\.example\//);
    assert.match(extract, /the site has exactly these, home first: \/, \/food-menu\./);
    assert.match(extract, /- \/food-menu: the reference's https:\/\/tacos\.example\/food-menu/);
    assert.match(extract, /Use the warm red accent on every call to action\./);
    assert.match(extract, /LAYOUT\.md\n## Containers/);
    assert.match(extract, /COMPONENTS\.md\n## Buttons/);
    assert.match(extract, /DESIGN_GOD's Type, Icons, Anti-slop and floor rules win over it/);
    assert.doesNotMatch(extract, /fonts\.googleapis|\.woff2|the embedded copy|!\[Home\]/);
    assert.ok(extract.length <= 90000 + 20);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the foundation is the tokens as custom properties, light surfaces white, nothing unsafe", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skillui-check-"));
  try {
    await writePackage(dir);
    const pkg = await readPackage(dir);
    const css = foundationCss({ source: "https://tacos.example/", tokens: pkg.tokens });
    assert.match(css, /--color-background:#ffffff;/);
    assert.match(css, /--color-text:#1c1917;/);
    assert.match(css, /--color-accent:#c2410c;/);
    assert.match(css, /--color-danger:#b91c1c;/);
    assert.match(css, /--color-salsa-green:#15803d;/);
    assert.match(css, /--space-base:8px;/);
    assert.match(css, /--space-md:16px;/);
    assert.match(css, /--text-h1:56px;/);
    assert.match(css, /--weight-h1:700;/);
    assert.doesNotMatch(css, /display:none|Poppins/);
    assert.equal(foundationCss({ source: "https://tacos.example/", tokens: {} }), "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A stand-in for the CLI: it records how it was asked, then either writes the
// package it was given and exits, or keeps crawling until it is stopped.
async function fakeSkillUI(dir, { forever = false } = {}) {
  const bin = path.join(dir, "fake-skillui.mjs");
  await fs.writeFile(bin, [
    "#!/usr/bin/env node",
    'import fs from "node:fs";',
    "const args = process.argv.slice(2);",
    'fs.writeFileSync(process.env.FAKE_SKILLUI_LOG, JSON.stringify({ args, home: process.env.HOME }));',
    forever
      ? "setInterval(() => {}, 1000);"
      : 'fs.cpSync(process.env.FAKE_SKILLUI_PACKAGE, args[args.indexOf("--out") + 1], { recursive: true });',
  ].join("\n"));
  await fs.chmod(bin, 0o755);
  return bin;
}

test("SkillUI Ultra runs in its own home with no clock of its own, and stops only when the request it answers is closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skillui-check-"));
  const template = path.join(dir, "template");
  const out = path.join(dir, "out");
  const log = path.join(dir, "log.json");
  await fs.mkdir(out);
  process.env.FAKE_SKILLUI_LOG = log;
  process.env.FAKE_SKILLUI_PACKAGE = template;
  try {
    await writePackage(template);
    const pkg = await runSkillUI("https://tacos.example/", out, "reference-tacos-example", { bin: await fakeSkillUI(dir) });
    assert.equal(pkg.screens, 1);
    const asked = JSON.parse(await fs.readFile(log, "utf8"));
    assert.deepEqual(asked.args, [
      "--url", "https://tacos.example/", "--mode", "ultra", "--screens", "5", "--format", "both", "--name", "reference-tacos-example", "--out", out,
    ]);
    // Its home was its own, and is gone with the run.
    assert.notEqual(asked.home, os.homedir());
    await assert.rejects(fs.stat(asked.home));

    // A crawl that is still going is never stopped for taking its time; the
    // request it answers closing is what stops it.
    const job = new AbortController();
    const running = runSkillUI("https://tacos.example/", out, "reference-tacos-example", { bin: await fakeSkillUI(dir, { forever: true }), signal: job.signal });
    let settled = false;
    running.catch(() => {}).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(settled, false);
    job.abort();
    await assert.rejects(running, /request was closed, so SkillUI Ultra was stopped/);

    await assert.rejects(
      runSkillUI("https://tacos.example/", out, "reference-tacos-example", { bin: await fakeSkillUI(dir), signal: AbortSignal.abort() }),
      /closed before SkillUI Ultra started/,
    );
  } finally {
    delete process.env.FAKE_SKILLUI_LOG;
    delete process.env.FAKE_SKILLUI_PACKAGE;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
