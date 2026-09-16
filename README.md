# Forge Nexxus

A public spec bench. Type a brief, pick a surface / stack / heat, and stamp a first-cut build order. The spelling is **Nexxus** (two x’s).

This is a static site. There is no backend and no secrets. The forge runs in the browser.

**Live URL:** https://xgamer791.github.io/forge-nexxus/

## Run locally

The site is the files in `docs/`. Serve that folder with any static server.

```bash
git clone https://github.com/xgamer791/forge-nexxus.git
cd forge-nexxus
python3 -m http.server 4173 --directory docs
```

Open http://127.0.0.1:4173

Any other static server works the same way:

```bash
npx --yes serve docs
```

Asset paths are relative (`styles.css`, `app.js`), so the page works at the site root and on the GitHub Pages project path `/forge-nexxus/`.

## GitHub Pages

Pages serves the same `docs/` folder that you run locally.

1. In the repo, open **Settings → Pages**.
2. Either:
   - **Source:** GitHub Actions (this repo’s `Deploy GitHub Pages` workflow uploads `docs/` on every push to `main`), or
   - **Source:** Deploy from a branch → `main` → `/docs`.
3. After the first deploy, the site is at **https://xgamer791.github.io/forge-nexxus/**

`docs/.nojekyll` is included so GitHub does not process the folder as a Jekyll site.

## What is in the page

- Landing plate with the Forge Nexxus name and tagline
- **Spec bench:** live spec from your brief, example loads, nexus map you can inspect or drop modules from, copy-as-markdown

No accounts, API keys, or workspace connections.

## Layout

```
docs/                 published site
  index.html
  styles.css
  app.js
  404.html
  .nojekyll
.github/workflows/
  pages.yml           deploy docs/ to GitHub Pages
```
