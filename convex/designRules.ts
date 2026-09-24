import { siteParts, type BuiltSite } from "./pages";

// Fonts stay on Fontshare, the way DESIGN_GOD's Type section requires.
export function assertDesignRules(site: BuiltSite) {
  const html = siteParts(site).join("\n");
  if (/fonts\.(?:googleapis|gstatic)\.com/i.test(html)) {
    throw new Error("The page used a font outside Fontshare. Follow Design God's Type rules.");
  }
}
