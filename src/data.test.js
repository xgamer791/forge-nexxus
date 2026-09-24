// @vitest-environment node
import { BaseConvexClient, ConvexClient, ConvexHttpClient } from "convex/browser";
import { describe, expect, test, vi } from "vitest";
import { createForgeData, LIVE_CLIENT_OPTIONS } from "./data.js";

const api = {
  auth: { signIn: "auth:signIn", signOut: "auth:signOut" },
  users: {
    me: "users:me",
    providers: "users:providers",
    updateProfile: "users:updateProfile",
    deleteAccount: "users:deleteAccount",
  },
  sites: {
    list: "sites:list",
    create: "sites:create",
    rename: "sites:rename",
    remove: "sites:remove",
    currentHtml: "sites:currentHtml",
    publish: "sites:publish",
    unpublish: "sites:unpublish",
  },
  generate: { run: "generate:run" },
  messages: { list: "messages:list", send: "messages:send" },
  domains: { list: "domains:list", add: "domains:add", remove: "domains:remove" },
  billing: {
    summary: "billing:summary",
    catalog: "billing:catalog",
    history: "billing:history",
    cancel: "billing:cancel",
    resume: "billing:resume",
    checkout: "billing:checkout",
    portal: "billing:portal",
  },
  settings: { get: "settings:get", update: "settings:update" },
  memory: { list: "memory:list", forget: "memory:forget", forgetAll: "memory:forgetAll" },
  diagnostics: { mine: "diagnostics:mine" },
  onboarding: { rebuild: "onboarding:rebuild" },
};

const tokens = (label) => ({ token: `${label}-token`, refreshToken: `${label}-refresh` });
const stored = (label, kind) => ({
  "forge-auth-token": `${label}-token`,
  "forge-auth-refresh": `${label}-refresh`,
  "forge-auth-kind": kind,
});

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

// Mirrors ConvexClient's real shape: it has setAuth but no clearAuth of its
// own, and exposes the base client that does. A fake with a clearAuth of its
// own hid a sign-out that threw on every attempt.
function fakeClient() {
  const base = { clearAuth: vi.fn() };
  return {
    setAuth: vi.fn(),
    onUpdate: vi.fn(() => vi.fn()),
    mutation: vi.fn(),
    action: vi.fn(),
    client: base,
    clearAuth: undefined,
  };
}

async function defaultHandler(fn, args) {
  if (fn === "auth:signOut") return null;
  if (args.provider === "anonymous") return { tokens: tokens("guest") };
  if (args.provider === "google" || args.provider === "apple") {
    return {
      redirect: `https://x.convex.site/api/auth/signin/${args.provider}?code=v-${args.provider}`,
      verifier: `v-${args.provider}`,
    };
  }
  if (args.refreshToken) return { tokens: tokens("refreshed") };
  if (args.params?.code === "good") return { tokens: tokens("member") };
  if (args.params?.code) throw new Error("Could not verify code");
  if (args.params?.email) return { started: true };
  throw new Error(`unexpected call ${JSON.stringify(args)}`);
}

function harness({ storage = memoryStorage(), handler = defaultHandler, authCode = null } = {}) {
  const client = fakeClient();
  const navigate = vi.fn();
  const http = { auth: null, calls: [] };
  http.setAuth = (value) => {
    http.auth = value;
  };
  http.clearAuth = () => {
    http.auth = null;
  };
  http.action = vi.fn(async (fn, args) => {
    http.calls.push({ fn, args, auth: http.auth });
    return handler(fn, args);
  });
  const data = createForgeData({
    client,
    httpClient: http,
    storage,
    api,
    authCode,
    wait: async () => {},
    navigate,
  });
  return { client, http, storage, data, navigate };
}

describe("rebuild target", () => {
  test("the selected site reaches the server instead of silently choosing the latest brief", async () => {
    const { data, client } = harness();
    await data.ready;
    await data.onboarding.rebuild("selected-site");
    expect(client.mutation).toHaveBeenLastCalledWith("onboarding:rebuild", { siteId: "selected-site" });
    await data.onboarding.rebuild();
    expect(client.mutation).toHaveBeenLastCalledWith("onboarding:rebuild", {});
  });
});

describe("session bootstrap", () => {
  test("a first visit becomes a guest and authenticates the live client", async () => {
    const { client, http, storage, data } = harness();
    await data.ready;
    expect(http.calls).toEqual([{ fn: "auth:signIn", args: { provider: "anonymous" }, auth: null }]);
    expect(storage.dump()).toEqual(stored("guest", "guest"));
    expect(client.setAuth).toHaveBeenCalledTimes(1);
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "guest" });
  });

  test("a stored session is reused without a network call", async () => {
    const { client, http, data } = harness({ storage: memoryStorage(stored("old", "member")) });
    await data.ready;
    expect(http.calls).toEqual([]);
    expect(client.setAuth).toHaveBeenCalledTimes(1);
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "member" });
  });

  test("a magic-link code is exchanged while still holding the guest token", async () => {
    const { http, storage, data } = harness({
      storage: memoryStorage(stored("guest", "guest")),
      authCode: "good",
    });
    await data.ready;
    expect(http.calls).toEqual([
      { fn: "auth:signIn", args: { params: { code: "good" } }, auth: "guest-token" },
    ]);
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "member" });
    expect(storage.dump()).toEqual(stored("member", "member"));
  });

  test("an OAuth code is exchanged with the saved verifier, which is then discarded", async () => {
    const storage = memoryStorage({ ...stored("guest", "guest"), "forge-auth-verifier": "v-google" });
    const { http, data } = harness({ storage, authCode: "good" });
    await data.ready;
    expect(http.calls[0]).toEqual({
      fn: "auth:signIn",
      args: { params: { code: "good" }, verifier: "v-google" },
      auth: "guest-token",
    });
    expect(storage.dump()["forge-auth-verifier"]).toBeUndefined();
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "member" });
  });

  test("a bad code keeps the guest session", async () => {
    const { client, data } = harness({
      storage: memoryStorage(stored("guest", "guest")),
      authCode: "stale",
    });
    await data.ready;
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "guest" });
    expect(client.setAuth).toHaveBeenCalledTimes(1);
  });

  test("guest sign-in retries transient failures", async () => {
    let attempts = 0;
    const { data } = harness({
      handler: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("offline");
        return { tokens: tokens("guest") };
      },
    });
    await data.ready;
    expect(attempts).toBe(3);
    expect(data.auth.state().signedIn).toBe(true);
  });
});

describe("token lifecycle", () => {
  test("the live client's token fetcher refreshes on demand", async () => {
    const { client, http, data } = harness();
    await data.ready;
    const [fetchToken] = client.setAuth.mock.calls[0];
    expect(await fetchToken({ forceRefreshToken: false })).toBe("guest-token");
    expect(await fetchToken({ forceRefreshToken: true })).toBe("refreshed-token");
    expect(http.calls.at(-1)).toEqual({
      fn: "auth:signIn",
      args: { refreshToken: "guest-refresh" },
      auth: null,
    });
    expect(await fetchToken({ forceRefreshToken: false })).toBe("refreshed-token");
    expect(client.setAuth).toHaveBeenCalledTimes(1);
  });

  // A refresh that fails and a refresh that comes back empty mean different
  // things: the first is an outage to retry, the second is a real sign-out.
  test("a failed refresh keeps the session for a later retry", async () => {
    const { client, data } = harness({
      handler: async (fn, args) => {
        if (args.refreshToken) throw new Error("network down");
        return { tokens: tokens("guest") };
      },
    });
    await data.ready;
    const [fetchToken] = client.setAuth.mock.calls[0];
    expect(await fetchToken({ forceRefreshToken: true })).toBeNull();
    expect(data.auth.state().signedIn).toBe(true);
    expect(client.client.clearAuth).not.toHaveBeenCalled();
  });

  test("a revoked session falls back to a fresh guest", async () => {
    const { client, data } = harness({
      handler: async (fn, args) => {
        if (args.refreshToken) return { tokens: null };
        return { tokens: tokens("guest") };
      },
    });
    await data.ready;
    const [fetchToken, onStatus] = client.setAuth.mock.calls[0];
    expect(await fetchToken({ forceRefreshToken: true })).toBeNull();
    expect(data.auth.state().signedIn).toBe(false);
    onStatus(false);
    await vi.waitFor(() => expect(data.auth.state().signedIn).toBe(true));
    expect(client.setAuth).toHaveBeenCalledTimes(2);
  });

  // A token the way Convex Auth issues one, expiring `seconds` from now.
  const jwt = (seconds) =>
    `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url")}.s`;
  const member = (seconds) => memoryStorage({
    "forge-auth-token": jwt(seconds),
    "forge-auth-refresh": "member-refresh",
    "forge-auth-kind": "member",
  });

  // Every refresh rotates the refresh token, and a page that comes back two
  // rotations behind is one Convex Auth ends the session for. Coming back to
  // the app used to rotate it twice on every glance.
  test("coming back to the app leaves a session the live client holds alone", async () => {
    const { client, http, data } = harness({ storage: member(3600) });
    await data.ready;
    const [, onStatus] = client.setAuth.mock.calls[0];
    onStatus(true);
    await data.auth.resume();
    await data.auth.resume();
    expect(http.calls.filter((call) => call.args.refreshToken)).toEqual([]);
    expect(client.setAuth).toHaveBeenCalledTimes(1);
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "member" });
  });

  // The live client refreshes a token it holds before it runs out, and again
  // when the deployment turns one down. Handing it the session over the top
  // of that is what stranded its socket.
  test("coming back leaves a token about to run out to the live client that holds it", async () => {
    const { client, http, data } = harness({ storage: member(60) });
    await data.ready;
    const [, onStatus] = client.setAuth.mock.calls[0];
    onStatus(true);
    await data.auth.resume();
    expect(http.calls.filter((call) => call.args.refreshToken)).toEqual([]);
    expect(client.setAuth).toHaveBeenCalledTimes(1);
  });

  test("coming back leaves a session the live client is still confirming alone", async () => {
    const { client, http, data } = harness({ storage: member(3600) });
    await data.ready;
    await data.auth.resume();
    expect(http.calls.filter((call) => call.args.refreshToken)).toEqual([]);
    expect(client.setAuth).toHaveBeenCalledTimes(1);
  });

  test("coming back refreshes a session the live client let go of, and hands it back", async () => {
    const { client, http, data } = harness({ storage: member(3600) });
    await data.ready;
    const [, onStatus] = client.setAuth.mock.calls[0];
    onStatus(false);
    await data.auth.resume();
    expect(http.calls.filter((call) => call.args.refreshToken)).toHaveLength(1);
    expect(client.setAuth).toHaveBeenCalledTimes(2);
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "member" });
  });

  test("a saved token that has run out is refreshed before the live client is given it", async () => {
    const { client, http, data } = harness({ storage: member(-60) });
    await data.ready;
    const [fetchToken] = client.setAuth.mock.calls[0];
    expect(await fetchToken({ forceRefreshToken: false })).toBe("refreshed-token");
    expect(http.calls.filter((call) => call.args.refreshToken)).toHaveLength(1);
  });

  // A refresh the network swallowed held the live client, and the member,
  // for as long as it never answered.
  test("a refresh that never answers fails like an outage, and the session is kept", async () => {
    const storage = member(3600);
    const client = fakeClient();
    const http = {
      setAuth() {},
      clearAuth() {},
      action: vi.fn((fn, args) => (args.refreshToken ? new Promise(() => {}) : Promise.reject(new Error("unexpected")))),
    };
    const data = createForgeData({ client, httpClient: http, storage, api, wait: async () => {}, refreshTimeoutMs: 20 });
    await data.ready;
    const [fetchToken] = client.setAuth.mock.calls[0];
    expect(await fetchToken({ forceRefreshToken: true })).toBeNull();
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "member" });
    expect(storage.getItem("forge-auth-refresh")).toBe("member-refresh");
  });

  test("a refresh presents the newest saved refresh token, even one another tab wrote", async () => {
    const storage = member(3600);
    const { client, http, data } = harness({ storage });
    await data.ready;
    // Another tab of the app rotated the shared session in the meantime.
    storage.setItem("forge-auth-refresh", "other-tab-refresh");
    storage.setItem("forge-auth-token", "other-tab-token");
    const [fetchToken] = client.setAuth.mock.calls[0];
    expect(await fetchToken({ forceRefreshToken: true })).toBe("refreshed-token");
    expect(http.calls.at(-1).args).toEqual({ refreshToken: "other-tab-refresh" });
    expect(storage.getItem("forge-auth-refresh")).toBe("refreshed-refresh");
  });

  test("signing out does not wait on the deployment to let the session go", async () => {
    let stall;
    const { data, http } = harness({
      storage: memoryStorage(stored("member", "member")),
      handler: async (fn, args) => {
        // The revoke never answers, as a slow or unreachable deployment.
        if (fn === "auth:signOut") return new Promise((resolve) => { stall = resolve; });
        if (args.provider === "anonymous") return { tokens: tokens("guest") };
        throw new Error(`unexpected call ${fn}`);
      },
    });
    await data.ready;
    await data.auth.signOut();
    expect(http.calls[0]).toEqual({ fn: "auth:signOut", args: {}, auth: "member-token" });
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "guest" });
    stall?.();
  });

  test("signing out revokes the session and starts a new guest", async () => {
    const { client, http, data } = harness({ storage: memoryStorage(stored("member", "member")) });
    await data.ready;
    const seen = [];
    data.auth.onChange((snapshot) => seen.push(snapshot));
    await data.auth.signOut();
    expect(http.calls[0]).toEqual({ fn: "auth:signOut", args: {}, auth: "member-token" });
    expect(seen).toEqual([
      { signedIn: false, kind: null },
      { signedIn: true, kind: "guest" },
    ]);
    expect(client.client.clearAuth).toHaveBeenCalledTimes(1);
  });
});

describe("sign-in providers", () => {
  test("email sign-in requests a magic link back to the app root and drops stale verifiers", async () => {
    const storage = memoryStorage({ "forge-auth-verifier": "abandoned" });
    const { http, data } = harness({ storage });
    await data.ready;
    expect(await data.auth.signInWithEmail("me@example.com")).toBe(true);
    expect(http.calls.at(-1)).toEqual({
      fn: "auth:signIn",
      args: { provider: "resend", params: { email: "me@example.com", redirectTo: "/" } },
      auth: "guest-token",
    });
    expect(storage.dump()["forge-auth-verifier"]).toBeUndefined();
  });

  test.each(["google", "apple"])("%s sign-in saves the verifier and follows the redirect", async (provider) => {
    const { http, storage, data, navigate } = harness();
    await data.ready;
    const redirect = await data.auth.signInWith(provider);
    expect(redirect).toBe(`https://x.convex.site/api/auth/signin/${provider}?code=v-${provider}`);
    expect(http.calls.at(-1)).toEqual({
      fn: "auth:signIn",
      args: { provider, params: { redirectTo: "/" } },
      auth: "guest-token",
    });
    expect(storage.dump()["forge-auth-verifier"]).toBe(`v-${provider}`);
    expect(navigate).toHaveBeenCalledWith(redirect);
  });

  test("a provider that does not redirect is reported", async () => {
    const { data } = harness({
      handler: async (fn, args) =>
        args.provider === "anonymous" ? { tokens: tokens("guest") } : { started: false },
    });
    await data.ready;
    await expect(data.auth.signInWith("google")).rejects.toThrow("did not start");
  });
});

describe("data access", () => {
  test("account, site, message, domain, billing, settings, and memory calls target the right functions", async () => {
    const { client, data } = harness();
    await data.ready;
    const callback = () => {};
    data.account.subscribe(callback);
    data.account.providers(callback);
    data.sites.subscribe(callback);
    data.messages.subscribe("c1", callback);
    data.domains.subscribe(callback);
    data.billing.subscribe(callback);
    data.billing.catalog(callback);
    data.billing.history(callback);
    data.settings.subscribe(callback);
    data.memory.subscribe(callback);
    data.diagnostics.subscribe(callback);
    data.sites.currentHtml("s1", callback);
    await data.account.updateProfile("Sam");
    await data.sites.create();
    await data.sites.create("Bakery");
    await data.sites.rename("s1", "Shop");
    await data.sites.remove("s1");
    await data.messages.send("c1", "hi");
    await data.domains.add("s1", "shop.example");
    await data.domains.remove("d1");
    await data.settings.update({ theme: "light" });
    await data.memory.forget("m1");
    await data.memory.forgetAll();
    await data.sites.publish("s1");
    await data.sites.unpublish("s1");
    await data.billing.checkout({ plan: "pro" });
    await data.billing.cancel();
    await data.billing.resume();
    await data.billing.portal();
    await data.sites.generate("c1", "make it warm");
    expect(client.onUpdate.mock.calls).toEqual([
      ["users:me", {}, callback],
      ["users:providers", {}, callback],
      ["sites:list", {}, callback],
      ["messages:list", { conversationId: "c1" }, callback],
      ["domains:list", {}, callback],
      ["billing:summary", {}, callback],
      ["billing:catalog", {}, callback],
      ["billing:history", {}, callback],
      ["settings:get", {}, callback],
      ["memory:list", {}, callback],
      ["diagnostics:mine", {}, callback, undefined],
      ["sites:currentHtml", { siteId: "s1" }, callback],
    ]);
    expect(client.mutation.mock.calls).toEqual([
      ["users:updateProfile", { name: "Sam" }],
      ["sites:create", {}],
      ["sites:create", { name: "Bakery" }],
      ["sites:rename", { id: "s1", name: "Shop" }],
      ["sites:remove", { id: "s1" }],
      ["messages:send", { conversationId: "c1", body: "hi" }],
      ["domains:add", { siteId: "s1", hostname: "shop.example" }],
      ["domains:remove", { id: "d1" }],
      ["settings:update", { theme: "light" }],
      ["memory:forget", { id: "m1" }],
      ["memory:forgetAll", {}],
      ["sites:publish", { id: "s1" }],
      ["sites:unpublish", { id: "s1" }],
    ]);
    expect(client.action.mock.calls).toEqual([
      ["billing:checkout", { plan: "pro" }],
      ["billing:cancel", {}],
      ["billing:resume", {}],
      ["billing:portal", {}],
      ["generate:run", { conversationId: "c1", prompt: "make it warm" }],
    ]);
  });

  test("deleting the account removes it on the server, then starts a fresh guest session", async () => {
    const { client, http, data } = harness({ storage: memoryStorage(stored("member", "member")) });
    await data.ready;
    const before = http.calls.length;
    await data.account.deleteAccount();
    expect(client.mutation.mock.calls).toEqual([["users:deleteAccount", {}]]);
    expect(http.calls.slice(before).map((call) => call.fn)).toEqual(["auth:signOut", "auth:signIn"]);
    expect(data.auth.state()).toEqual({ signedIn: true, kind: "guest" });
  });
});

// The session lifecycle against the real live client. The fake above records
// what data.js asks of it; these run Convex's own auth state machine and
// socket over a stand-in deployment, which is where a reload with an expired
// token used to strand a member on "Signing you back in…" for good.
describe("the live client through a restore", () => {
  const MEMBER = { _id: "u1", name: "Sam", email: "sam@example.com", image: null, isAnonymous: false };
  let issued = 0;
  // A token the way Convex Auth issues one, expiring `seconds` from now. No
  // two are alike, as no two real ones are.
  const jwt = (seconds) => {
    const now = Math.floor(Date.now() / 1000);
    issued += 1;
    const claims = { sub: "u1", iat: now, exp: now + seconds, jti: issued };
    return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  };
  const lifeOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp * 1000 - Date.now();
  const u64 = (n) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(n));
    return bytes.toString("base64");
  };

  // Just enough of a deployment's sync protocol for users.me: it answers a
  // query, accepts a live token, and turns down one that has run out or that
  // it has been told to refuse.
  function fakeDeployment({ turnsDown = new Set() } = {}) {
    const heard = [];
    class Socket {
      constructor() {
        this.readyState = 0;
        this.version = { querySet: 0, identity: 0, ts: 0 };
        this.queries = new Map();
        this.signedIn = false;
        setTimeout(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.onopen?.();
        }, 1);
      }
      send(raw) {
        const message = JSON.parse(raw);
        setTimeout(() => this.receive(message), 1);
      }
      close() {
        if (this.readyState >= 2) return;
        this.readyState = 3;
        setTimeout(() => this.onclose?.({ code: 1000, reason: "" }), 0);
      }
      emit(message) {
        if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) });
      }
      answers(queryIds) {
        return queryIds.map((queryId) => ({
          type: "QueryUpdated",
          queryId,
          value: this.queries.get(queryId) === "users:me" && this.signedIn ? MEMBER : null,
          logLines: [],
          journal: null,
        }));
      }
      step(querySet, identity, modifications) {
        const startVersion = { ...this.version, ts: u64(this.version.ts) };
        this.version = { querySet, identity, ts: this.version.ts + 1 };
        this.emit({ type: "Transition", startVersion, endVersion: { ...this.version, ts: u64(this.version.ts) }, modifications });
      }
      receive(message) {
        if (this.readyState !== 1) return;
        if (message.type === "Authenticate") {
          const user = message.tokenType === "User";
          const accepted = user && lifeOf(message.value) > 0 && !turnsDown.has(message.value);
          if (user) heard.push({ token: message.value, accepted });
          if (user && !accepted) {
            this.emit({ type: "AuthError", error: "Token expired", baseVersion: message.baseVersion, authUpdateAttempted: true });
            return;
          }
          this.signedIn = accepted;
          this.step(this.version.querySet, message.baseVersion + 1, this.answers([...this.queries.keys()]));
        } else if (message.type === "ModifyQuerySet") {
          const added = [];
          for (const change of message.modifications) {
            if (change.type === "Add") {
              this.queries.set(change.queryId, change.udfPath);
              added.push(change.queryId);
            } else this.queries.delete(change.queryId);
          }
          this.step(message.newVersion, this.version.identity, this.answers(added));
        }
      }
    }
    return { Socket, heard };
  }

  // Refreshes answer with a fresh token, once `hold` lets them.
  function refreshingHttp({ hold } = {}) {
    const http = { auth: null, calls: [] };
    http.setAuth = (value) => {
      http.auth = value;
    };
    http.clearAuth = () => {
      http.auth = null;
    };
    http.action = vi.fn(async (fn, args) => {
      http.calls.push({ fn, args });
      if (!args.refreshToken) throw new Error(`unexpected call ${JSON.stringify(args)}`);
      await hold?.();
      return { tokens: { token: jwt(3600), refreshToken: `member-refresh-${http.calls.length}` } };
    });
    http.query = vi.fn(async () => MEMBER);
    http.refreshes = () => http.calls.filter((call) => call.args.refreshToken).length;
    return http;
  }

  function restore({ token, turnsDown, hold }) {
    const deployment = fakeDeployment({ turnsDown });
    const http = refreshingHttp({ hold });
    const client = new ConvexClient("https://forge-test.convex.cloud", {
      ...LIVE_CLIENT_OPTIONS,
      webSocketConstructor: deployment.Socket,
      unsavedChangesWarning: false,
      logger: false,
    });
    const storage = memoryStorage({
      "forge-auth-token": token,
      "forge-auth-refresh": "member-refresh",
      "forge-auth-kind": "member",
    });
    const data = createForgeData({ client, httpClient: http, storage, api, wait: async () => {} });
    const seen = [];
    data.account.subscribe((user) => seen.push(user));
    return { deployment, http, client, data, seen };
  }

  test("a saved token that has run out is refreshed before the socket presents it", async () => {
    const { deployment, http, client, data, seen } = restore({ token: jwt(-60) });
    await data.ready;
    // browser.js resumes on `pageshow`, which fires on every load.
    void data.auth.resume();
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(MEMBER), { timeout: 3000 });
    expect(deployment.heard.map((entry) => entry.accepted)).toEqual([true]);
    expect(http.refreshes()).toBe(1);
    await client.close();
  });

  // The reload that never finished. Coming back into view handed the live
  // client the session again while it was replacing a token the deployment
  // had just turned down; it dropped that replacement as out of date and left
  // its socket stopped, so users.me never answered.
  test("coming back while the socket replaces a token the deployment turned down leaves it to finish", async () => {
    const saved = jwt(1800);
    let answer;
    const held = new Promise((resolve) => {
      answer = resolve;
    });
    const { deployment, http, client, data, seen } = restore({ token: saved, turnsDown: new Set([saved]), hold: () => held });
    await data.ready;
    const resumed = data.auth.resume();
    await vi.waitFor(() => expect(deployment.heard).toEqual([{ token: saved, accepted: false }]));
    await vi.waitFor(() => expect(http.refreshes()).toBe(1));
    answer();
    await resumed;
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(MEMBER), { timeout: 3000 });
    expect(deployment.heard.at(-1).accepted).toBe(true);
    await client.close();
  });
});

// A hand-written fake can quietly offer more than the thing it stands in for.
// That is how a sign-out that threw on every attempt sat behind a green suite,
// so the surface data.js relies on is checked against the real clients here.
describe("the Convex client surface data.js relies on", () => {
  test("every method called on the live client exists", () => {
    for (const name of ["setAuth", "onUpdate", "mutation", "action"]) {
      expect(typeof ConvexClient.prototype[name]).toBe("function");
    }
  });

  test("every method called on the HTTP client exists", () => {
    for (const name of ["setAuth", "clearAuth", "action"]) {
      expect(typeof ConvexHttpClient.prototype[name]).toBe("function");
    }
  });

  test("clearing auth on the live client still has somewhere to reach", () => {
    // ConvexClient has no clearAuth of its own, so data.js goes through the
    // base client. Both halves of that have to keep existing, or signing out
    // silently falls back to a null token fetcher.
    const reachable =
      typeof ConvexClient.prototype.clearAuth === "function" ||
      (Boolean(Object.getOwnPropertyDescriptor(ConvexClient.prototype, "client")) &&
        typeof BaseConvexClient.prototype.clearAuth === "function");
    expect(reachable).toBe(true);
  });
});
