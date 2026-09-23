// Public web addresses only. The worker never follows a private host.
const BLOCKED = /^(localhost|.*\.local|.*\.internal)$/i;

export function publicUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port))) return null;
    if (BLOCKED.test(host) || host === "localhost" || host === "0.0.0.0" || host === "::1" ||
        /^10\.|^127\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^(?:fc|fd|fe80)/i.test(host) || !host.includes(".")) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}
