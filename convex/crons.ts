import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("maintain parking spots", { minutes: 5 }, internal.parking.maintainParkingSpots);

export default crons;
