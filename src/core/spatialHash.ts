import type { AgentState, Vec2 } from "./types";

/** Deterministic spatial hash whose query results are always sorted by agent ID. */
export class SpatialHash {
  readonly cellSize: number;
  private readonly buckets = new Map<string, AgentState[]>();

  constructor(cellSize: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new Error("Spatial hash cell size must be finite and positive");
    }
    this.cellSize = cellSize;
  }

  rebuild(agents: readonly AgentState[]): void {
    this.buckets.clear();
    for (const agent of [...agents].sort((a, b) => a.id - b.id)) {
      const [i, j] = this.cell(agent.position);
      const key = this.key(i, j);
      const bucket = this.buckets.get(key);
      if (bucket === undefined) {
        this.buckets.set(key, [agent]);
      } else {
        bucket.push(agent);
      }
    }
  }

  query(position: Vec2, radius: number): AgentState[] {
    if (!Number.isFinite(radius) || radius < 0) {
      throw new Error("Spatial hash query radius must be finite and nonnegative");
    }
    const [centerI, centerJ] = this.cell(position);
    const range = Math.ceil(radius / this.cellSize);
    const result: AgentState[] = [];
    for (let i = centerI - range; i <= centerI + range; i += 1) {
      for (let j = centerJ - range; j <= centerJ + range; j += 1) {
        const bucket = this.buckets.get(this.key(i, j));
        if (bucket !== undefined) result.push(...bucket);
      }
    }
    result.sort((a, b) => a.id - b.id);
    return result;
  }

  private cell(position: Vec2): readonly [number, number] {
    return [Math.floor(position[0] / this.cellSize), Math.floor(position[1] / this.cellSize)];
  }

  private key(i: number, j: number): string {
    return `${i},${j}`;
  }
}
