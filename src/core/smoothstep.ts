/** Standard clamped cubic smoothstep on a non-degenerate interval. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (![edge0, edge1, value].every(Number.isFinite)) {
    throw new Error("smoothstep requires finite inputs");
  }
  if (edge1 <= edge0) {
    throw new Error("smoothstep requires edge1 > edge0");
  }
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return 3 * t * t - 2 * t * t * t;
}

/** Compactly supported Wendland C2 kernel for a nonnegative normalized distance. */
export function wendlandC2(normalizedDistance: number): number {
  if (!Number.isFinite(normalizedDistance) || normalizedDistance < 0) {
    throw new Error("Wendland distance must be finite and nonnegative");
  }
  if (normalizedDistance >= 1) {
    return 0;
  }
  const oneMinus = 1 - normalizedDistance;
  return (1 + 4 * normalizedDistance) * oneMinus ** 4;
}
