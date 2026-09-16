# Forge Nexxus

Mobile UI prototype rebuilt from the supplied screenshots. Main dashboard, connections sheet, model sheet, attachment menu, and hamburger drawer are included. Only menu opening/closing works; there are no accounts, API calls, uploads, or storage.

Live app: https://xgamer791.github.io/forge-nexxus/

## Hosting

Standard GitHub Pages only, using the existing `.github/workflows/pages.yml` workflow and `docs/` output. Keep all asset paths relative to support `/forge-nexxus/`. No OpenAI hosting configuration, authentication, or proprietary deployment dependency is included.

## Local preview

Run `npm run dev` (Node.js; no install required), then open http://localhost:4173/forge-nexxus/ . Any static server can also serve `docs/` directly.

## Layout requirements

The prompt docks to the browser viewport with a 20px bottom gap. Bottom sheets meet the viewport edge and the navigation drawer spans its height. These must remain independent of the app container height. iOS safe-area top padding and native system fonts are retained; the operating-system status bar and Dynamic Island are not drawn by the app.

## Review

`?reference` provides a 430 × 932 logical reference frame. `&screen=connections`, `models`, `attachments`, `navigation`, `settings`, or `appearance` exposes each menu for comparison. `&theme=light` or `&theme=dark` sets the Appearance theme. Test normal production layout separately: with a 932px viewport and a deliberately shortened 873px container, the prompt bottom must remain912px and bottom sheets must end at932px. Native iOS browser behavior still requires device verification.
