# Backups

## forge-app-2026-09-21

Snapshot of the **GitHub Pages mobile app** (`docs/` + `src/`) at `main` `3494c0e`, taken before copying the dashboard onto the Cloudways WordPress site.

- Live app: https://xgamer791.github.io/forge-nexxus/
- Archive: `forge-app-2026-09-21.tgz`
- Unpacked: `forge-app-2026-09-21/docs/` and `forge-app-2026-09-21/src/`

This is not the Cloudways website. Do not restore it onto `wordpress/` or the Cloudways theme, and do not copy the website over `docs/`.

To restore the app:

```bash
tar -xzf forge-app-2026-09-21.tgz
# copy forge-app-2026-09-21/docs/ over the repo docs/ folder
# copy forge-app-2026-09-21/src/ over the repo src/ folder
# npm run build, then push main so Pages publishes docs/
```

## forge-app-2026-09-20

Snapshot of the **GitHub Pages app** (`docs/` + `src/`) at `main` `2adc584`.

- Live app: https://xgamer791.github.io/forge-nexxus/
- Archive: `forge-app-2026-09-20.tgz`
- Unpacked: `forge-app-2026-09-20/docs/` and `forge-app-2026-09-20/src/`

This is not the Cloudways website. Do not restore it onto `wordpress/` or the Cloudways theme, and do not copy the website over `docs/`.

To restore the app:

```bash
tar -xzf forge-app-2026-09-20.tgz
# copy docs/ over the repo docs/ folder
# copy src/ over the repo src/ folder
# npm run build, then push main so Pages publishes docs/
```

## wordpress-2026-09-20-pre-app-sync

Live Cloudways WordPress theme snapshot taken **before** copying the GitHub Forge Nexxus app onto https://forgenexxus.com.

- Server: `1595519.cloudwaysapps.com` (`138.197.83.241`)
- App id: `ghxskkxdmf`
- Theme path: `/home/master/applications/ghxskkxdmf/public_html/wp-content/themes/forge-nexxus`
- Archive: `wordpress-2026-09-20-pre-app-sync.tgz`

Does not include `wp-config.php`, the database, or credentials.

To restore the theme on Cloudways:

```bash
tar -xzf wordpress-2026-09-20-pre-app-sync.tgz
# copy theme/ over applications/ghxskkxdmf/public_html/wp-content/themes/forge-nexxus
```
