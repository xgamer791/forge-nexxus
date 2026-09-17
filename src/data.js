const TOKEN_KEY = "forge-auth-token";
const REFRESH_KEY = "forge-auth-refresh";
const KIND_KEY = "forge-auth-kind";
const GUEST_RETRY_MS = [1000, 2000, 4000, 8000, 16000];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Convex Auth's client library is React-only, so the session lifecycle is
// handled here: guests are signed in anonymously, magic-link codes are
// exchanged while still holding the guest token (which is what lets the
// server migrate guest data), and refreshes go out on the HTTP client so the
// live WebSocket client's auth state never blocks them.
export function createForgeData({ client, httpClient, storage, api, authCode = null, wait = delay }) {
  let token = read(TOKEN_KEY);
  let refreshToken = read(REFRESH_KEY);
  let refreshing = null;
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
    token = tokens?.token ?? null;
    refreshToken = tokens?.refreshToken ?? null;
    write(TOKEN_KEY, token);
    write(REFRESH_KEY, refreshToken);
    write(KIND_KEY, token === null ? null : kind);
    if (reconnect) {
      if (token === null) client.clearAuth();
      else client.setAuth(fetchToken, onAuthStatus);
    }
    emit();
  }

  async function fetchToken({ forceRefreshToken }) {
    if (!forceRefreshToken && token !== null) return token;
    if (refreshToken === null) return null;
    refreshing ??= authCall({ refreshToken }, { withToken: false })
      .then(({ tokens }) => {
        applyTokens(tokens ?? null, read(KIND_KEY), { reconnect: false });
        return token;
      })
      .catch(() => {
        applyTokens(null, null, { reconnect: false });
        return null;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  function onAuthStatus(isAuthenticated) {
    if (isAuthenticated) return;
    applyTokens(null, null, { reconnect: false });
    void startGuest();
  }

  async function startGuest() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { tokens } = await authCall({ provider: "anonymous" }, { withToken: false });
        applyTokens(tokens ?? null, "guest", { reconnect: true });
        return;
      } catch (error) {
        if (attempt >= GUEST_RETRY_MS.length) throw error;
        await wait(GUEST_RETRY_MS[attempt]);
      }
    }
  }

  const ready = (async () => {
    if (authCode !== null) {
      try {
        const { tokens } = await authCall(
          { provider: "resend", params: { code: authCode } },
          { withToken: true },
        );
        if (tokens) {
          applyTokens(tokens, "member", { reconnect: true });
          return;
        }
      } catch {
        /* An expired or reused link keeps whatever session already exists. */
      }
    }
    if (token !== null) {
      client.setAuth(fetchToken, onAuthStatus);
      emit();
      return;
    }
    await startGuest();
  })();

  async function signInWithEmail(email) {
    const result = await authCall(
      { provider: "resend", params: { email, redirectTo: "/" } },
      { withToken: true },
    );
    return result?.started === true;
  }

  async function signOut() {
    if (token !== null) {
      httpClient.setAuth(token);
      try {
        await httpClient.action(api.auth.signOut, {});
      } catch {
        /* Already signed out server-side. */
      }
    }
    applyTokens(null, null, { reconnect: true });
    await startGuest();
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    ready,
    auth: { state, onChange, signInWithEmail, signOut },
    conversations: {
      subscribe: (callback) => client.onUpdate(api.conversations.list, {}, callback),
      create: (title) => client.mutation(api.conversations.create, title ? { title } : {}),
      rename: (id, title) => client.mutation(api.conversations.rename, { id, title }),
      remove: (id) => client.mutation(api.conversations.remove, { id }),
    },
    messages: {
      subscribe: (conversationId, callback) =>
        client.onUpdate(api.messages.list, { conversationId }, callback),
      send: (conversationId, body) =>
        client.mutation(api.messages.send, { conversationId, body }),
    },
  };
}
