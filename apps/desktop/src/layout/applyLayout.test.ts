import { describe, expect, it } from "vitest";
import { clampPanel, DENSITY_SCALE, PANEL_BOUNDS } from "./applyLayout";

describe("clampPanel", () => {
  it("clamps below the minimum", () => {
    expect(clampPanel("list", 10)).toBe(PANEL_BOUNDS.list.min);
  });

  it("clamps above the maximum", () => {
    expect(clampPanel("aside", 9999)).toBe(PANEL_BOUNDS.aside.max);
  });

  it("rounds and passes through in-range values", () => {
    expect(clampPanel("list", 300.6)).toBe(301);
  });
});

describe("DENSITY_SCALE", () => {
  it("keeps cozy as the 1.0 baseline", () => {
    expect(DENSITY_SCALE.cozy).toBe(1);
    expect(DENSITY_SCALE.compact).toBeLessThan(1);
    expect(DENSITY_SCALE.comfortable).toBeGreaterThan(1);
  });
});
