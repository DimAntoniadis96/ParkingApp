import { internalMutation, mutation, MutationCtx, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { v } from "convex/values";

const CELL_SIZE_DEGREES = 0.01;
const ACTIVE_QUERY_LIMIT = 60;
const PER_AREA_LIMIT = 12;
const EXPIRE_AFTER_DEPARTURE_MS = 12 * 60 * 1000;
const ORANGE_AFTER_DEPARTURE_MS = 5 * 60 * 1000;
const MAINTENANCE_BATCH_SIZE = 100;
const CLIENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 15 * 60 * 1000;
const MAX_VERIFICATION_AGE_MS = 2 * 60 * 1000;
const MAX_VERIFICATION_FUTURE_MS = 30 * 1000;
const MAX_VERIFICATION_DISTANCE_METERS = 120;
const MAX_LOCATION_ACCURACY_METERS = 200;
const SHARE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const SHARE_RATE_LIMIT_COUNT = 4;
const CANCEL_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const CANCEL_RATE_LIMIT_COUNT = 10;
const CLIENT_ID_PATTERN = /^[a-f0-9]{32}$/;
const PRIVATE_CAR_INFO = {
  brand: "Private vehicle",
  color: "Hidden",
  plate_slug: "private",
};

type ParkingSpot = Doc<"parking_spots">;
type ClientRequestKind = "share" | "cancel";

const parkingSpotArgs = {
  latitude: v.number(),
  longitude: v.number(),
  scheduled_departure_time: v.number(),
  verified_at: v.optional(v.number()),
  verification_distance_meters: v.optional(v.number()),
  location_accuracy_meters: v.optional(v.number()),
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

function assertValidCoordinate(latitude: number, longitude: number) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error("Invalid parking location.");
  }
}

function assertValidClientId(clientId: string) {
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error("Invalid client.");
  }
}

function assertValidShareRequest(
  now: number,
  args: {
    latitude: number;
    longitude: number;
    scheduled_departure_time: number;
    verified_at?: number;
    verification_distance_meters?: number;
    location_accuracy_meters?: number;
    client_id: string;
  },
) {
  assertValidClientId(args.client_id);
  assertValidCoordinate(args.latitude, args.longitude);

  if (
    !Number.isFinite(args.scheduled_departure_time) ||
    args.scheduled_departure_time < now - 15_000 ||
    args.scheduled_departure_time > now + MAX_SCHEDULE_AHEAD_MS
  ) {
    throw new Error("Invalid departure time.");
  }

  if (
    typeof args.verified_at !== "number" ||
    !Number.isFinite(args.verified_at) ||
    now - args.verified_at > MAX_VERIFICATION_AGE_MS ||
    args.verified_at - now > MAX_VERIFICATION_FUTURE_MS
  ) {
    throw new Error("Spot verification expired.");
  }

  if (
    typeof args.verification_distance_meters !== "number" ||
    !Number.isFinite(args.verification_distance_meters) ||
    args.verification_distance_meters < 0 ||
    args.verification_distance_meters > MAX_VERIFICATION_DISTANCE_METERS
  ) {
    throw new Error("Spot must be verified near the car.");
  }

  if (
    typeof args.location_accuracy_meters === "number" &&
    (!Number.isFinite(args.location_accuracy_meters) ||
      args.location_accuracy_meters < 0 ||
      args.location_accuracy_meters > MAX_LOCATION_ACCURACY_METERS)
  ) {
    throw new Error("Location accuracy is too low.");
  }
}

function boundedLimit(limit: number | undefined) {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    return ACTIVE_QUERY_LIMIT;
  }

  return Math.min(Math.floor(limit), ACTIVE_QUERY_LIMIT);
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

function toPublicSpot(spot: ParkingSpot, now: number) {
  return {
    _id: spot._id,
    latitude: spot.latitude,
    longitude: spot.longitude,
    status: statusForTime(now, spot.scheduled_departure_time),
    scheduled_departure_time: spot.scheduled_departure_time,
  };
}

async function enforceClientRateLimit(
  ctx: MutationCtx,
  clientId: string,
  now: number,
  kind: ClientRequestKind,
) {
  const existingClient = await ctx.db
    .query("parking_clients")
    .withIndex("by_client_id", (q) => q.eq("client_id", clientId))
    .unique();

  const windowMs = kind === "share" ? SHARE_RATE_LIMIT_WINDOW_MS : CANCEL_RATE_LIMIT_WINDOW_MS;
  const requestLimit = kind === "share" ? SHARE_RATE_LIMIT_COUNT : CANCEL_RATE_LIMIT_COUNT;
  const windowField = kind === "share" ? "share_window_started_at" : "cancel_window_started_at";
  const countField = kind === "share" ? "share_count" : "cancel_count";
  const lastRequestField = kind === "share" ? "last_share_at" : "last_cancel_at";
  const windowStartedAt = existingClient?.[windowField];
  const currentCount = existingClient?.[countField] ?? 0;
  const isSameWindow = typeof windowStartedAt === "number" && now - windowStartedAt < windowMs;
  const nextCount = isSameWindow ? currentCount + 1 : 1;
  const nextWindowStartedAt = isSameWindow && typeof windowStartedAt === "number" ? windowStartedAt : now;

  if (nextCount > requestLimit) {
    throw new Error("Too many requests. Please wait a moment.");
  }

  if (!existingClient) {
    await ctx.db.insert("parking_clients", {
      client_id: clientId,
      first_seen_at: now,
      updated_at: now,
      [windowField]: nextWindowStartedAt,
      [countField]: nextCount,
      [lastRequestField]: now,
    });
    return;
  }

  await ctx.db.patch(existingClient._id, {
    updated_at: now,
    [windowField]: nextWindowStartedAt,
    [countField]: nextCount,
    [lastRequestField]: now,
  });
}

async function deleteExpiredBatch(ctx: MutationCtx, now: number, batchSize = MAINTENANCE_BATCH_SIZE) {
  const expiredSpots = await ctx.db
    .query("parking_spots")
    .withIndex("by_expires_at", (q) => q.lt("expires_at", now))
    .take(batchSize);

  await Promise.all(expiredSpots.map((spot) => ctx.db.delete(spot._id)));

  return expiredSpots.length;
}

async function deleteStaleClientsBatch(ctx: MutationCtx, now: number, batchSize = MAINTENANCE_BATCH_SIZE) {
  const staleClients = await ctx.db
    .query("parking_clients")
    .withIndex("by_updated_at", (q) => q.lt("updated_at", now - CLIENT_RETENTION_MS))
    .take(batchSize);

  await Promise.all(staleClients.map((client) => ctx.db.delete(client._id)));

  return staleClients.length;
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
    assertValidShareRequest(now, args);

    const scheduledDepartureTime = Math.max(args.scheduled_departure_time, now);
    const expiresAt = scheduledDepartureTime + EXPIRE_AFTER_DEPARTURE_MS;
    const nextSpotKey = spotKey(args.latitude, args.longitude);
    const verifiedAt = args.verified_at;
    const verificationDistanceMeters = args.verification_distance_meters;

    if (typeof verifiedAt !== "number" || typeof verificationDistanceMeters !== "number") {
      throw new Error("Spot verification is required.");
    }

    const verificationFields: {
      verified_at: number;
      verification_distance_meters: number;
      location_accuracy_meters?: number;
    } = {
      verified_at: verifiedAt,
      verification_distance_meters: Math.round(verificationDistanceMeters),
    };

    if (typeof args.location_accuracy_meters === "number") {
      verificationFields.location_accuracy_meters = Math.round(args.location_accuracy_meters);
    }

    await enforceClientRateLimit(ctx, args.client_id, now, "share");

    const activeSpotAtSamePin = await ctx.db
      .query("parking_spots")
      .withIndex("by_spot_key_and_expires_at", (q) => q.eq("spot_key", nextSpotKey).gt("expires_at", now))
      .take(3);
    const conflictingSpot = activeSpotAtSamePin.find((spot) => spot.client_id !== args.client_id);

    if (conflictingSpot) {
      throw new Error("This spot was already shared.");
    }

    const existingClientSpots = await ctx.db
      .query("parking_spots")
      .withIndex("by_client_expires_at", (q) => q.eq("client_id", args.client_id).gt("expires_at", now))
      .take(5);

    await Promise.all(existingClientSpots.map((spot) => ctx.db.delete(spot._id)));

    return await ctx.db.insert("parking_spots", {
      latitude: args.latitude,
      longitude: args.longitude,
      client_id: args.client_id,
      car_info: PRIVATE_CAR_INFO,
      ...verificationFields,
      status: statusForTime(now, scheduledDepartureTime),
      scheduled_departure_time: scheduledDepartureTime,
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
      area_key: areaKey(args.latitude, args.longitude),
      spot_key: nextSpotKey,
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
    const now = Date.now();
    const limit = boundedLimit(args.limit);

    if (typeof args.latitude !== "number" || typeof args.longitude !== "number") {
      return [];
    }

    assertValidCoordinate(args.latitude, args.longitude);

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
      .slice(0, limit)
      .map((spot) => toPublicSpot(spot, now));
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
    assertValidCoordinate(args.latitude, args.longitude);

    const limit = boundedLimit(args.limit);
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
      .slice(0, limit)
      .map((spot) => toPublicSpot(spot, now));
  },
});

export const cancelMyActiveSpot = mutation({
  args: {
    client_id: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    assertValidClientId(args.client_id);
    await enforceClientRateLimit(ctx, args.client_id, now, "cancel");

    const activeSpots = await ctx.db
      .query("parking_spots")
      .withIndex("by_client_expires_at", (q) => q.eq("client_id", args.client_id).gt("expires_at", now))
      .take(5);

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
    const staleClients = await deleteStaleClientsBatch(ctx, now);

    return { deleted, legacy, staleClients };
  },
});
