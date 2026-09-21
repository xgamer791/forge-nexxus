# Forge Nexxus version

Current version: **12**

That integer is what the user sees at the top-right of the prompt canvas
(`[data-build-stamp]`). It is a plain number. Never show a hash, a `v` prefix,
or a padded label like `01`.

## Every agent, after every edit

1. Read this file. The number here is the source of truth.
2. If the user can see or do anything you changed, increment the number by 1.
3. Write the new number in all of these places:
   - `VERSION.md` (this file)
   - `docs/version.json` → `build`
   - `docs/index.html` → `meta[name="app-build"]` and `[data-build-stamp]`
   - `wordpress/page-app.php` → `meta[name="app-build"]` and `[data-build-stamp]`
4. Cache-bust the Pages assets: new 40-character hex in
   `docs/version.json` → `version`, `meta[name="app-version"]`, and every `?v=`
   query. Do not display that hex.
5. Copy `docs/app.js` → `wordpress/assets/js/forge-app.js`,
   `docs/onboarding.js` → `wordpress/assets/js/onboarding.js` and
   `docs/styles.css` → `wordpress/assets/css/app.css` when those change.
6. Say the new number in your summary: `Latest version: N`
7. Push to `main`. GitHub Pages deploys `docs/`. Copy the WordPress theme files
   to Cloudways app `ghxskkxdmf` at
   `/home/master/applications/ghxskkxdmf/public_html/wp-content/themes/forge-nexxus`.

Do this even for a one-line CSS or copy change. Skip the increment only when
the commit touches no user-facing surface.
