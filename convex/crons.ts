import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// A queued build whose step the platform lost -- a deploy or a restart can
// drop a scheduled action -- is started again here (onboarding.rescue).
crons.interval("restart stalled onboarding builds", { seconds: 30 }, internal.onboarding.rescue, {});
// A site written a page at a time whose step went quiet is carried on from its
// last saved page here (buildDraft.rescue).
crons.interval("restart stalled page-at-a-time builds", { seconds: 30 }, internal.buildDraft.rescue, {});

export default crons;
