import { internalMutation, mutation, MutationCtx, query, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { v } from "convex/values";

const CELL_SIZE_DEGREES = 0.01;
const ACTIVE_QUERY_LIMIT = 60;
const PER_AREA_LIMIT = 12;
const EXPIRE_AFTER_DEPARTURE_MS = 12 * 60 * 1000;
const OPEN_CONFIRMED_TTL_MS = 3 * 60 * 1000;
const MAINTENANCE_BATCH_SIZE = 100;
const MAINTENANCE_MAX_BATCHES = 10;
const CLIENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 15 * 60 * 1000;
const MAX_VERIFICATION_FUTURE_MS = 30 * 1000;
const MAX_LOCATION_ACCURACY_METERS = 200;
const SHARE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const SHARE_RATE_LIMIT_COUNT = 4;
const CANCEL_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const CANCEL_RATE_LIMIT_COUNT = 10;
const FEEDBACK_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const FEEDBACK_RATE_LIMIT_COUNT = 20;
const FEEDBACK_REPEAT_WINDOW_MS = 30 * 60 * 1000;
const MAX_FEEDBACK_DISTANCE_METERS = 1000;
const CLIENT_ID_PATTERN = /^[a-f0-9]{32}$/;
const PRIVATE_CAR_INFO = {
  brand: "Private vehicle",
  color: "Hidden",
  plate_slug: "private",
};

type ParkingSpot = Doc<"parking_spots">;
type ParkingClient = Doc<"parking_clients">;
type ClientRequestKind = "share" | "cancel" | "feedback";
type ClientRateLimitWindowField = keyof Pick<
  ParkingClient,
  "share_window_started_at" | "cancel_window_started_at" | "feedback_window_started_at"
>;
type ClientRateLimitCountField = keyof Pick<
  ParkingClient,
  "share_count" | "cancel_count" | "feedback_count"
>;
type ClientRateLimitLastField = keyof Pick<
  ParkingClient,
  "last_share_at" | "last_cancel_at" | "last_feedback_at"
>;
type ClientRateLimitConfig = {
  windowMs: number;
  requestLimit: number;
  windowField: ClientRateLimitWindowField;
  countField: ClientRateLimitCountField;
  lastRequestField: ClientRateLimitLastField;
};

const parkingSpotArgs = {
  latitude: v.number(),
  longitude: v.number(),
  scheduled_departure_time: v.number(),
  departure_window_label: v.optional(v.string()),
  departure_window_min_minutes: v.optional(v.number()),
  departure_window_max_minutes: v.optional(v.number()),
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

const navigationFeedbackOutcome = v.union(
  v.literal("parked"),
  v.literal("found_not_taken"),
  v.literal("not_found"),
);

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
    departure_window_label?: string;
    departure_window_min_minutes?: number;
    departure_window_max_minutes?: number;
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
    typeof args.departure_window_label === "string" &&
    (args.departure_window_label.length < 3 || args.departure_window_label.length > 16)
  ) {
    throw new Error("Invalid departure window.");
  }

  if (
    typeof args.departure_window_min_minutes === "number" &&
    (!Number.isFinite(args.departure_window_min_minutes) ||
      args.departure_window_min_minutes < 1 ||
      args.departure_window_min_minutes > 15)
  ) {
    throw new Error("Invalid departure window.");
  }

  if (
    typeof args.departure_window_max_minutes === "number" &&
    (!Number.isFinite(args.departure_window_max_minutes) ||
      args.departure_window_max_minutes < 1 ||
      args.departure_window_max_minutes > 15)
  ) {
    throw new Error("Invalid departure window.");
  }

  if (
    typeof args.departure_window_min_minutes === "number" &&
    typeof args.departure_window_max_minutes === "number" &&
    args.departure_window_min_minutes > args.departure_window_max_minutes
  ) {
    throw new Error("Invalid departure window.");
  }

  if (
    typeof args.verified_at === "number" &&
    (!Number.isFinite(args.verified_at) || args.verified_at - now > MAX_VERIFICATION_FUTURE_MS)
  ) {
    throw new Error("Invalid pin confirmation.");
  }

  if (
    typeof args.verification_distance_meters === "number" &&
    (!Number.isFinite(args.verification_distance_meters) || args.verification_distance_meters < 0)
  ) {
    throw new Error("Invalid pin confirmation.");
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

function toPublicSpot(spot: ParkingSpot, now: number) {
  const isVerifiedOpen = typeof spot.open_confirmed_at === "number";

  return {
    _id: spot._id,
    latitude: spot.latitude,
    longitude: spot.longitude,
    status: isVerifiedOpen ? "green" : "orange",
    availability_status: isVerifiedOpen ? "verified_open" : "opening_soon",
    scheduled_departure_time: spot.scheduled_departure_time,
    departure_window_label: spot.departure_window_label ?? null,
    departure_window_min_minutes: spot.departure_window_min_minutes ?? null,
    departure_window_max_minutes: spot.departure_window_max_minutes ?? null,
    open_confirmed_at: spot.open_confirmed_at ?? null,
  };
}

function sortPublicSpots(left: ParkingSpot, right: ParkingSpot) {
  const leftPriority = typeof left.open_confirmed_at === "number" ? 0 : 1;
  const rightPriority = typeof right.open_confirmed_at === "number" ? 0 : 1;

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return left.scheduled_departure_time - right.scheduled_departure_time;
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

  const rateLimitConfig: ClientRateLimitConfig =
    kind === "share"
      ? {
          windowMs: SHARE_RATE_LIMIT_WINDOW_MS,
          requestLimit: SHARE_RATE_LIMIT_COUNT,
          windowField: "share_window_started_at",
          countField: "share_count",
          lastRequestField: "last_share_at",
        }
      : kind === "cancel"
        ? {
            windowMs: CANCEL_RATE_LIMIT_WINDOW_MS,
            requestLimit: CANCEL_RATE_LIMIT_COUNT,
            windowField: "cancel_window_started_at",
            countField: "cancel_count",
            lastRequestField: "last_cancel_at",
          }
        : {
            windowMs: FEEDBACK_RATE_LIMIT_WINDOW_MS,
            requestLimit: FEEDBACK_RATE_LIMIT_COUNT,
            windowField: "feedback_window_started_at",
            countField: "feedback_count",
            lastRequestField: "last_feedback_at",
          };
  const { windowMs, requestLimit, windowField, countField, lastRequestField } = rateLimitConfig;
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

// Drain expired spots across several bounded batches so a single (infrequent)
// cron run fully clears the backlog instead of leaving leftovers for the next
// run. Capped by MAINTENANCE_MAX_BATCHES to keep the transaction size bounded.
async function drainExpiredSpots(ctx: MutationCtx, now: number) {
  let totalDeleted = 0;

  for (let iteration = 0; iteration < MAINTENANCE_MAX_BATCHES; iteration += 1) {
    const deleted = await deleteExpiredBatch(ctx, now);
    totalDeleted += deleted;

    if (deleted < MAINTENANCE_BATCH_SIZE) {
      break;
    }
  }

  return totalDeleted;
}

async function drainStaleClients(ctx: MutationCtx, now: number) {
  let totalDeleted = 0;

  for (let iteration = 0; iteration < MAINTENANCE_MAX_BATCHES; iteration += 1) {
    const deleted = await deleteStaleClientsBatch(ctx, now);
    totalDeleted += deleted;

    if (deleted < MAINTENANCE_BATCH_SIZE) {
      break;
    }
  }

  return totalDeleted;
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

    const verificationFields: {
      verified_at?: number;
      verification_distance_meters?: number;
      location_accuracy_meters?: number;
    } = {};

    if (typeof verifiedAt === "number") {
      verificationFields.verified_at = verifiedAt;
    }

    if (typeof verificationDistanceMeters === "number") {
      verificationFields.verification_distance_meters = Math.round(verificationDistanceMeters);
    }

    if (typeof args.location_accuracy_meters === "number") {
      verificationFields.location_accuracy_meters = Math.round(args.location_accuracy_meters);
    }

    const departureWindowFields: {
      departure_window_label?: string;
      departure_window_min_minutes?: number;
      departure_window_max_minutes?: number;
    } = {};

    if (typeof args.departure_window_label === "string") {
      departureWindowFields.departure_window_label = args.departure_window_label;
    }

    if (typeof args.departure_window_min_minutes === "number") {
      departureWindowFields.departure_window_min_minutes = Math.round(args.departure_window_min_minutes);
    }

    if (typeof args.departure_window_max_minutes === "number") {
      departureWindowFields.departure_window_max_minutes = Math.round(args.departure_window_max_minutes);
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

    const spotId = await ctx.db.insert("parking_spots", {
      latitude: args.latitude,
      longitude: args.longitude,
      client_id: args.client_id,
      car_info: PRIVATE_CAR_INFO,
      ...verificationFields,
      ...departureWindowFields,
      status: "orange",
      scheduled_departure_time: scheduledDepartureTime,
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
      area_key: areaKey(args.latitude, args.longitude),
      spot_key: nextSpotKey,
    });

    return {
      spotId,
      scheduledDepartureTime,
      departureWindowLabel: args.departure_window_label ?? null,
      expiresAt,
      openConfirmedAt: null,
    };
  },
});

async function queryNearbyActiveSpots(
  ctx: QueryCtx,
  latitude: number,
  longitude: number,
  limit: number | undefined,
) {
  const now = Date.now();
  assertValidCoordinate(latitude, longitude);

  const boundedActiveLimit = boundedLimit(limit);
  const areaKeys = nearbyAreaKeys(latitude, longitude);
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
    .sort(sortPublicSpots)
    .slice(0, boundedActiveLimit)
    .map((spot) => toPublicSpot(spot, now));
}

export const getActiveSpots = query({
  args: {
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (typeof args.latitude !== "number" || typeof args.longitude !== "number") {
      return [];
    }

    return queryNearbyActiveSpots(ctx, args.latitude, args.longitude, args.limit);
  },
});

export const getNearbyActiveSpots = query({
  args: {
    latitude: v.number(),
    longitude: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    queryNearbyActiveSpots(ctx, args.latitude, args.longitude, args.limit),
});

export const recordNavigationFeedback = mutation({
  args: {
    client_id: v.string(),
    spot_id: v.id("parking_spots"),
    outcome: navigationFeedbackOutcome,
    distance_meters: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    assertValidClientId(args.client_id);

    if (
      typeof args.distance_meters === "number" &&
      (!Number.isFinite(args.distance_meters) ||
        args.distance_meters < 0 ||
        args.distance_meters > MAX_FEEDBACK_DISTANCE_METERS)
    ) {
      throw new Error("Invalid arrival feedback.");
    }

    await enforceClientRateLimit(ctx, args.client_id, now, "feedback");

    const feedbackKey = `${args.client_id}:${args.spot_id}`;
    const distanceFields: { distance_meters?: number } = {};

    if (typeof args.distance_meters === "number") {
      distanceFields.distance_meters = Math.round(args.distance_meters);
    }

    const existingFeedback = (
      await ctx.db
        .query("parking_navigation_feedback")
        .withIndex("by_feedback_key", (q) => q.eq("feedback_key", feedbackKey))
        .order("desc")
        .take(1)
    )[0];

    // Only remove the shared spot when the driver actually parked there (the
    // space is now taken). "found_not_taken" means the spot is still available,
    // and "not_found" is a single unverified report — deleting on either would
    // wrongly remove a still-valid spot for every other driver. Those spots are
    // left to expire naturally.
    if (args.outcome === "parked") {
      const spot = await ctx.db.get(args.spot_id);
      if (spot) {
        await ctx.db.delete(spot._id);
      }
    }

    if (existingFeedback && now - existingFeedback.created_at < FEEDBACK_REPEAT_WINDOW_MS) {
      await ctx.db.patch(existingFeedback._id, {
        outcome: args.outcome,
        updated_at: now,
        ...distanceFields,
      });

      return {
        feedbackId: existingFeedback._id,
        updated: true,
      };
    }

    const feedbackId = await ctx.db.insert("parking_navigation_feedback", {
      client_id: args.client_id,
      spot_id: args.spot_id,
      outcome: args.outcome,
      feedback_key: feedbackKey,
      created_at: now,
      ...distanceFields,
    });

    return {
      feedbackId,
      updated: false,
    };
  },
});

export const confirmMySpotLeft = mutation({
  args: {
    client_id: v.string(),
    spot_id: v.optional(v.id("parking_spots")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    assertValidClientId(args.client_id);

    const spot =
      typeof args.spot_id === "string"
        ? await ctx.db.get(args.spot_id)
        : (
            await ctx.db
              .query("parking_spots")
              .withIndex("by_client_expires_at", (q) => q.eq("client_id", args.client_id).gt("expires_at", now))
              .order("asc")
              .take(1)
          )[0];

    if (!spot || spot.client_id !== args.client_id || typeof spot.expires_at !== "number" || spot.expires_at <= now) {
      throw new Error("No active parking share found.");
    }

    const expiresAt = now + OPEN_CONFIRMED_TTL_MS;

    await ctx.db.patch(spot._id, {
      open_confirmed_at: now,
      expires_at: expiresAt,
      updated_at: now,
      status: "green",
    });

    return {
      spotId: spot._id,
      openConfirmedAt: now,
      expiresAt,
    };
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
    const deleted = await drainExpiredSpots(ctx, now);
    const staleClients = await drainStaleClients(ctx, now);

    return { deleted, staleClients };
  },
});

// Legacy spots (missing expires_at/area_key/client_id) are a one-time migration
// concern. Running this scan on the hot maintenance path wasted reads on every
// cron tick, so it now runs on its own low-frequency schedule.
export const cleanupLegacySpots = internalMutation({
  args: {},
  handler: async (ctx) => {
    const legacy = await deleteLegacyBatch(ctx);

    return { legacy };
  },
});
