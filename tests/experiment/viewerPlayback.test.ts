import { describe, expect, it } from "vitest";
import {
  computeStoredFrameDurations,
  computeStoredPlaybackDuration,
} from "../../experiments/audit/viewer/generateReviewIndex";

describe("audit viewer playback timing", () => {
  const dt = 1 / 60;

  it("preserves physical duration for trajectories sampled every 12 steps", () => {
    const sampled = Array.from({ length: 11 }, (_, index) => ({
      stepIndex: index * 12,
      time: index * 12 * dt,
    }));

    const durations = computeStoredFrameDurations(sampled);
    const physicalDuration = computeStoredPlaybackDuration(sampled);
    const oldDtBasedDuration = (sampled.length - 1) * dt;

    expect(durations).toHaveLength(sampled.length - 1);
    for (const duration of durations) expect(duration).toBeCloseTo(12 * dt, 12);
    expect(physicalDuration).toBeCloseTo(2, 12);
    expect(physicalDuration / oldDtBasedDuration).toBeCloseTo(12, 12);
  });

  it("leaves full-rate trajectory playback duration unchanged", () => {
    const fullRate = Array.from({ length: 121 }, (_, index) => ({
      stepIndex: index,
      time: index * dt,
    }));

    const durations = computeStoredFrameDurations(fullRate);
    expect(durations).toHaveLength(fullRate.length - 1);
    for (const duration of durations) expect(duration).toBeCloseTo(dt, 12);
    expect(computeStoredPlaybackDuration(fullRate)).toBeCloseTo(2, 12);
    expect(computeStoredPlaybackDuration(fullRate))
      .toBeCloseTo((fullRate.length - 1) * dt, 12);
  });

  it("handles terminal frames and rejects invalid stored time differences", () => {
    expect(computeStoredFrameDurations([{ stepIndex: 0, time: 1 }])).toEqual([]);
    expect(computeStoredPlaybackDuration([{ stepIndex: 0, time: 1 }])).toBe(0);

    expect(() => computeStoredFrameDurations([
      { stepIndex: 0, time: 1 },
      { stepIndex: 1, time: 1 },
    ])).toThrow(/positive and finite/);
    expect(() => computeStoredFrameDurations([
      { stepIndex: 0, time: 1 },
      { stepIndex: 1, time: Number.POSITIVE_INFINITY },
    ])).toThrow(/positive and finite/);
    expect(() => computeStoredFrameDurations([
      { stepIndex: 0, time: 1 },
      { stepIndex: 1, time: Number.NaN },
    ])).toThrow(/positive and finite/);
  });
});
