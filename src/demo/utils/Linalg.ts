export class Vec2 {
    v: [number, number];

    constructor(v: [number, number]) {
        this.v = v;
    }

    normalize(): Vec2 {
        const x = this.v[0];
        const y = this.v[1];
        const dist = Math.sqrt(x * x + y * y);
        if (dist === 0) return new Vec2([0, 0]);
        return new Vec2([x / dist, y / dist]);
    }

    hypot(): number {
        const x = this.v[0];
        const y = this.v[1];
        return Math.sqrt(x * x + y * y);
    }

    sub(a: Vec2): Vec2 {
        return new Vec2([
            this.v[0] - a.v[0],
            this.v[1] - a.v[1],
        ]);
    }

    add(a: Vec2): Vec2 {
        return new Vec2([
            this.v[0] + a.v[0],
            this.v[1] + a.v[1],
        ]);
    }

    mulScalar(a: number): Vec2 {
        return new Vec2([
            a * this.v[0],
            a * this.v[1],
        ]);
    }

    mulScalarInPlace(a: number): Vec2 {
        this.v[0] *= a;
        this.v[1] *= a;
        return this;
    }

    normalizeInPlace(): Vec2 {
        const x = this.v[0];
        const y = this.v[1];
        const dist = Math.sqrt(x * x + y * y);
        if (dist === 0) {
            this.v[0] = 0;
            this.v[1] = 0;
            return this;
        }
        this.v[0] = x / dist;
        this.v[1] = y / dist;
        return this;
    }

    clone(): Vec2 {
        return new Vec2([this.v[0], this.v[1]]);
    }

    copyFrom(a: Vec2): Vec2 {
        this.v[0] = a.v[0];
        this.v[1] = a.v[1];
        return this;
    }

    addInPlace(a: Vec2): Vec2 {
        this.v[0] += a.v[0];
        this.v[1] += a.v[1];
        return this;
    }

    subInPlace(a: Vec2): Vec2 {
        this.v[0] -= a.v[0];
        this.v[1] -= a.v[1];
        return this;
    }

    dot(a: Vec2): number {
        return this.v[0] * a.v[0] + this.v[1] * a.v[1];
    }
}

export class Mat2 {
    m: [[number, number], [number, number]];

    constructor(m: [[number, number], [number, number]]) {
        this.m = m;
    }

    static identity(): Mat2 {
        return new Mat2([
            [1, 0],
            [0, 1],
        ]);
    }

    static zero(): Mat2 {
        return new Mat2([
            [0, 0],
            [0, 0],
        ]);
    }

    static projection(a: Vec2): Mat2 {
        return new Mat2([
            [a.v[0] ** 2, a.v[0] * a.v[1]],
            [a.v[1] * a.v[0], a.v[1] ** 2],
        ]);
    }

    mulScalar(a: number): Mat2 {
        return new Mat2([
            [a * this.m[0][0], a * this.m[0][1]],
            [a * this.m[1][0], a * this.m[1][1]],
        ]);
    }

    mulScalarInPlace(a: number): Mat2 {
        this.m[0][0] *= a;
        this.m[0][1] *= a;
        this.m[1][0] *= a;
        this.m[1][1] *= a;
        return this;
    }

    mulVec2(a: Vec2): Vec2 {
        return new Vec2([
            a.v[0] * this.m[0][0] + a.v[1] * this.m[0][1],
            a.v[0] * this.m[1][0] + a.v[1] * this.m[1][1],
        ]);
    }

    mulMat2(a: Mat2): Mat2 {
        const col1 = this.mulVec2(new Vec2([a.m[0][0], a.m[1][0]]));
        const col2 = this.mulVec2(new Vec2([a.m[0][1], a.m[1][1]]));
        return new Mat2([
            [col1.v[0], col2.v[0]],
            [col1.v[1], col2.v[1]],
        ]);
    }

    add(a: Mat2): Mat2 {
        return new Mat2([
            [this.m[0][0] + a.m[0][0], this.m[0][1] + a.m[0][1]],
            [this.m[1][0] + a.m[1][0], this.m[1][1] + a.m[1][1]],
        ]);
    }

    addInPlace(a: Mat2): Mat2 {
        this.m[0][0] += a.m[0][0];
        this.m[0][1] += a.m[0][1];
        this.m[1][0] += a.m[1][0];
        this.m[1][1] += a.m[1][1];
        return this;
    }

    sub(a: Mat2): Mat2 {
        return new Mat2([
            [this.m[0][0] - a.m[0][0], this.m[0][1] - a.m[0][1]],
            [this.m[1][0] - a.m[1][0], this.m[1][1] - a.m[1][1]],
        ]);
    }

    subInPlace(a: Mat2): Mat2 {
        this.m[0][0] -= a.m[0][0];
        this.m[0][1] -= a.m[0][1];
        this.m[1][0] -= a.m[1][0];
        this.m[1][1] -= a.m[1][1];
        return this;
    }

    det(): number {
        return this.m[0][0] * this.m[1][1] - this.m[0][1] * this.m[1][0];
    }

    inverse(): Mat2 {
        const det = this.det();
        if (Math.abs(det) < 1e-12) return Mat2.identity();
        return new Mat2([
            [this.m[1][1] / det, -this.m[0][1] / det],
            [-this.m[1][0] / det, this.m[0][0] / det],
        ]);
    }

    trace(): number {
        return this.m[0][0] + this.m[1][1];
    }

    discrim(): number {
        return this.trace() ** 2 - 4 * this.det();
    }

    eigh(): { eigvals: [number, number]; eigvecs: [Vec2, Vec2] } {
        const b = this.m[0][1];
        const d = this.m[1][1];
        const discrim = this.discrim();

        let sqrtDisc = 0;
        if (discrim > 0) sqrtDisc = Math.sqrt(discrim);

        const trace = this.trace();
        const eig1 = (trace + sqrtDisc) / 2;
        const eig2 = (trace - sqrtDisc) / 2;

        let v1: Vec2;
        let v2: Vec2;

        if (Math.abs(b) > 1e-12) {
            v1 = new Vec2([eig1 - d, b]);
            v2 = new Vec2([eig2 - d, b]);
        } else {
            if (this.m[0][0] >= this.m[1][1]) {
                v1 = new Vec2([1, 0]);
                v2 = new Vec2([0, 1]);
            } else {
                v1 = new Vec2([0, 1]);
                v2 = new Vec2([1, 0]);
            }
        }

        v1 = v1.normalize();
        v2 = v2.normalize();

        return {
            eigvals: [eig1, eig2],
            eigvecs: [v1, v2],
        };
    }
    
    static bilerp(m00: Mat2, m10: Mat2, m01: Mat2, m11: Mat2, fx: number, fy: number): Mat2 {
        const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;
        return new Mat2([
            [lerp(lerp(m00.m[0][0], m10.m[0][0], fx), lerp(m01.m[0][0], m11.m[0][0], fx), fy),
            lerp(lerp(m00.m[0][1], m10.m[0][1], fx), lerp(m01.m[0][1], m11.m[0][1], fx), fy)],
            [lerp(lerp(m00.m[1][0], m10.m[1][0], fx), lerp(m01.m[1][0], m11.m[1][0], fx), fy),
            lerp(lerp(m00.m[1][1], m10.m[1][1], fx), lerp(m01.m[1][1], m11.m[1][1], fx), fy)]
        ]);
    }
}

export namespace Linalg {
    export const vec2 = Vec2;
    export const mat2 = Mat2;
}
