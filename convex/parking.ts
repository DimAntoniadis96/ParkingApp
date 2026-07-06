import { internalMutation, mutation, MutationCtx, query } from "./_generated/server";
import { v } from "convex/values";

const CELL_SIZE_DEGREES = 0.01;
const ACTIVE_QUERY_LIMIT = 90;
const PER_AREA_LIMIT = 20;
const EXPIRE_AFTER_DEPARTURE_MS = 12 * 60 * 1000;
const ORANGE_AFTER_DEPARTURE_MS = 5 * 60 * 1000;
const MAINTENANCE_BATCH_SIZE = 100;

const parkingSpotArgs = {
  latitude: v.number(),
  longitude: v.number(),
  scheduled_departure_time: v.number(),
  client_id: v.string(),
  car_info: v.object({
    brand: v.string(),
    color: v.string(),
    plate_slug: v.string(),
  }),
};

function areaKey(latitude: number, longitude: number) {
  const latCell = Math.floor(latitude / CELL_SIZE_DEGREES);
  const lonCell = Math.floor(longitude / CELL_SIZE_DEGREES);

  return `${latCell}:${lonCell}`;
}

function spotKey(latitude: number, longitude: number) {
  return `${latitude.toFixed(5)}:${longitude.toFixed(5)}`;
}

function nearbyAreaKeys(latitude: number, longitude: number) {
  const latCell = Math.floor(latitude / CELL_SIZE_DEGREES);
  const lonCell = Math.floor(longitude / CELL_SIZE_DEGREES);
  const keys = [];

  for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
    for (let lonOffset = -1; lonOffset <= 1; lonOffset += 1) {
      keys.push(`${latCell + latOffset}:${lonCell + lonOffset}`);
    }
  }

  return keys;
}

function statusForTime(now: number, scheduledDepartureTime: number) {
  if (now < scheduledDepartureTime) {
    return "green";
  }

  if (now < scheduledDepartureTime + ORANGE_AFTER_DEPARTURE_MS) {
    return "orange";
  }

  return "red";
}

async function deleteExpiredBatch(ctx: MutationCtx, now: number, batchSize = MAINTENANCE_BATCH_SIZE) {
  const expiredSpots = await ctx.db
    .query("parking_spots")
    .withIndex("by_expires_at", (q) => q.lt("expires_at", now))
    .take(batchSize);

  await Promise.all(expiredSpots.map((spot) => ctx.db.delete(spot._id)));

  return expiredSpots.length;
}

async function deleteLegacyBatch(ctx: MutationCtx, batchSize = MAINTENANCE_BATCH_SIZE) {
  const spots = await ctx.db.query("parking_spots").take(batchSize);
  const legacySpots = spots.filter(
    (spot) =>
      typeof spot.expires_at !== "number" ||
      typeof spot.area_key !== "string" ||
      typeof spot.client_id !== "string",
  );

  await Promise.all(legacySpots.map((spot) => ctx.db.delete(spot._id)));

  return legacySpots.length;
}

export const shareSpot = mutation({
  args: parkingSpotArgs,
  handler: async (ctx, args) => {
    const now = Date.now();
    const scheduledDepartureTime = Math.max(args.scheduled_departure_time, now);
    const expiresAt = scheduledDepartureTime + EXPIRE_AFTER_DEPARTURE_MS;

    await deleteExpiredBatch(ctx, now, 25);
    await deleteLegacyBatch(ctx, 25);

    const existingClientSpots = await ctx.db
      .query("parking_spots")
      .withIndex("by_client_expires_at", (q) => q.eq("client_id", args.client_id).gt("expires_at", now))
      .take(10);

    await Promise.all(existingClientSpots.map((spot) => ctx.db.delete(spot._id)));

    return await ctx.db.insert("parking_spots", {
      ...args,
      status: statusForTime(now, scheduledDepartureTime),
      scheduled_departure_time: scheduledDepartureTime,
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
      area_key: areaKey(args.latitude, args.longitude),
      spot_key: spotKey(args.latitude, args.longitude),
    });
  },
});

export const getActiveSpots = query({
  args: {
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? ACTIVE_QUERY_LIMIT, ACTIVE_QUERY_LIMIT);

    return await ctx.db
      .query("parking_spots")
      .withIndex("by_expires_at", (q) => q.gt("expires_at", Date.now()))
      .order("asc")
      .take(limit);
  },
});

export const getNearbyActiveSpots = query({
  args: {
    latitude: v.number(),
    longitude: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.min(args.limit ?? ACTIVE_QUERY_LIMIT, ACTIVE_QUERY_LIMIT);
    const areaKeys = nearbyAreaKeys(args.latitude, args.longitude);
    const results = await Promise.all(
      areaKeys.map((key) =>
        ctx.db
          .query("parking_spots")
          .withIndex("by_area_expires_at", (q) => q.eq("area_key", key).gt("expires_at", now))
          .order("asc")
          .take(PER_AREA_LIMIT),
      ),
    );

    return results
      .flat()
      .sort((left, right) => left.scheduled_departure_time - right.scheduled_departure_time)
      .slice(0, limit);
  },
});

export const cancelMyActiveSpot = mutation({
  args: {
    client_id: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const activeSpots = await ctx.db
      .query("parking_spots")
      .withIndex("by_client_expires_at", (q) => q.eq("client_id", args.client_id).gt("expires_at", now))
      .take(10);

    await Promise.all(activeSpots.map((spot) => ctx.db.delete(spot._id)));

    return activeSpots.length;
  },
});

export const maintainParkingSpots = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const legacy = await deleteLegacyBatch(ctx);
    const deleted = await deleteExpiredBatch(ctx, now);
    const activeSpots = await ctx.db
      .query("parking_spots")
      .withIndex("by_expires_at", (q) => q.gt("expires_at", now))
      .take(MAINTENANCE_BATCH_SIZE);

    let updated = 0;

    for (const spot of activeSpots) {
      const nextStatus = statusForTime(now, spot.scheduled_departure_time);

      if (nextStatus !== spot.status) {
        await ctx.db.patch(spot._id, {
          status: nextStatus,
          updated_at: now,
        });
        updated += 1;
      }
    }

    return { deleted, legacy, updated };
  },
});
