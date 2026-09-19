const TOKEN_KEY = "forge-auth-token";
const REFRESH_KEY = "forge-auth-refresh";
const KIND_KEY = "forge-auth-kind";
const VERIFIER_KEY = "forge-auth-verifier";
const GUEST_RETRY_MS = [1000, 2000, 4000, 8000, 16000];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Convex Auth's client library is React-only, so the session lifecycle is
// handled here: guests are signed in anonymously, sign-in codes (magic link or
// OAuth) are exchanged while still holding the guest token so the server can
// move the guest's data, and refreshes go out on the HTTP client so the live
// WebSocket client's auth state never blocks them.
export function createForgeData({
  client,
  httpClient,
  storage,
  api,
  authCode = null,
  wait = delay,
  navigate = () => {},
}) {
  let token = read(TOKEN_KEY);
  let refreshToken = read(REFRESH_KEY);
  let refreshing = null;
  let restoring = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let sessionVersion = 0;
  let signingOut = false;
  const listeners = new Set();

  function read(key) {
    try {
      return storage.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  function write(key, value) {
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch {
      /* Storage-less browsers keep the session in memory only. */
    }
  }

  // ConvexClient exposes setAuth but no clearAuth; only the BaseConvexClient
  // underneath it has one. Signing out has to tell the live client to drop its
  // token, so reach through to it, and fall back to a fetcher that resolves to
  // null, which is the only other way to say the same thing.
  function clearClientAuth() {
    if (typeof client.clearAuth === "function") client.clearAuth();
    else if (typeof client.client?.clearAuth === "function") client.client.clearAuth();
    else client.setAuth(async () => null);
  }

  function state() {
    return { signedIn: token !== null, kind: token === null ? null : read(KIND_KEY) };
  }
  function emit() {
    const snapshot = state();
    for (const listener of listeners) listener(snapshot);
  }

  function authCall(args, { withToken }) {
    if (withToken && token !== null) httpClient.setAuth(token);
    else httpClient.clearAuth();
    return httpClient.action(api.auth.signIn, args);
  }

  function applyTokens(tokens, kind, { reconnect }) {
    if (reconnect || !tokens) sessionVersion += 1;
    token = tokens?.token ?? null;
    refreshToken = tokens?.refreshToken ?? null;
    write(TOKEN_KEY, token);
    write(REFRESH_KEY, refreshToken);
    write(KIND_KEY, token === null ? null : kind);
    if (reconnect) {
      if (token === null) clearClientAuth();
      else client.setAuth(fetchToken, onAuthStatus);
    }
    emit();
  }

  async function fetchToken({ forceRefreshToken }) {
    if (!forceRefreshToken && token !== null) return token;
    if (refreshToken === null) return null;
    if (refreshing) return refreshing;
    const version = sessionVersion;
    const pending = authCall({ refreshToken }, { withToken: false })
      .then(({ tokens }) => {
        if (version !== sessionVersion) return null;
        clearTimeout(retryTimer);
        retryTimer = null;
        retryAttempt = 0;
        applyTokens(tokens ?? null, read(KIND_KEY), { reconnect: false });
        if (!tokens) clearClientAuth();
        return token;
      })
      .catch(() => {
        // A network/server outage is not a sign-out. Retain the saved refresh
        // token; only a successful response with no tokens invalidates it.
        if (version === sessionVersion) scheduleRestore();
        return null;
      })
      .finally(() => {
        if (refreshing === pending) refreshing = null;
      });
    refreshing = pending;
    return refreshing;
  }

  function scheduleRestore() {
    if (retryTimer !== null || refreshToken === null || signingOut) return;
    const version = sessionVersion;
    const pause = Math.min(1000 * 2 ** Math.min(retryAttempt++, 5), 30000);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (version === sessionVersion) void resume();
    }, pause);
  }

  async function resume() {
    if (signingOut || refreshToken === null) return;
    if (restoring) return restoring;
    clearTimeout(retryTimer);
    retryTimer = null;
    const version = sessionVersion;
    const pending = (async () => {
      const refreshed = await fetchToken({ forceRefreshToken: true });
      if (version !== sessionVersion || signingOut) return;
      if (refreshed !== null) client.setAuth(fetchToken, onAuthStatus);
    })().finally(() => {
      if (restoring === pending) restoring = null;
    });
    restoring = pending;
    return pending;
  }

  function onAuthStatus(isAuthenticated) {
    if (isAuthenticated || signingOut) return;
    if (refreshToken !== null) {
      scheduleRestore();
      return;
    }
    applyTokens(null, null, { reconnect: false });
    void startGuest().catch(() => {});
  }

  async function startGuest() {
    const version = sessionVersion;
    for (let attempt = 0; ; attempt += 1) {
      if (version !== sessionVersion || signingOut || refreshToken !== null) return;
      try {
        const { tokens } = await authCall({ provider: "anonymous" }, { withToken: false });
        if (version !== sessionVersion || signingOut) return;
        applyTokens(tokens ?? null, "guest", { reconnect: true });
        return;
      } catch (error) {
        if (attempt >= GUEST_RETRY_MS.length) throw error;
        await wait(GUEST_RETRY_MS[attempt]);
      }
    }
  }

  // OAuth codes must be presented with the verifier saved when the flow started;
  // magic-link codes have none. Either way the verifier is single-use.
  async function exchangeCode(code) {
    const verifier = read(VERIFIER_KEY) ?? undefined;
    write(VERIFIER_KEY, null);
    const { tokens } = await authCall({ params: { code }, verifier }, { withToken: true });
    return tokens ?? null;
  }

  const ready = (async () => {
    if (authCode !== null) {
      try {
        const tokens = await exchangeCode(authCode);
        if (tokens) {
          applyTokens(tokens, "member", { reconnect: true });
          return;
        }
      } catch {
        /* An expired or reused link keeps whatever session already exists. */
      }
    }
    if (token !== null || refreshToken !== null) {
      client.setAuth(fetchToken, onAuthStatus);
      emit();
      return;
    }
    await startGuest();
  })();

  async function signInWithEmail(email) {
    write(VERIFIER_KEY, null);
    const result = await authCall(
      { provider: "resend", params: { email, redirectTo: "/" } },
      { withToken: true },
    );
    return result?.started === true;
  }

  async function signInWith(provider) {
    write(VERIFIER_KEY, null);
    const result = await authCall({ provider, params: { redirectTo: "/" } }, { withToken: true });
    if (!result?.redirect) throw new Error(`Sign-in with ${provider} did not start`);
    write(VERIFIER_KEY, result.verifier ?? null);
    navigate(result.redirect);
    return result.redirect;
  }

  async function signOut() {
    signingOut = true;
    sessionVersion += 1;
    clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
    refreshing = null;
    restoring = null;
    // Revoking the server session is best effort and was never allowed to fail
    // the sign-out, so it must not be allowed to delay it either: awaiting a
    // stalled request left the session in place and the button looking dead.
    // The request is dispatched while the token is still set, then dropped.
    if (token !== null) {
      httpClient.setAuth(token);
      void httpClient.action(api.auth.signOut, {}).catch(() => {
        /* Already signed out server-side, or unreachable. */
      });
    }
    applyTokens(null, null, { reconnect: true });
    signingOut = false;
    await startGuest();
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    ready,
    auth: { state, onChange, signInWithEmail, signInWith, signOut, resume },
    account: {
      subscribe: (callback) => client.onUpdate(api.users.me, {}, callback),
      providers: (callback) => client.onUpdate(api.users.providers, {}, callback),
      updateProfile: (name) => client.mutation(api.users.updateProfile, { name }),
      // The server deletes the session with the account, so the tokens held
      // here are dead the moment this resolves; signing out starts a guest.
      deleteAccount: async () => {
        await client.mutation(api.users.deleteAccount, {});
        await signOut();
      },
    },
    // A site and its build thread are one thing to the app: creating a site
    // returns the conversation the composer posts into.
    sites: {
      subscribe: (callback) => client.onUpdate(api.sites.list, {}, callback),
      create: (name) => client.mutation(api.sites.create, name ? { name } : {}),
      rename: (id, name) => client.mutation(api.sites.rename, { id, name }),
      remove: (id) => client.mutation(api.sites.remove, { id }),
      // One prompt, one build: the action records the prompt, holds the
      // credits, calls the model, and answers in the thread.
      generate: (conversationId, prompt) =>
        client.action(api.generate.run, { conversationId, prompt }),
      currentHtml: (siteId, callback) =>
        client.onUpdate(api.sites.currentHtml, { siteId }, callback),
      publish: (id) => client.mutation(api.sites.publish, { id }),
      unpublish: (id) => client.mutation(api.sites.unpublish, { id }),
      // The address a site answers on. The domain it sits under is the
      // deployment's, so the browser is told it rather than carrying it.
      hosting: (callback) => client.onUpdate(api.sites.hosting, {}, callback),
      setSlug: (id, slug) => client.mutation(api.sites.setSlug, { id, slug }),
      slugAvailable: (slug, siteId) =>
        client.query(api.sites.slugAvailable, siteId ? { slug, siteId } : { slug }),
    },
    messages: {
      subscribe: (conversationId, callback) =>
        client.onUpdate(api.messages.list, { conversationId }, callback),
      send: (conversationId, body) =>
        client.mutation(api.messages.send, { conversationId, body }),
    },
    domains: {
      subscribe: (callback) => client.onUpdate(api.domains.list, {}, callback),
      add: (siteId, hostname) => client.mutation(api.domains.add, { siteId, hostname }),
      remove: (id) => client.mutation(api.domains.remove, { id }),
      // One button: the server looks the domain up in DNS and writes back what
      // it found, so a browser can never mark its own domain verified.
      verify: (id) => client.action(api.domains.verify, { id }),
    },
    // The plan, the balance, and the catalog all come from the deployment; the
    // client never carries a price or an allowance of its own.
    billing: {
      subscribe: (callback) => client.onUpdate(api.billing.summary, {}, callback),
      catalog: (callback) => client.onUpdate(api.billing.catalog, {}, callback),
      history: (callback) => client.onUpdate(api.billing.history, {}, callback),
      // Cancelling and resuming tell Stripe too when it is billing the plan.
      cancel: () => client.action(api.billing.cancel, {}),
      resume: () => client.action(api.billing.resume, {}),
      checkout: (choice) => client.action(api.billing.checkout, choice),
      portal: () => client.action(api.billing.portal, {}),
    },
    settings: {
      subscribe: (callback) => client.onUpdate(api.settings.get, {}, callback),
      update: (patch) => client.mutation(api.settings.update, patch),
    },
  };
}
