import { Vec2, Mat2 } from "../utils/Linalg";
export class MetricGrid {
    width: number;
    height: number;
    cellSize: number;
    halfWidth: number;
    halfHeight: number;
    data: Float32Array;
    constructor(width : number, height : number, cellSize : number) {
        this.width = width;
        this.height = height;
        this.cellSize = cellSize;
        this.halfWidth = (width * cellSize) / 2;
        this.halfHeight = (height * cellSize) / 2;
        this.data = new Float32Array(width * height * 4);
        this.initializeIdentity();
    }
    initializeIdentity() {
        for (let i = 0; i < this.width * this.height; i++) {
            const baseIdx = i * 4;
            this.data[baseIdx] = 1.0;
            this.data[baseIdx + 1] = 0.0;
            this.data[baseIdx + 2] = 0.0;
            this.data[baseIdx + 3] = 1.0;
        }
    }
    worldToGrid(v : Vec2) {
        return {
            i: Math.floor((v.v[0] + this.halfWidth) / this.cellSize),
            j: Math.floor((v.v[1] + this.halfHeight) / this.cellSize)
        };
    }
    gridToWorld(i : number, j : number) {
        return new Vec2([
            (i + 0.5) * this.cellSize - this.halfWidth,
            (j + 0.5) * this.cellSize - this.halfHeight
        ]);
    }
    getMetric(i : number, j : number) {
        if (i < 0 || j < 0 || i >= this.width || j >= this.height) {
            return Mat2.identity();
        }
        const idx = (j * this.width + i) * 4;
        return new Mat2([
            [this.data[idx], this.data[idx + 1]],
            [this.data[idx + 2], this.data[idx + 3]]
        ]);
    }
    setMetric(i : number, j : number, M : Mat2) {
        if (i < 0 || j < 0 || i >= this.width || j >= this.height) return;
        const idx = (j * this.width + i) * 4;
        this.data[idx] = M.m[0][0];
        this.data[idx + 1] = M.m[0][1];
        this.data[idx + 2] = M.m[1][0];
        this.data[idx + 3] = M.m[1][1];
    }
    addWarp(i : number, j : number, W : Mat2) {
        if (i < 0 || j < 0 || i >= this.width || j >= this.height) return;
        const idx = (j * this.width + i) * 4;
        this.data[idx] += W.m[0][0];
        this.data[idx + 1] += W.m[0][1];
        this.data[idx + 2] += W.m[1][0];
        this.data[idx + 3] += W.m[1][1];
    }
    _interpIndices(v: Vec2) {
        let gx = (v.v[0] + this.halfWidth) / this.cellSize - 0.5;
        let gy = (v.v[1] + this.halfHeight) / this.cellSize - 0.5;
        gx = Math.max(0, Math.min(this.width - 1, gx));
        gy = Math.max(0, Math.min(this.height - 1, gy));
        const i = Math.floor(gx);
        const j = Math.floor(gy);
        const i1 = Math.min(i + 1, this.width - 1);
        const j1 = Math.min(j + 1, this.height - 1);
        const fx = gx - i;
        const fy = gy - j;
        return { i, j, i1, j1, fx, fy };
    }
    sampleMetricInterpolated(v: Vec2): Mat2 {
        const { i, j, i1, j1, fx, fy } = this._interpIndices(v);
        return Mat2.bilerp(
            this.getMetric(i, j), this.getMetric(i1, j),
            this.getMetric(i, j1), this.getMetric(i1, j1),
            fx, fy
        );
    }
}