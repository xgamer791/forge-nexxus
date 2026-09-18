import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { createForgeData } from "./data.js";

const url = document.querySelector('meta[name="convex-url"]')?.content;
if (!url) throw new Error('Forge Nexxus needs <meta name="convex-url"> to reach Convex.');

const pageUrl = new URL(location.href);
const authCode = pageUrl.searchParams.get("code");
if (authCode !== null) {
  pageUrl.searchParams.delete("code");
  history.replaceState(history.state, "", pageUrl);
}

function pickStorage() {
  try {
    localStorage.setItem("forge-storage-probe", "1");
    localStorage.removeItem("forge-storage-probe");
    return localStorage;
  } catch {
    const memory = new Map();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: (key) => memory.delete(key),
    };
  }
}

const data = createForgeData({
  client: new ConvexClient(url),
  httpClient: new ConvexHttpClient(url),
  storage: pickStorage(),
  api,
  authCode,
  navigate: (target) => location.assign(target),
});
data.ready.catch((error) => console.error("Forge Nexxus could not start a session", error));

// iOS can suspend timers and sockets while the app is closed or backgrounded.
// Refresh persisted credentials on return rather than starting a guest session.
const resumeSession = () => {
  if (document.visibilityState !== "visible" || !navigator.onLine) return;
  void data.ready.then(() => data.auth.resume()).catch(() => {});
};
window.addEventListener("online", resumeSession);
window.addEventListener("pageshow", resumeSession);
document.addEventListener("visibilitychange", resumeSession);

export const { ready, auth, account, sites, messages, domains, billing, settings } = data;
