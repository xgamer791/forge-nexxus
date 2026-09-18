/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as auth from "../auth.js";
import type * as billing from "../billing.js";
import type * as conversations from "../conversations.js";
import type * as domains from "../domains.js";
import type * as generate from "../generate.js";
import type * as hosting from "../hosting.js";
import type * as http from "../http.js";
import type * as messages from "../messages.js";
import type * as plans from "../plans.js";
import type * as settings from "../settings.js";
import type * as sites from "../sites.js";
import type * as stripe from "../stripe.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  billing: typeof billing;
  conversations: typeof conversations;
  domains: typeof domains;
  generate: typeof generate;
  hosting: typeof hosting;
  http: typeof http;
  messages: typeof messages;
  plans: typeof plans;
  settings: typeof settings;
  sites: typeof sites;
  stripe: typeof stripe;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
