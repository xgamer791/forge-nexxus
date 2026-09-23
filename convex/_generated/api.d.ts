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
import type * as admins from "../admins.js";
import type * as auth from "../auth.js";
import type * as billing from "../billing.js";
import type * as conversations from "../conversations.js";
import type * as designReview from "../designReview.js";
import type * as diagnostics from "../diagnostics.js";
import type * as domains from "../domains.js";
import type * as generate from "../generate.js";
import type * as http from "../http.js";
import type * as images from "../images.js";
import type * as memory from "../memory.js";
import type * as messages from "../messages.js";
import type * as onboarding from "../onboarding.js";
import type * as pages from "../pages.js";
import type * as plans from "../plans.js";
import type * as probe from "../probe.js";
import type * as settings from "../settings.js";
import type * as siteDesign from "../siteDesign.js";
import type * as sites from "../sites.js";
import type * as stripe from "../stripe.js";
import type * as support from "../support.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  admins: typeof admins;
  auth: typeof auth;
  billing: typeof billing;
  conversations: typeof conversations;
  designReview: typeof designReview;
  diagnostics: typeof diagnostics;
  domains: typeof domains;
  generate: typeof generate;
  http: typeof http;
  images: typeof images;
  memory: typeof memory;
  messages: typeof messages;
  onboarding: typeof onboarding;
  pages: typeof pages;
  plans: typeof plans;
  probe: typeof probe;
  settings: typeof settings;
  siteDesign: typeof siteDesign;
  sites: typeof sites;
  stripe: typeof stripe;
  support: typeof support;
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
