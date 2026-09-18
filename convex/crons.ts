import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Uploads nothing points at, from a tab that closed between taking an upload
// URL and recording the file.
crons.daily("sweep abandoned uploads", { hourUTC: 4, minuteUTC: 0 }, internal.attachments.sweep, {});

export default crons;
