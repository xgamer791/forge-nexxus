import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { createForgeData, LIVE_CLIENT_OPTIONS } from "./data.js";

const url = document.querySelector('meta[name="convex-url"]')?.content;
if (!url) throw new Error('Forge Nexxus needs <meta name="convex-url"> to reach Convex.');

const pageUrl = new URL(location.href);
const authCode = pageUrl.searchParams.get("code");
if (authCode !== null) {
  pageUrl.searchParams.delete("code");
  history.replaceState(history.state, "", pageUrl);
}

// An OAuth sign-in navigates out to the provider and back, so whatever holds
// the verifier has to survive a page load. Memory does not: falling straight to
// it meant Google could never complete where localStorage is blocked (private
// windows, blocked site data, storage partitioning). sessionStorage survives
// that round trip and is usually still there, so it goes in between.
function pickStorage() {
  for (const open of [() => localStorage, () => sessionStorage]) {
    try {
      const store = open();
      store.setItem("forge-storage-probe", "1");
      store.removeItem("forge-storage-probe");
      return store;
    } catch {
      /* Blocked or absent; try the next one. */
    }
  }
  const memory = new Map();
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
}

const data = createForgeData({
  client: new ConvexClient(url, LIVE_CLIENT_OPTIONS),
  httpClient: new ConvexHttpClient(url),
  storage: pickStorage(),
  api,
  authCode,
  navigate: (target) => location.assign(target),
  // This page, without whatever query or fragment it happens to be holding --
  // the sign-in code is appended to it on the way back in.
  redirectTo: `${location.origin}${location.pathname}`,
});
data.ready.catch((error) => console.error("Forge Nexxus could not start a session", error));

// iOS can suspend timers and sockets while the app is closed or backgrounded.
// A session the live client let go of in the meantime is refreshed on return,
// rather than waiting out a retry timer that was frozen with the page, or
// starting a guest session. One it still holds is left to it (data.js).
const resumeSession = () => {
  if (document.visibilityState !== "visible" || !navigator.onLine) return;
  void data.ready.then(() => data.auth.resume()).catch(() => {});
};
window.addEventListener("online", resumeSession);
window.addEventListener("pageshow", resumeSession);
document.addEventListener("visibilitychange", resumeSession);

export const { ready, auth, account, sites, messages, domains, billing, settings, memory, onboarding, diagnostics } = data;
export { QUESTIONS as onboardingQuestions } from "../convex/onboardingQuestions.js";
// The archive a site with several pages is downloaded as.
export { zipFiles } from "./zip.js";
