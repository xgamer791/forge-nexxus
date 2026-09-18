// Validators shared between the schema, the query modules, and the Node action
// module. Kept free of imports so `convex/remote.ts` does not pull the schema
// (and with it Convex Auth) into its Node bundle.
import { v } from "convex/values";

export const connectionKind = v.union(v.literal("cloud"), v.literal("repo"));
export const workspaceProtocol = v.union(v.literal("ssh"), v.literal("sftp"));
export const workspaceEnvironment = v.union(
  v.literal("production"),
  v.literal("staging"),
  v.literal("dev"),
);
