// End-to-end check against a running Convex deployment:
//   node scripts/smoke-convex.mjs https://polished-ram-883.convex.cloud
// Uses the HTTP client only, so it works anywhere Node can reach the deployment.
import { ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";

const url = process.argv[2] ?? process.env.CONVEX_URL;
if (!url) {
  console.error("usage: node scripts/smoke-convex.mjs <deployment url>");
  process.exit(2);
}

const client = new ConvexHttpClient(url);
const steps = [];
function check(label, ok, detail) {
  steps.push(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(label);
}

try {
  check("signed-out list is empty", (await client.query(api.conversations.list, {})).length === 0);

  const signedIn = await client.action(api.auth.signIn, { provider: "anonymous" });
  check("anonymous sign-in issues tokens", Boolean(signedIn?.tokens?.token));
  client.setAuth(signedIn.tokens.token);

  const id = await client.mutation(api.conversations.create, { title: "Smoke test" });
  check("create conversation", typeof id === "string", id);

  await client.mutation(api.messages.send, { conversationId: id, body: "hello from smoke test" });
  const messages = await client.query(api.messages.list, { conversationId: id });
  check(
    "message persisted",
    messages.length === 1 && messages[0].body === "hello from smoke test" && messages[0].role === "user",
  );

  const conversations = await client.query(api.conversations.list, {});
  check("conversation listed for owner", conversations.some((c) => c._id === id));

  await client.mutation(api.conversations.rename, { id, title: "Smoke test (renamed)" });
  const renamed = await client.query(api.conversations.list, {});
  check("rename applied", renamed.find((c) => c._id === id)?.title === "Smoke test (renamed)");

  await client.mutation(api.conversations.remove, { id });
  check("delete removes conversation", !(await client.query(api.conversations.list, {})).some((c) => c._id === id));
  check("delete removes messages", (await client.query(api.messages.list, { conversationId: id })).length === 0);

  await client.action(api.auth.signOut, {});
  client.clearAuth();
  check("signed-out again", (await client.query(api.conversations.list, {})).length === 0);
} finally {
  console.log(steps.join("\n"));
}
console.log(`\nAll checks passed against ${url}`);
