// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import { createForgeData } from "./data.js";

const api = {
  auth: { signIn: "auth:signIn", signOut: "auth:signOut" },
  users: { me: "users:me" },
  conversations: {
    list: "conversations:list",
    create: "conversations:create",
    rename: "conversations:rename",
    remove: "conversations:remove",
  },
  messages: { list: "messages:list", send: "messages:send" },
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

function fakeClient() {
  return {
    setAuth: vi.fn(),
    clearAuth: vi.fn(),
    onUpdate: vi.fn(() => vi.fn()),
    mutation: vi.fn(),
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

  test("a rejected session falls back to a fresh guest", async () => {
    const { client, data } = harness({
      handler: async (fn, args) => {
        if (args.refreshToken) throw new Error("revoked");
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
    expect(client.clearAuth).toHaveBeenCalledTimes(1);
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
  test("account, conversation, and message calls target the right functions", async () => {
    const { client, data } = harness();
    await data.ready;
    const callback = () => {};
    data.account.subscribe(callback);
    data.conversations.subscribe(callback);
    data.messages.subscribe("c1", callback);
    await data.conversations.create();
    await data.conversations.create("Titled");
    await data.conversations.rename("c1", "New");
    await data.conversations.remove("c1");
    await data.messages.send("c1", "hi");
    expect(client.onUpdate.mock.calls).toEqual([
      ["users:me", {}, callback],
      ["conversations:list", {}, callback],
      ["messages:list", { conversationId: "c1" }, callback],
    ]);
    expect(client.mutation.mock.calls).toEqual([
      ["conversations:create", {}],
      ["conversations:create", { title: "Titled" }],
      ["conversations:rename", { id: "c1", title: "New" }],
      ["conversations:remove", { id: "c1" }],
      ["messages:send", { conversationId: "c1", body: "hi" }],
    ]);
  });
});
