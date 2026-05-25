import { Agent } from "../utils/Agent";
export class SpatialHash {
    cellSize: number;
    map: Map<number, Agent[]>;
    constructor(cellSize: number) {
        this.cellSize = cellSize;
        this.map = new Map();
    }
    _cellKey(i: number, j: number): number {
        return ((i + 32768) << 16) | (j + 32768);
    }
    _key(x: number, y: number): number {
        const i = Math.floor(x / this.cellSize);
        const j = Math.floor(y / this.cellSize);
        return this._cellKey(i, j);
    }
    clear() {
        this.map.clear();
    }
    insert(agent: Agent) {
        const key = this._key(agent.pos.v[0], agent.pos.v[1]);
        if (!this.map.has(key)) {
            this.map.set(key, []);
        }
        this.map.get(key)!.push(agent);
    }
    rebuild(agents: Agent[]) {
        this.clear();
        for (const agent of agents) {
            this.insert(agent);
        }
    }
    *neighbors(agent: Agent, radius?: number) {
        const searchRadius = radius ?? this.cellSize;
        const range = Math.ceil(searchRadius / this.cellSize);
        const cx = Math.floor(agent.pos.v[0] / this.cellSize);
        const cy = Math.floor(agent.pos.v[1] / this.cellSize);
        for (let di = -range; di <= range; di++) {
            for (let dj = -range; dj <= range; dj++) {
                const bucket = this.map.get(this._cellKey(cx + di, cy + dj));
                if (!bucket) continue;
                for (const other of bucket) {
                    if (other !== agent) {
                        yield other;
                    }
                }
            }
        }
    }
}