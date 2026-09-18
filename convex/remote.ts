"use node";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { Client } from "ssh2";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { workspaceEnvironment, workspaceProtocol } from "./shapes";

// Credentials are sealed with a key held only by the deployment, so a stored
// workspace is useless to anyone reading the table and nothing goes back to a
// browser. Set it once with:
//   npx convex env set WORKSPACE_KEY "$(openssl rand -base64 32)"
function sealingKey() {
  const raw = process.env.WORKSPACE_KEY;
  if (!raw) {
    throw new ConvexError(
      "This deployment has no WORKSPACE_KEY, so credentials cannot be stored safely",
    );
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new ConvexError("WORKSPACE_KEY must be 32 bytes of base64");
  return bytes;
}

function seal(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

function unseal(sealed: string) {
  const [iv, tag, body] = sealed.split(".");
  if (!iv || !tag || !body) throw new ConvexError("Stored credential is unreadable");
  const decipher = createDecipheriv("aes-256-gcm", sealingKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

type Credential = { privateKey?: string; passphrase?: string; password?: string };

const credentialArgs = {
  privateKey: v.optional(v.string()),
  passphrase: v.optional(v.string()),
  password: v.optional(v.string()),
};

function tidy(credential: Credential): Credential {
  const privateKey = credential.privateKey?.trim();
  const password = credential.password?.trim();
  const passphrase = credential.passphrase?.trim();
  return {
    ...(privateKey ? { privateKey } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(password ? { password } : {}),
  };
}

// ssh2 reports a failed handshake through an error event rather than a
// rejection, so the attempt is wrapped to settle exactly once either way.
function probe(
  target: { protocol: "ssh" | "sftp"; host: string; port: number; username: string },
  credential: Credential,
) {
  return new Promise<void>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* Already torn down. */
      }
      if (error) reject(error);
      else resolve();
    };
    client.on("ready", () => {
      // SFTP workspaces are file-only, so opening the subsystem is the check.
      if (target.protocol === "sftp") {
        client.sftp((error) => finish(error));
        return;
      }
      client.exec("true", (error, stream) => {
        if (error) return finish(error);
        stream.on("close", () => finish());
        stream.on("error", (streamError: Error) => finish(streamError));
        stream.resume();
      });
    });
    client.on("error", (error) => finish(error));
    client.on("timeout", () => finish(new Error("The server did not respond in time")));
    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        readyTimeout: 15000,
        keepaliveInterval: 0,
        ...credential,
      });
    } catch (error) {
      finish(error as Error);
    }
  });
}

function reason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Never echo a key or password back through an error string.
  return message.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[private key]").slice(0, 200);
}

function validate(host: string, port: number, username: string, credential: Credential) {
  if (!host.trim()) throw new ConvexError("Enter the server's hostname or IP address");
  if (!username.trim()) throw new ConvexError("Enter the username to sign in with");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConvexError("Port must be a whole number between 1 and 65535");
  }
  if (!credential.privateKey && !credential.password) {
    throw new ConvexError("Add a private key or a password");
  }
}

export const test = action({
  args: {
    protocol: workspaceProtocol,
    host: v.string(),
    port: v.number(),
    username: v.string(),
    ...credentialArgs,
  },
  handler: async (_ctx, { protocol, host, port, username, ...rest }) => {
    const credential = tidy(rest);
    validate(host, port, username, credential);
    try {
      await probe({ protocol, host: host.trim(), port, username: username.trim() }, credential);
      return { ok: true as const, message: `Reached ${username.trim()}@${host.trim()}:${port}` };
    } catch (error) {
      return { ok: false as const, message: reason(error) };
    }
  },
});

export const create = action({
  args: {
    name: v.string(),
    protocol: workspaceProtocol,
    host: v.string(),
    port: v.number(),
    username: v.string(),
    environment: v.optional(workspaceEnvironment),
    ...credentialArgs,
  },
  handler: async (
    ctx,
    { name, protocol, host, port, username, environment, ...rest },
  ): Promise<Id<"workspaces">> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const credential = tidy(rest);
    validate(host, port, username, credential);
    const label = name.trim();
    if (!label) throw new ConvexError("Give the workspace a name");
    return await ctx.runMutation(internal.workspaces.save, {
      userId,
      name: label,
      protocol,
      host: host.trim(),
      port,
      username: username.trim(),
      environment,
      authKind: credential.privateKey ? ("key" as const) : ("password" as const),
      secret: seal(JSON.stringify(credential)),
    });
  },
});

// Connecting is a real handshake against the server: it only reports connected
// once the credentials actually opened a session.
export const connect = action({
  args: { id: v.id("workspaces") },
  handler: async (ctx, { id }): Promise<{ ok: boolean; message: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const workspace = await ctx.runQuery(internal.workspaces.credentialFor, {
      id: id as Id<"workspaces">,
      userId,
    });
    const credential: Credential = JSON.parse(unseal(workspace.secret));
    try {
      await probe(
        {
          protocol: workspace.protocol,
          host: workspace.host,
          port: workspace.port,
          username: workspace.username,
        },
        credential,
      );
    } catch (error) {
      const message = reason(error);
      await ctx.runMutation(internal.workspaces.markConnected, {
        id,
        userId,
        connected: false,
        error: message,
      });
      return { ok: false, message };
    }
    await ctx.runMutation(internal.workspaces.markConnected, { id, userId, connected: true });
    return { ok: true, message: `Connected to ${workspace.username}@${workspace.host}` };
  },
});

// Cloudways keeps each application under ~/applications/<app>/public_html; a
// plain server usually keeps them under /var/www. Both are listed, and the doc
// root is preferred over the wrapper directory when one exists.
const LIST_APPS = [
  'list() {',
  '  base="$1"',
  '  [ -d "$base" ] || return 0',
  '  for d in "$base"/*/; do',
  '    [ -d "$d" ] || continue',
  '    root="${d%/}"',
  '    name="$(basename "$root")"',
  '    if [ -d "$root/public_html" ]; then root="$root/public_html"; fi',
  "    printf '%s\\t%s\\n' \"$name\" \"$root\"",
  '  done',
  '}',
  'list "$HOME/applications"',
  'list /var/www',
].join("\n");

type App = { name: string; path: string };

function parseApps(output: string): App[] {
  const seen = new Set<string>();
  const apps: App[] = [];
  for (const line of output.split("\n")) {
    const [name, path] = line.split("\t");
    if (!name?.trim() || !path?.trim() || seen.has(path)) continue;
    seen.add(path);
    apps.push({ name: name.trim(), path: path.trim() });
    if (apps.length >= 200) break;
  }
  return apps;
}

// SFTP workspaces cannot run a command, so the same two locations are walked
// over the file protocol instead.
function sftpApps(client: Client): Promise<App[]> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error || !sftp) return reject(error ?? new Error("Could not open SFTP"));
      const readdir = (path: string) =>
        new Promise<{ filename: string; longname: string; attrs: { isDirectory(): boolean } }[]>(
          (done) => sftp.readdir(path, (listError, list) => done(listError ? [] : (list as never))),
        );
      const exists = (path: string) =>
        new Promise<boolean>((done) => sftp.stat(path, (statError) => done(!statError)));
      sftp.realpath(".", async (pathError, home) => {
        if (pathError) return reject(pathError);
        const apps: App[] = [];
        for (const base of [`${home.replace(/\/$/, "")}/applications`, "/var/www"]) {
          for (const entry of await readdir(base)) {
            if (!entry.attrs.isDirectory()) continue;
            const root = `${base}/${entry.filename}`;
            const docRoot = (await exists(`${root}/public_html`)) ? `${root}/public_html` : root;
            apps.push({ name: entry.filename, path: docRoot });
            if (apps.length >= 200) break;
          }
        }
        resolve(apps);
      });
    });
  });
}

function sshApps(client: Client): Promise<App[]> {
  return new Promise((resolve, reject) => {
    client.exec(LIST_APPS, (error, stream) => {
      if (error) return reject(error);
      let output = "";
      stream.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      stream.stderr.resume();
      stream.on("error", (streamError: Error) => reject(streamError));
      stream.on("close", () => resolve(parseApps(output)));
    });
  });
}

// Deliberately a separate session from `probe`: the connection check is the
// proven path and is left untouched.
function collectApps(
  target: { protocol: "ssh" | "sftp"; host: string; port: number; username: string },
  credential: Credential,
) {
  return new Promise<App[]>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error?: Error | null, value?: App[]) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* Already torn down. */
      }
      if (error) reject(error);
      else resolve(value ?? []);
    };
    client.on("ready", () => {
      const work = target.protocol === "sftp" ? sftpApps(client) : sshApps(client);
      work.then((apps) => finish(null, apps), (error) => finish(error));
    });
    client.on("error", (error) => finish(error));
    client.on("timeout", () => finish(new Error("The server did not respond in time")));
    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        readyTimeout: 15000,
        keepaliveInterval: 0,
        ...credential,
      });
    } catch (error) {
      finish(error as Error);
    }
  });
}

// Every login re-reads the server rather than trusting the cache, so the list
// reflects apps added or removed since last time.
export const scanApps = action({
  args: { id: v.id("workspaces") },
  handler: async (ctx, { id }): Promise<{ ok: boolean; count: number; message: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const workspace = await ctx.runQuery(internal.workspaces.credentialFor, {
      id: id as Id<"workspaces">,
      userId,
    });
    const credential: Credential = JSON.parse(unseal(workspace.secret));
    try {
      const found = await collectApps(
        {
          protocol: workspace.protocol,
          host: workspace.host,
          port: workspace.port,
          username: workspace.username,
        },
        credential,
      );
      await ctx.runMutation(internal.apps.replaceForWorkspace, {
        userId,
        workspaceId: id,
        found,
      });
      return {
        ok: true,
        count: found.length,
        message: found.length
          ? `Found ${found.length} app${found.length === 1 ? "" : "s"}`
          : "No applications found on that server",
      };
    } catch (error) {
      return { ok: false, count: 0, message: reason(error) };
    }
  },
});
