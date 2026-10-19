import { describe, it, expect } from "vite-plus/test";
import { selectMissedDeliveries, type HookDelivery } from "./redelivery.js";

const now = Date.parse("2026-10-19T15:00:00Z");
const d = (id: number, guid: string, at: string, status: number, event = "pull_request") =>
  ({ id, guid, delivered_at: at, status_code: status, event }) as HookDelivery;

describe("selectMissedDeliveries", () => {
  it("replays recent PR events whose every attempt failed, once per event", () => {
    const missed = selectMissedDeliveries(
      [
        d(1, "a", "2026-10-19T14:00:00Z", 502), // failed twice: replay the latest attempt
        d(2, "a", "2026-10-19T14:10:00Z", 0),
        d(3, "b", "2026-10-19T14:20:00Z", 502), // failed, then a redelivery succeeded
        d(4, "b", "2026-10-19T14:21:00Z", 202),
        d(5, "c", "2026-10-19T14:30:00Z", 202), // delivered fine
        d(6, "e", "2026-10-19T14:40:00Z", 502, "ping"), // not a PR event
        d(7, "f", "2026-10-17T14:40:00Z", 502), // older than the lookback window
        d(8, "g", "2026-10-19T13:00:00Z", 404),
      ],
      now,
    );
    expect(missed.map((m) => m.id)).toEqual([8, 2]);
  });
});
