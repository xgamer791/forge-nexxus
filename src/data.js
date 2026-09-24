const TOKEN_KEY = "forge-auth-token";
const REFRESH_KEY = "forge-auth-refresh";
const KIND_KEY = "forge-auth-kind";
const VERIFIER_KEY = "forge-auth-verifier";
const PENDING_KEY = "forge-auth-pending";
const GUEST_RETRY_MS = [1000, 2000, 4000, 8000, 16000];
// A saved token with less than this left is refreshed before the live client
// is given it, rather than presented to the deployment only to be turned down.
const EXPIRY_MARGIN_MS = 30 * 1000;
// A refresh that has not answered in this long is taken for lost and tried
// again. Asking twice is safe: Convex Auth hands whoever presents a rotated
// refresh token the rotation it already made, while that one is unused.
const REFRESH_TIMEOUT_MS = 15 * 1000;

// How the live client is made (src/browser.js). A token it has just been given
// is trusted until shortly before it runs out, instead of being swapped for
// another the moment the deployment accepts it: that swap rotated the refresh
// token on every load, and every rotation is one more a suspended phone can
// fall behind.
export const LIVE_CLIENT_OPTIONS = { initialAuthTokenReuse: true };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROVIDER_LABELS = { google: "Google", apple: "Apple", link: "That sign-in link" };

// A sign-in that comes back without a session has to say why. "It didn't work"
// sends someone round the same loop again, and the loop is the bug: the front
// door looks untouched, so the only thing left to try is the button that just
// failed.
function failure(provider, error) {
  const label = PROVIDER_LABELS[provider] ?? "That sign-in";
  const lead =
    provider === "link" ? `${label} could not be used` : `${label} sign-in could not be completed`;
  const detail = String(error?.message ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return detail
    ? `${lead}: ${detail.slice(0, 160)}`
    : `${lead}. It may have expired or already been used — please try again.`;
}

// Coming back from a provider with no code in the URL at all is a different
// failure from a code that would not exchange, and it is the one that looks
// like nothing happened. Convex Auth's OAuth callback redirects home
// empty-handed whenever its own exchange throws — bad client credentials, a
// redirect URI the provider will not accept, a check that did not line up —
// and the reason only ever reaches the Convex logs. Say which half it is, so
// the next attempt is evidence instead of another round.
function returnedWithoutCode(provider) {
  const label = PROVIDER_LABELS[provider] ?? "That sign-in";
  const who = provider === "link" ? "The sign-in link" : label;
  return `${who} sent you back without a sign-in code. Either it was cancelled, or this deployment could not complete the exchange — the Convex logs name the reason.`;
}

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
  // Where a provider or a magic link should come back to. "/" leaves the app's
  // path to be derived from the deployment's SITE_URL, which is a dependency
  // the app does not need: it knows its own address. A SITE_URL that names the
  // origin without the app's path sent everyone back to a page that is not the
  // app, which no amount of client-side recovery can reach.
  redirectTo = "/",
  refreshTimeoutMs = REFRESH_TIMEOUT_MS,
}) {
  let token = read(TOKEN_KEY);
  let refreshToken = read(REFRESH_KEY);
  let refreshing = null;
  let restoring = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let sessionVersion = 0;
  let signingOut = false;
  // Where the live client is with the session it was handed: "idle" while it
  // holds none -- before the first, after a sign-out, or once it has said it
  // lost the one it had -- "pending" from `setAuth` until it answers, and
  // "signedIn" once the deployment accepted it.
  let live = "idle";
  const listeners = new Set();
  const accountListeners = new Set();
  const handoffListeners = new Set();
  // A sign-in that leaves the page — an OAuth provider, or a magic link opened
  // later — only finishes on the way back in. Arriving with a code means one is
  // in flight, so the app can say so rather than showing the front door again
  // while it works.
  let handoffPending = authCode === null ? null : (read(PENDING_KEY) ?? "link");
  let handoffError = null;
  if (authCode === null) {
    const abandoned = read(PENDING_KEY);
    if (abandoned !== null) {
      write(PENDING_KEY, null);
      write(VERIFIER_KEY, null);
      handoffError = returnedWithoutCode(abandoned);
    }
  }

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
    live = "idle";
    if (typeof client.clearAuth === "function") client.clearAuth();
    else if (typeof client.client?.clearAuth === "function") client.client.clearAuth();
    else client.setAuth(async () => null);
  }

  // Hands the live client the session. From here until it answers, the session
  // is its to confirm, and to refresh if the deployment turns the token down.
  function connectLive() {
    live = "pending";
    client.setAuth(fetchToken, onAuthStatus);
  }

  // Whether a session token is known to have run out, or to be about to, by
  // its own expiry. One this cannot read is left for the deployment to judge.
  function expiring(value) {
    try {
      const payload = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const exp = Number(JSON.parse(atob(payload)).exp);
      return Number.isFinite(exp) && exp * 1000 - Date.now() < EXPIRY_MARGIN_MS;
    } catch {
      return false;
    }
  }

  // A refresh that never answers would hold the live client -- which waits on
  // it with its socket paused -- and the member with it. One that has gone
  // quiet for long enough fails like any outage, and is retried.
  function answered(request) {
    let timer;
    const quiet = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The session refresh went unanswered")), refreshTimeoutMs);
    });
    return Promise.race([request, quiet]).finally(() => clearTimeout(timer));
  }

  function state() {
    return { signedIn: token !== null, kind: token === null ? null : read(KIND_KEY) };
  }
  function emit() {
    const snapshot = state();
    for (const listener of listeners) listener(snapshot);
  }

  function emitHandoff() {
    const snapshot = { pending: handoffPending, error: handoffError };
    for (const listener of handoffListeners) listener(snapshot);
  }
  function setHandoff(next, error = null) {
    handoffPending = next;
    handoffError = error;
    emitHandoff();
  }
  function onHandoff(listener) {
    handoffListeners.add(listener);
    return () => handoffListeners.delete(listener);
  }

  // The server's answer about this session, delivered outside the live query.
  function pushAccount(user) {
    for (const listener of accountListeners) listener(user);
  }

  // Who the deployment says we are, asked over HTTP with the token in hand.
  // The live client has to re-authenticate its socket before its own users.me
  // can answer, and the app opens on that answer — so a slow, refused or
  // still-reconnecting handshake used to strand a member who had just signed
  // in behind the sign-in screen, holding valid tokens, with the single-use
  // code already stripped from the URL and no way back but signing in again.
  async function confirmMember(attempts = 3) {
    if (typeof httpClient.query !== "function") return null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (token === null) return null;
      httpClient.setAuth(token);
      try {
        const user = await httpClient.query(api.users.me, {});
        if (user) return user;
      } catch {
        /* A blip on the way back in; the retry is the whole recovery. */
      }
      if (attempt < attempts - 1) await wait(400 * 2 ** attempt);
    }
    return null;
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
      else connectLive();
    }
    emit();
  }

  // The live client's token source. A saved token that has run out is swapped
  // for a fresh one before the socket presents it: presenting it only earns a
  // refusal, and the client's recovery from that stops its socket while it
  // fetches another.
  async function fetchToken({ forceRefreshToken }) {
    if (!forceRefreshToken && token !== null && !expiring(token)) return token;
    if (refreshing) return refreshing;
    // Another tab of this app shares the saved session and rotates it too. A
    // refresh token each rotation has left behind is, to Convex Auth, one
    // being replayed -- more than one step behind and it ends the session --
    // so the one presented is always the newest saved, not the one this page
    // happened to read when it loaded.
    const saved = read(REFRESH_KEY);
    if (saved !== null && saved !== refreshToken) {
      refreshToken = saved;
      token = read(TOKEN_KEY) ?? token;
    }
    if (refreshToken === null) return null;
    const version = sessionVersion;
    const pending = answered(authCall({ refreshToken }, { withToken: false }))
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

  // Coming back to the app, or a retry coming due. Only a session the live
  // client has let go of is refreshed and handed back. One it still holds --
  // signed in, or still being confirmed -- is its own: it refreshes a token
  // that has run out itself, from the same fetchToken. Handing it the session
  // again while it did that was the endless "Signing you back in…": `pageshow`
  // fires on every load, the new session replaced the one mid-refresh, the
  // client dropped that refresh as out of date, and its socket, stopped for
  // the refresh, was never started again. Closing and reopening the app got
  // past it only because the refresh had saved a fresh token by then.
  async function resume() {
    if (signingOut || refreshToken === null || live !== "idle") return;
    if (restoring) return restoring;
    clearTimeout(retryTimer);
    retryTimer = null;
    const version = sessionVersion;
    const pending = (async () => {
      const refreshed = await fetchToken({ forceRefreshToken: true });
      if (version !== sessionVersion || signingOut || live !== "idle") return;
      if (refreshed !== null) connectLive();
    })().finally(() => {
      if (restoring === pending) restoring = null;
    });
    restoring = pending;
    return pending;
  }

  function onAuthStatus(isAuthenticated) {
    live = isAuthenticated ? "signedIn" : "idle";
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
          write(PENDING_KEY, null);
          setHandoff(null);
          const user = await confirmMember();
          if (user) pushAccount(user);
          return;
        }
        // A reply carrying no tokens is a refusal, not an outage.
        write(PENDING_KEY, null);
        setHandoff(null, failure(handoffPending, null));
      } catch (error) {
        // An expired or reused code keeps whatever session already exists —
        // but it used to keep it silently, which is indistinguishable from
        // never having signed in at all.
        write(PENDING_KEY, null);
        setHandoff(null, failure(handoffPending, error));
      }
    }
    if (token !== null || refreshToken !== null) {
      connectLive();
      emit();
      return;
    }
    await startGuest();
  })();

  async function signInWithEmail(email) {
    write(VERIFIER_KEY, null);
    const result = await authCall(
      { provider: "resend", params: { email, redirectTo } },
      { withToken: true },
    );
    return result?.started === true;
  }

  async function signInWith(provider) {
    write(VERIFIER_KEY, null);
    setHandoff(provider);
    try {
      const result = await authCall({ provider, params: { redirectTo } }, { withToken: true });
      if (!result?.redirect) throw new Error(`Sign-in with ${provider} did not start`);
      write(VERIFIER_KEY, result.verifier ?? null);
      // The verifier is only half of what the return leg needs; the other half
      // is knowing a sign-in is in flight at all.
      write(PENDING_KEY, provider);
      navigate(result.redirect);
      return result.redirect;
    } catch (error) {
      write(PENDING_KEY, null);
      setHandoff(null, failure(provider, error));
      throw error;
    }
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
    write(PENDING_KEY, null);
    setHandoff(null);
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
    auth: {
      state,
      onChange,
      handoff: () => ({ pending: handoffPending, error: handoffError }),
      onHandoff,
      signInWithEmail,
      signInWith,
      signOut,
      resume,
    },
    account: {
      subscribe: (callback) => {
        accountListeners.add(callback);
        const stop = client.onUpdate(api.users.me, {}, callback);
        return () => {
          accountListeners.delete(callback);
          stop();
        };
      },
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
      // One page of the current build, live. `path` picks which; unset is the
      // home page, and every reply carries the list of pages there are.
      currentHtml: (siteId, callback, path) =>
        client.onUpdate(api.sites.currentHtml, path ? { siteId, path } : { siteId }, callback),
      // The site as files to take away, or null when the plan does not include
      // the code. One file per page, links between them made relative.
      exportPages: (siteId) => client.query(api.sites.exportPages, { siteId }),
      publish: (id) => client.mutation(api.sites.publish, { id }),
      unpublish: (id) => client.mutation(api.sites.unpublish, { id }),
      // The address a site answers on. The domain it sits under is the
      // deployment's, so the browser is told it rather than carrying it.
      hosting: (callback) => client.onUpdate(api.sites.hosting, {}, callback),
      setSlug: (id, slug) => client.mutation(api.sites.setSlug, { id, slug }),
      slugAvailable: (slug, siteId) =>
        client.query(api.sites.slugAvailable, siteId ? { slug, siteId } : { slug }),
    },
    onboarding: {
      subscribe: (callback, onError) => client.onUpdate(api.onboarding.state, {}, callback, onError),
      start: () => client.mutation(api.onboarding.start, {}),
      save: (id, index, answer, advance = false) => client.mutation(api.onboarding.save, { id, index, answer, advance }),
      submit: (id) => client.mutation(api.onboarding.submit, { id }),
      rebuild: (siteId, options) => client.mutation(api.onboarding.rebuild, {
        ...(siteId ? { siteId } : {}),
        ...(options?.fresh ? { fresh: true } : {}),
      }),
      cancel: () => client.mutation(api.onboarding.cancel, {}),
      dismiss: (id) => client.mutation(api.onboarding.dismiss, { id }),
      uploadUrl: (id) => client.mutation(api.onboarding.uploadUrl, { id }),
      attach: (id, storageId, name) => client.mutation(api.onboarding.attach, { id, storageId, name }),
      detach: (id, storageId) => client.mutation(api.onboarding.detach, { id, storageId }),
    },
    // Live log of what the building agent is doing. Labels are safe to show;
    // the query never returns a key, a prompt, or HTML.
    diagnostics: {
      subscribe: (callback, onError) => client.onUpdate(api.diagnostics.mine, {}, callback, onError),
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
    // What Forge remembers about the member, across their sites. The server
    // writes it after a turn; a browser only lists it and forgets it.
    memory: {
      subscribe: (callback) => client.onUpdate(api.memory.list, {}, callback),
      forget: (id) => client.mutation(api.memory.forget, { id }),
      forgetAll: () => client.mutation(api.memory.forgetAll, {}),
    },
  };
}
