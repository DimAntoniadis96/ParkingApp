import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Expired spots are already filtered out of every user-facing query (they check
// `expires_at > now`), so this cleanup only reclaims storage. Each run now drains
// the full backlog in bounded batches, letting us run it far less often — a big
// reduction in scheduled function calls / reads vs. the previous 5-minute cadence.
crons.interval("maintain parking spots", { minutes: 15 }, internal.parking.maintainParkingSpots);

// One-time legacy migration cleanup, kept as a cheap daily safety net.
crons.interval("cleanup legacy parking spots", { hours: 24 }, internal.parking.cleanupLegacySpots);

export default crons;
