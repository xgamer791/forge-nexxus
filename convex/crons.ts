import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// A queued build whose step the platform lost -- a deploy or a restart can
// drop a scheduled action -- is started again here (onboarding.rescue).
crons.interval("restart stalled onboarding builds", { seconds: 30 }, internal.onboarding.rescue, {});

export default crons;
