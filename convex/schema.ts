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
    .index("by_client_expires_at", ["client_id", "expires_at"]),
});
