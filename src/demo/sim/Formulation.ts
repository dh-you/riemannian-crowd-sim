import { Vec2, Mat2 } from "../utils/Linalg";

export class Formulation {
    static wendland(s : number) {
        if (s > 1.0) return 0.0;
        return (1.0 + 4.0 * s) * (1.0 - s) ** 4;
    }

    static anisotropicMatrix(d : Vec2, lambda_r : number, lambda_l : number) {
        const dhat = d.normalize();
        const P = Mat2.projection(dhat);
        const Pperp = Mat2.identity().sub(P);

        return P.mulScalar(lambda_r).add(Pperp.mulScalar(lambda_l));
    }

    static deformationTensor(d : Vec2, sigma: number, alpha : number, lambda_r : number, lambda_l : number) {
        const dist = d.hypot();
        if (dist < 1e-6) return Mat2.zero();
        const s = dist / sigma;

        return this.anisotropicMatrix(d, lambda_r, lambda_l).mulScalarInPlace(alpha * this.wendland(s));
    }

    static riemannianNorm(dir: Vec2, gMetric: Mat2) {
        const q = dir.dot(gMetric.mulVec2(dir));

        if (!Number.isFinite(q) || q <= 1e-8) {
            return 1e-4;
        }

        return Math.sqrt(q);
    }
}