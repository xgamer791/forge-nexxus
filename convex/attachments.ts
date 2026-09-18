import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireMemberId, requireOwnedConversation } from "./access";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { pdfText } from "./pdfText";

// What Forge can actually use. An image goes to the model as a picture; a text
// file goes as its contents. Anything else is refused at upload rather than
// stored and silently ignored, so the user is told before they wait.
const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",
];
const TEXT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "text/javascript",
  "application/json",
  "application/xml",
  "text/xml",
  "application/pdf",
  // SVG is markup, so the model reads it rather than looking at it.
  "image/svg+xml",
];
const TEXT_EXTENSIONS = ["txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "css", "js", "svg", "pdf"];

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_PENDING = 8;
// How much of one file the model is given, and how much of all of them.
export const TEXT_LIMIT = 20000;
export const TEXT_TOTAL_LIMIT = 60000;
// How many pictures one turn sends to be looked at. Later turns can still use
// every attached image by its URL; this caps what is re-examined each time.
export const VISION_LIMIT = 4;

const extensionOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";

export function classify(mimeType: string, name: string): "image" | "text" | null {
  const type = mimeType.toLowerCase().split(";")[0].trim();
  if (type === "image/svg+xml") return "text";
  if (IMAGE_TYPES.includes(type)) return "image";
  if (TEXT_TYPES.includes(type) || type.startsWith("text/")) return "text";
  // Browsers leave the type empty for some files; fall back to the name.
  if (!type || type === "application/octet-stream") {
    const extension = extensionOf(name);
    if (TEXT_EXTENSIONS.includes(extension)) return "text";
    if (["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "avif"].includes(extension)) return "image";
  }
  return null;
}

export function cleanName(name: string) {
  return name.replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || "file";
}

// Everything a file has to pass, checked in one place. A mutation that throws
// rolls back its own writes, storage deletes included, so a refusal has to
// happen before the bytes are uploaded rather than after.
async function check(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  name: string,
  mimeType: string,
  size: number,
) {
  const clean = cleanName(name);
  const kind = classify(mimeType, clean);
  if (!kind) {
    throw new ConvexError(`Forge can use images, text files and PDFs. "${clean}" isn't one of those.`);
  }
  if (size > MAX_BYTES) {
    throw new ConvexError(`"${clean}" is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`);
  }
  if ((await pendingFor(ctx, conversationId)).length >= MAX_PENDING) {
    throw new ConvexError(`You can attach ${MAX_PENDING} files at a time. Send these first.`);
  }
  return { clean, kind };
}

// Where the browser POSTs the bytes. The file is judged here, before it is
// uploaded, so a refusal costs the user nothing and leaves nothing behind.
// Attachments are for building, so this is members only.
export const uploadUrl = mutation({
  args: {
    conversationId: v.id("conversations"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, { conversationId, name, mimeType, size }) => {
    await requireMemberId(ctx);
    await requireOwnedConversation(ctx, conversationId);
    await check(ctx, conversationId, name, mimeType, size);
    return await ctx.storage.generateUploadUrl();
  },
});

// Records an uploaded file against a build thread.
export const attach = mutation({
  args: {
    conversationId: v.id("conversations"),
    storageId: v.id("_storage"),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, { conversationId, storageId, name, mimeType, size }) => {
    const userId = await requireMemberId(ctx);
    await requireOwnedConversation(ctx, conversationId);
    const { clean, kind } = await check(ctx, conversationId, name, mimeType, size);
    const id = await ctx.db.insert("attachments", {
      userId,
      conversationId,
      storageId,
      name: clean,
      mimeType: mimeType.slice(0, 120),
      size,
      kind,
      createdAt: Date.now(),
    });
    // Reading the file needs the bytes, which only an action can hold.
    if (kind === "text") await ctx.scheduler.runAfter(0, internal.attachments.read, { id });
    return id;
  },
});

// What the composer shows. Empty for guests and for anyone else's thread, since
// this backs a subscription rather than a click.
export const list = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const userId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(conversationId);
    if (!userId || !conversation || conversation.userId !== userId) return [];
    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .order("asc")
      .collect();
    return await Promise.all(rows.map((row) => present(ctx, row)));
  },
});

export const remove = mutation({
  args: { id: v.id("attachments") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    const row = userId ? await ctx.db.get(id) : null;
    if (!row || row.userId !== userId) throw new ConvexError("Attachment not found");
    if (row.messageId) throw new ConvexError("This file has already gone to Forge.");
    await deleteAttachment(ctx, row);
  },
});

// Pulls the words out of a readable file once, so the model is handed text
// rather than a link it would have to fetch.
export const read = internalAction({
  args: { id: v.id("attachments") },
  handler: async (ctx, { id }) => {
    const row = await ctx.runQuery(internal.attachments.forRead, { id });
    if (!row) return;
    let text = "";
    let error: string | undefined;
    try {
      const blob = await ctx.storage.get(row.storageId);
      if (!blob) throw new Error("The upload is gone");
      const buffer = await blob.arrayBuffer();
      text = row.mimeType.toLowerCase().includes("pdf")
        ? await pdfText(buffer, TEXT_LIMIT)
        : new TextDecoder("utf-8", { fatal: false }).decode(buffer).slice(0, TEXT_LIMIT);
      text = text.replace(/\u0000/g, "").trim();
      if (!text) error = "No text could be read from this file.";
    } catch {
      error = "This file could not be read.";
    }
    await ctx.runMutation(internal.attachments.setText, { id, text: text || undefined, error });
  },
});

export const forRead = internalQuery({
  args: { id: v.id("attachments") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

export const setText = internalMutation({
  args: { id: v.id("attachments"), text: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, { id, text, error }) => {
    if (!(await ctx.db.get(id))) return;
    await ctx.db.patch(id, { text, textError: error });
  },
});

async function present(ctx: QueryCtx, row: Doc<"attachments">) {
  const { storageId, userId: _owner, text, ...rest } = row;
  return {
    ...rest,
    url: await ctx.storage.getUrl(storageId),
    // The thread says whether a file was read, never the whole file back.
    readable: typeof text === "string" && text.length > 0,
  };
}

export async function pendingFor(ctx: QueryCtx | MutationCtx, conversationId: Id<"conversations">) {
  const rows = await ctx.db
    .query("attachments")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  return rows.filter((row) => row.messageId === undefined);
}

export async function deleteAttachment(ctx: MutationCtx, row: Doc<"attachments">) {
  await ctx.storage.delete(row.storageId).catch(() => {
    /* Already gone; the row still has to go. */
  });
  await ctx.db.delete(row._id);
}

// Deleting a thread, a site or an account takes the files with it: an orphaned
// blob is a user's photo left on our disk.
export async function deleteAttachmentsFor(ctx: MutationCtx, conversationId: Id<"conversations">) {
  const rows = await ctx.db
    .query("attachments")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .collect();
  for (const row of rows) await deleteAttachment(ctx, row);
}

export async function deleteAttachmentsOf(ctx: MutationCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("attachments")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of rows) await deleteAttachment(ctx, row);
}

// An upload URL can be used and then abandoned: the browser sends the bytes and
// the tab closes before `attach` records them. Nothing points at those blobs and
// nothing ever will, so a daily sweep removes the ones old enough to be sure.
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

export const sweep = internalMutation({
  // The cron passes nothing; a caller can name its own cutoff.
  args: { before: v.optional(v.number()) },
  handler: async (ctx, { before }) => {
    const cutoff = before ?? Date.now() - ORPHAN_AGE_MS;
    const known = new Set(
      (await ctx.db.query("attachments").collect()).map((row) => String(row.storageId)),
    );
    const files = await ctx.db.system.query("_storage").collect();
    let removed = 0;
    for (const file of files) {
      if (known.has(String(file._id)) || file._creationTime > cutoff) continue;
      await ctx.storage.delete(file._id);
      removed += 1;
    }
    return removed;
  },
});
