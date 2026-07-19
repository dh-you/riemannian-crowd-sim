export type Estimator = "mean" | "median";

export interface AnalysisDatum {
  scenarioId: string;
  family: string;
  variant: string;
  methodId: string;
  methodKey: string;
  values: Record<string, number | null>;
}

export function estimate(values: readonly (number | null)[], estimator: Estimator): number | null {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (finite.length === 0) return null;
  if (estimator === "mean") return finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const ordered = [...finite].sort((first, second) => first - second);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function familyEstimate(
  data: readonly AnalysisDatum[],
  family: string,
  metric: string,
  estimator: Estimator,
): number | null {
  const relevant = data.filter((datum) => datum.family === family);
  if (relevant.length === 0) return null;
  if (family === "pairwise") {
    const variants = ["head_on", "crossing", "overtaking", "separating"];
    const estimates = variants.map((variant) => estimate(
      relevant.filter((datum) => datum.variant === variant).map((datum) => datum.values[metric] ?? null),
      estimator,
    ));
    return estimates.some((value) => value === null)
      ? null
      : estimate(estimates, "mean");
  }
  return estimate(relevant.map((datum) => datum.values[metric] ?? null), estimator);
}

export function macroEstimate(
  data: readonly AnalysisDatum[],
  metric: string,
  estimator: Estimator,
  scope: "overall" | "pairwise" | "bottleneck",
): number | null {
  if (scope !== "overall") return familyEstimate(data, scope, metric, estimator);
  const values = ["pairwise", "circle_antipodal", "bidirectional", "bottleneck"]
    .map((family) => familyEstimate(data, family, metric, estimator));
  return values.some((value) => value === null) ? null : estimate(values, "mean");
}

export function contributingCount(
  data: readonly AnalysisDatum[],
  metric: string,
  scope: "overall" | "pairwise" | "bottleneck",
): number {
  return data.filter((datum) =>
    (scope === "overall" || datum.family === scope)
    && datum.values[metric] !== null).length;
}
