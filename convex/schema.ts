import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  parking_spots: defineTable({
    latitude: v.number(),
    longitude: v.number(),
    status: v.union(v.literal("green"), v.literal("orange"), v.literal("red")),
    scheduled_departure_time: v.number(),
    expires_at: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    verified_at: v.optional(v.number()),
    verification_distance_meters: v.optional(v.number()),
    location_accuracy_meters: v.optional(v.number()),
    client_id: v.optional(v.string()),
    area_key: v.optional(v.string()),
    spot_key: v.optional(v.string()),
    car_info: v.object({
      brand: v.string(),
      color: v.string(),
      plate_slug: v.string(),
    }),
  })
    .index("by_expires_at", ["expires_at"])
    .index("by_area_expires_at", ["area_key", "expires_at"])
    .index("by_client_expires_at", ["client_id", "expires_at"])
    .index("by_spot_key_and_expires_at", ["spot_key", "expires_at"]),
  parking_clients: defineTable({
    client_id: v.string(),
    first_seen_at: v.number(),
    updated_at: v.number(),
    last_share_at: v.optional(v.number()),
    share_window_started_at: v.optional(v.number()),
    share_count: v.optional(v.number()),
    last_cancel_at: v.optional(v.number()),
    cancel_window_started_at: v.optional(v.number()),
    cancel_count: v.optional(v.number()),
  })
    .index("by_client_id", ["client_id"])
    .index("by_updated_at", ["updated_at"]),
});
