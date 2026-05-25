import { Agent } from "../utils/Agent";
import { Wall } from "../utils/Wall";
import { Vec2, Mat2 } from "../utils/Linalg";
import { Formulation } from "./Formulation";
import { MetricGrid } from "./MetricGrid";
import { SpatialHash } from "./SpatialHash";
export class Simulator {
    agents: Agent[];
    walls: Wall[];
    metricGrid: MetricGrid;
    spatialHash: SpatialHash;
    sigma: number = 4.0;
    alpha: number = 20.0;
    lambda_r: number = 20.0;
    lambda_l: number = 1.0;
    momentum: number = 0.65;
    readonly simDt: number = 1 / 60;
    private accumulator: number = 0;
    private readonly maxAccum: number = 0.25;
    rotBias: number = -0.05;
    rotBiasCos: number;
    rotBiasSin: number;
    visualizeGrid: boolean = false;
    velocityGateEnabled: boolean = true;
    velocityGateBase: number = 0.0;   
    velocityGateVRef: number = 5.0;   
    frontGateEnabled: boolean = true;
    frontGateBeta: number = 0.12;
    frontGateBase: number = 0.05;
    maxAgentRadius: number = 0;
    constructor(
        agents: Agent[],
        walls: Wall[],
        metricGrid: MetricGrid,
        spatialHash: SpatialHash
    ) {
        this.agents = agents;
        this.walls = walls;
        this.metricGrid = metricGrid;
        this.spatialHash = spatialHash;
        this.maxAgentRadius =
            agents.length > 0 ? Math.max(...agents.map(a => a.radius)) : 0;
        this.rotBiasCos = Math.cos(-this.rotBias);
        this.rotBiasSin = Math.sin(-this.rotBias);
    }
    isFiniteVec(v: Vec2): boolean {
        return Number.isFinite(v.v[0]) && Number.isFinite(v.v[1]);
    }
    smoothstep(edge0: number, edge1: number, x: number): number {
        if (Math.abs(edge1 - edge0) < 1e-8) {
            return x < edge0 ? 0 : 1;
        }
        const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
    }
    headingOf(agent: Agent): Vec2 {
        let h = agent.vel;
        if (!this.isFiniteVec(h) || h.hypot() < 1e-6) {
            h = agent.goal.sub(agent.pos);
        }
        if (!this.isFiniteVec(h) || h.hypot() < 1e-6) {
            return new Vec2([1, 0]);
        }
        return h.normalize();
    }
    velocityAwareGate(agent: Agent, other: Agent): number {
        const r = new Vec2([
            other.pos.v[0] - agent.pos.v[0],
            other.pos.v[1] - agent.pos.v[1]
        ]);
        const dist = r.hypot();
        if (dist < 1e-8) return 1.0;
        r.mulScalarInPlace(1 / dist);
        const closing = Math.max(0, agent.vel.sub(other.vel).dot(r));
        const closingGate = this.smoothstep(0.0, this.velocityGateVRef, closing);
        let frontGate = 1.0;
        if (this.frontGateEnabled) {
            const h = this.headingOf(agent);
            const frontDot = h.dot(r);
            const rawFrontGate = this.smoothstep(
                -this.frontGateBeta,
                this.frontGateBeta,
                frontDot
            );
            frontGate =
                this.frontGateBase +
                (1.0 - this.frontGateBase) * rawFrontGate;
        }
        const eta =
            this.velocityGateBase +
            (1.0 - this.velocityGateBase) * frontGate * closingGate;
        return Math.max(0, Math.min(1, eta));
    }
    updateGrid() {
        this.metricGrid.initializeIdentity();
        for (const agent of this.agents) {
            const agentGridPos = this.metricGrid.worldToGrid(agent.pos);
            const sigma = this.sigma * agent.radius;
            const alpha = this.alpha * agent.radius;
            const gridRadius = Math.ceil(sigma / this.metricGrid.cellSize);
            const minI = Math.max(0, agentGridPos.i - gridRadius);
            const maxI = Math.min(this.metricGrid.width - 1, agentGridPos.i + gridRadius);
            const minJ = Math.max(0, agentGridPos.j - gridRadius);
            const maxJ = Math.min(this.metricGrid.height - 1, agentGridPos.j + gridRadius);
            for (let j = minJ; j <= maxJ; j++) {
                for (let i = minI; i <= maxI; i++) {
                    const worldPos = this.metricGrid.gridToWorld(i, j);
                    const d = worldPos.sub(agent.pos);
                    const dist = d.hypot();
                    if (dist > sigma) continue;
                    const warp = Formulation.deformationTensor(
                        d,
                        sigma,
                        alpha,
                        this.lambda_r,
                        this.lambda_l
                    );
                    this.metricGrid.addWarp(i, j, warp);
                }
            }
        }
    }
    sampleEffectiveMetric(agent: Agent, samplePos: Vec2): Mat2 {
        const g = Mat2.identity();
        const searchRadius = this.sigma * this.maxAgentRadius;
        for (const other of this.spatialHash.neighbors(agent, searchRadius)) {
            if (other === agent) continue;
            const sigma = this.sigma * other.radius;
            const alpha = this.alpha * other.radius;
            const d = samplePos.sub(other.pos);
            const dist = d.hypot();
            if (dist > sigma) continue;
            if (dist < 1e-6) continue;
            const eta = this.velocityGateEnabled
                ? this.velocityAwareGate(agent, other)
                : 1.0;
            if (eta <= 1e-8) continue;
            const W = Formulation.deformationTensor(
                d,
                sigma,
                alpha,
                this.lambda_r,
                this.lambda_l
            ).mulScalarInPlace(eta);
            g.addInPlace(W);
        }
        return g;
    }
    computeDir(agent: Agent, gEff: Mat2): Vec2 {
        const gInv = gEff.inverse();
        const gradPhi = new Vec2([
            agent.pos.v[0] - agent.goal.v[0],
            agent.pos.v[1] - agent.goal.v[1]
        ]).mulScalarInPlace(2);
        const metricStep = gInv.mulVec2(gradPhi);
        metricStep.mulScalarInPlace(-1);
        let dir: Vec2;
        if (this.isFiniteVec(metricStep) && metricStep.hypot() > 1e-8) {
            dir = metricStep.normalize();
        } else {
            const fallback = agent.goal.sub(agent.pos);
            if (fallback.hypot() > 1e-8) {
                dir = fallback.normalize();
            } else {
                return new Vec2([0, 0]);
            }
        }
        const cos = this.rotBiasCos;
        const sin = this.rotBiasSin;
        const biased = new Vec2([
            cos * dir.v[0] - sin * dir.v[1],
            sin * dir.v[0] + cos * dir.v[1]
        ]);
        if (!this.isFiniteVec(biased) || biased.hypot() < 1e-8) {
            return dir;
        }
        return biased.normalize();
    }
    computeSpeed(agent: Agent, dir: Vec2, gEff: Mat2): number {
        const R = Formulation.riemannianNorm(dir, gEff);
        return agent.speed / R;
    }
    integrate(agent: Agent, dt: number) {
        if (agent.pos.sub(agent.goal).hypot() < 0.1) {
            agent.vel = new Vec2([0, 0]);
            agent.arrived = true;
            return;
        }
        agent.arrived = false;
        const gEff = this.sampleEffectiveMetric(agent, agent.pos);
        const dir = this.computeDir(agent, gEff);
        const speed = this.computeSpeed(agent, dir, gEff);
        const targetVel = dir.mulScalar(speed);
        const oldPos = agent.pos;
        agent.vel = new Vec2([
            this.momentum * agent.vel.v[0] + (1 - this.momentum) * targetVel.v[0],
            this.momentum * agent.vel.v[1] + (1 - this.momentum) * targetVel.v[1]
        ]);
        const newPos = agent.pos.add(agent.vel.mulScalar(dt));
        if (!this.isFiniteVec(agent.vel) || !this.isFiniteVec(newPos)) {
            console.warn("Invalid agent state; resetting velocity.");
            agent.pos = oldPos;
            agent.vel = new Vec2([0, 0]);
            return;
        }
        agent.pos = newPos;
    }
    enforceAgentSeparation(padding = 0.003, iterations = 2) {
        const eps = 1e-8;
        const searchRadius = 2 * this.maxAgentRadius + padding;
        for (let iter = 0; iter < iterations; iter++) {
            this.spatialHash.rebuild(this.agents);
            for (const a of this.agents) {
                for (const b of this.spatialHash.neighbors(a, searchRadius)) {
                    if (b.id <= a.id) continue;
                    const minDist = a.radius + b.radius + padding;
                    const delta = new Vec2([
                        a.pos.v[0] - b.pos.v[0],
                        a.pos.v[1] - b.pos.v[1]
                    ]);
                    const dist = delta.hypot();
                    let n: Vec2;
                    let effectiveDist = dist;
                    if (dist > eps) {
                        n = delta.mulScalarInPlace(1 / dist);
                    } else {
                        const angle = (((a.id * 928371 + b.id * 1237) % 6283) / 1000);
                        n = new Vec2([Math.cos(angle), Math.sin(angle)]);
                        effectiveDist = eps;
                    }
                    const overlap = minDist - effectiveDist;
                    if (overlap <= 0) continue;
                    const push = n.mulScalar(overlap * 0.5);
                    a.pos.addInPlace(push);
                    b.pos.subInPlace(push);
                    const relVel = a.vel.sub(b.vel);
                    const relNormal = relVel.dot(n);
                    if (relNormal < 0) {
                        const correction = n.mulScalar(relNormal * 0.5);
                        a.vel = a.vel.sub(correction);
                        b.vel = b.vel.add(correction);
                    }
                }
            }
        }
    }
    enforceWalls(pushDist = 2.0) {
        for (const agent of this.agents) {
            for (const wall of this.walls) {
                const ab = wall.end.sub(wall.start);
                const abLen2 = ab.dot(ab);
                if (abLen2 < 1e-10) continue;
                const ap = agent.pos.sub(wall.start);
                const t = Math.max(0, Math.min(1, ap.dot(ab) / abLen2));
                const closest = wall.start.add(ab.mulScalar(t));
                const d = new Vec2([
                    agent.pos.v[0] - closest.v[0],
                    agent.pos.v[1] - closest.v[1]
                ]);
                const dist = d.hypot();
                if (dist < pushDist && dist > 1e-6) {
                    const dn = d.mulScalarInPlace(1 / dist);
                    agent.pos = closest.add(dn.mulScalar(pushDist));
                    const velTowardWall = agent.vel.dot(dn);
                    if (velTowardWall < 0) {
                        agent.vel = agent.vel.sub(dn.mulScalar(velTowardWall));
                    }
                }
            }
        }
    }
    step() {
        if (this.visualizeGrid) {
            this.updateGrid();
        }
        this.spatialHash.rebuild(this.agents);
        for (const agent of this.agents) {
            this.integrate(agent, this.simDt);
        }
        this.enforceAgentSeparation(0.003, 1);
        this.enforceWalls();
        this.enforceAgentSeparation(0.003, 1);
        for (const agent of this.agents) {
            agent.updateMeshPosition();
        }
    }
    advance(realDt: number) {
        this.accumulator = Math.min(this.accumulator + realDt, this.maxAccum);
        while (this.accumulator >= this.simDt) {
            this.step();
            this.accumulator -= this.simDt;
        }
    }
}