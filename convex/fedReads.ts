import { v } from "convex/values";
import { FED } from "./fed";
import { internalMutation, internalQuery } from "./_generated/server";

export const fedSource = v.union(
  v.literal("chat"),
  v.literal("build"),
  v.literal("strategy"),
  v.literal("rebuild"),
);

export type FedSource = "chat" | "build" | "strategy" | "rebuild";

const statsValidator = v.object({
  count: v.number(),
  lastTriggeredAt: v.union(v.number(), v.null()),
  lastTriggered: v.union(v.string(), v.null()),
  lastSource: v.union(fedSource, v.null()),
  opened: v.boolean(),
});

export function messagesOpenFed(messages: { role: string; content: string }[]): boolean {
  return messages.some((message) => message.role === "system" && message.content === FED);
}

export const stats = internalQuery({
  args: {},
  returns: statsValidator,
  handler: async (ctx) => {
    const row = await ctx.db.query("fedReads").first();
    if (!row) {
      return { count: 0, lastTriggeredAt: null, lastTriggered: null, lastSource: null, opened: false };
    }
    return {
      count: row.count,
      lastTriggeredAt: row.lastTriggeredAt,
      lastTriggered: new Date(row.lastTriggeredAt).toISOString(),
      lastSource: row.lastSource,
      opened: row.count > 0,
    };
  },
});

export const record = internalMutation({
  args: {
    source: fedSource,
    opened: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.opened) return null;
    const now = Date.now();
    const row = await ctx.db.query("fedReads").first();
    if (!row) {
      await ctx.db.insert("fedReads", {
        count: 1,
        lastTriggeredAt: now,
        lastSource: args.source,
      });
      return null;
    }
    await ctx.db.patch(row._id, {
      count: row.count + 1,
      lastTriggeredAt: now,
      lastSource: args.source,
    });
    return null;
  },
});
