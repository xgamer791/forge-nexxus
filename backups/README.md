# Backups

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
