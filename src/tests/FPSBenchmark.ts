import * as THREE from 'three';
import { createScene } from '../utils/Environment';
import { Agent } from '../utils/Agent';
import { Simulator } from '../sim/Simulator';
import { MetricGrid } from '../sim/MetricGrid';
import { SpatialHash } from '../sim/SpatialHash';
import { Linalg } from '../utils/Linalg';

type Vec2 = InstanceType<typeof Linalg.vec2>;

const world = {
    x: 140,
    z: 140,
    cellSize: 1
};

const NORMAL_WALKING_SPEED = 5.0;
const defaultAgentCount = 1000;
const maxAgentCount = 2500;

const DEFAULT_SECONDS = 30;
const DEFAULT_WARMUP_SECONDS = 3;
const DEFAULT_DENSE_SPACING = 2.0;

const { renderer, scene, camera } = createScene(world.x, world.z);
renderer.shadowMap.enabled = false;
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NoToneMapping;

let agents: Agent[] = [];
let agentMeshes: THREE.Mesh[] = [];
let anchors: Vec2[] = [];
let goals: Vec2[] = [];

let simulator: Simulator;
let metricGrid: MetricGrid;
let spatialHash: SpatialHash;

let running = true;
let finished = false;

let renderFps = 0;
let frameCount = 0;
let fpsUpdateTime = performance.now();

let benchmarkStartTime = performance.now();
let samples: number[] = [];
let finalStats: BenchmarkStats | null = null;

const overlay = createOverlay();
const infoLabel = overlay.querySelector<HTMLDivElement>('.benchmark-info')!;

interface BenchmarkStats {
    agents: number;
    spacing: number;
    warmupSeconds: number;
    measuredSeconds: number;
    samples: number;
    meanStepMs: number;
    medianStepMs: number;
    p95StepMs: number;
    p99StepMs: number;
    maxStepMs: number;
    minStepMs: number;
    stdStepMs: number;
    meanSimHz: number;
    realtime60Hz: boolean;
}

function getNumberParam(name: string, fallback: number): number {
    const params = new URL(window.location.href).searchParams;
    const parsed = Number(params.get(name));

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return parsed;
}

function getAgentCount(): number {
    const parsed = getNumberParam('count', defaultAgentCount);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return defaultAgentCount;
    }

    return Math.min(maxAgentCount, Math.max(10, Math.round(parsed)));
}

function getBenchmarkSeconds(): number {
    return Math.max(1, getNumberParam('seconds', DEFAULT_SECONDS));
}

function getWarmupSeconds(): number {
    return Math.max(0, getNumberParam('warmup', DEFAULT_WARMUP_SECONDS));
}

function getDenseSpacing(): number {
    return Math.max(0.5, getNumberParam('spacing', DEFAULT_DENSE_SPACING));
}

function createOverlay(): HTMLDivElement {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.top = '16px';
    container.style.right = '16px';
    container.style.zIndex = '10';
    container.style.padding = '14px 16px';
    container.style.background = 'rgba(8, 12, 24, 0.88)';
    container.style.color = '#eef';
    container.style.fontFamily = 'system-ui, sans-serif';
    container.style.fontSize = '13px';
    container.style.lineHeight = '1.5';
    container.style.border = '1px solid rgba(120, 160, 240, 0.18)';
    container.style.borderRadius = '12px';
    container.style.maxWidth = '330px';
    container.style.pointerEvents = 'none';
    container.style.whiteSpace = 'pre-line';

    const title = document.createElement('div');
    title.textContent = 'Dense Worst-Case Benchmark';
    title.style.fontWeight = '700';
    title.style.marginBottom = '8px';
    title.style.color = '#c8d7ff';

    const description = document.createElement('div');
    description.textContent =
        'Synthetic dense local-density stress test. Only simulator.step() is timed.';
    description.style.marginBottom = '10px';
    description.style.color = '#9ab';

    const info = document.createElement('div');
    info.className = 'benchmark-info';
    info.textContent = 'Initializing…';

    const hint = document.createElement('div');
    hint.textContent = 'URL: ?count=1000&seconds=30&warmup=3&spacing=2.0';
    hint.style.marginTop = '10px';
    hint.style.color = '#7a8ebf';
    hint.style.fontSize = '12px';

    container.appendChild(title);
    container.appendChild(description);
    container.appendChild(info);
    container.appendChild(hint);
    document.body.appendChild(container);

    return container;
}

function createAgentMesh(color: number): THREE.Mesh {
    const geometry = new THREE.CylinderGeometry(1.0, 1.0, 2.2, 8);
    const material = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
}

function buildDenseAnchorPositions(agentCount: number, spacing: number): Vec2[] {
    const result: Vec2[] = [];

    const cols = Math.ceil(Math.sqrt(agentCount));
    const rows = Math.ceil(agentCount / cols);

    const startX = -((cols - 1) * spacing) * 0.5;
    const startZ = -((rows - 1) * spacing) * 0.5;

    for (let i = 0; i < agentCount; i++) {
        const row = Math.floor(i / cols);
        const col = i % cols;

        const x = startX + col * spacing;
        const z = startZ + row * spacing;

        result.push(new Linalg.vec2([x, z]) as Vec2);
    }

    return result;
}

function buildBenchmarkGoals(anchorPositions: Vec2[]): Vec2[] {
    const result: Vec2[] = [];
    const halfX = world.x * 0.5 - 5;
    const halfZ = world.z * 0.5 - 5;

    for (let i = 0; i < anchorPositions.length; i++) {
        const anchor = anchorPositions[i]!;
        const mode = i % 4;

        let gx = 0;
        let gz = 0;

        if (mode === 0) {
            gx = halfX;
            gz = anchor.v[1];
        } else if (mode === 1) {
            gx = -halfX;
            gz = anchor.v[1];
        } else if (mode === 2) {
            gx = anchor.v[0];
            gz = halfZ;
        } else {
            gx = anchor.v[0];
            gz = -halfZ;
        }

        result.push(new Linalg.vec2([gx, gz]) as Vec2);
    }

    return result;
}

function setAgentVelocityTowardGoal(agent: Agent): void {
    const dx = agent.goal.v[0] - agent.pos.v[0];
    const dz = agent.goal.v[1] - agent.pos.v[1];
    const len = Math.hypot(dx, dz) || 1;

    agent.vel.v[0] = (dx / len) * agent.speed;
    agent.vel.v[1] = (dz / len) * agent.speed;
}

function resetAgentToDenseState(index: number): void {
    const agent = agents[index]!;
    const mesh = agentMeshes[index]!;
    const anchor = anchors[index]!;
    const goal = goals[index]!;

    agent.pos.v[0] = anchor.v[0];
    agent.pos.v[1] = anchor.v[1];

    agent.goal.v[0] = goal.v[0];
    agent.goal.v[1] = goal.v[1];

    agent.arrived = false;

    setAgentVelocityTowardGoal(agent);

    mesh.position.set(anchor.v[0], 1.1, anchor.v[1]);
}

function resetAllAgentsToDenseState(): void {
    for (let i = 0; i < agents.length; i++) {
        resetAgentToDenseState(i);
    }
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, x) => sum + x, 0) / values.length;
}

function percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;

    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
    );

    return sortedValues[index]!;
}

function std(values: number[], avg: number): number {
    if (values.length === 0) return 0;

    const variance =
        values.reduce((sum, x) => {
            const d = x - avg;
            return sum + d * d;
        }, 0) / values.length;

    return Math.sqrt(variance);
}

function computeStats(): BenchmarkStats {
    const sorted = [...samples].sort((a, b) => a - b);
    const avg = mean(samples);
    const spacing = getDenseSpacing();

    return {
        agents: agents.length,
        spacing,
        warmupSeconds: getWarmupSeconds(),
        measuredSeconds: getBenchmarkSeconds(),
        samples: samples.length,
        meanStepMs: avg,
        medianStepMs: percentile(sorted, 50),
        p95StepMs: percentile(sorted, 95),
        p99StepMs: percentile(sorted, 99),
        maxStepMs: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
        minStepMs: sorted.length > 0 ? sorted[0]! : 0,
        stdStepMs: std(samples, avg),
        meanSimHz: avg > 0 ? 1000 / avg : 0,
        realtime60Hz: avg > 0 && avg <= 1000 / 60
    };
}

function finishBenchmark(): void {
    if (finished) return;

    finished = true;
    running = false;
    finalStats = computeStats();

    console.log('Dense worst-case benchmark finished.');
    console.table([finalStats]);
    console.log(JSON.stringify(finalStats, null, 2));

    updateOverlay();
}

function updateOverlay(): void {
    const now = performance.now();
    const elapsedSeconds = (now - benchmarkStartTime) / 1000;
    const warmupSeconds = getWarmupSeconds();
    const measuredSeconds = getBenchmarkSeconds();

    if (finalStats) {
        infoLabel.textContent =
            `DONE\n` +
            `Agents: ${finalStats.agents}\n` +
            `Spacing: ${finalStats.spacing.toFixed(2)}\n` +
            `Samples: ${finalStats.samples}\n` +
            `Mean: ${finalStats.meanStepMs.toFixed(3)} ms (${finalStats.meanSimHz.toFixed(1)} Hz)\n` +
            `Median: ${finalStats.medianStepMs.toFixed(3)} ms\n` +
            `p95: ${finalStats.p95StepMs.toFixed(3)} ms\n` +
            `p99: ${finalStats.p99StepMs.toFixed(3)} ms\n` +
            `Max: ${finalStats.maxStepMs.toFixed(3)} ms\n` +
            `Std: ${finalStats.stdStepMs.toFixed(3)} ms\n` +
            `60 Hz target: ${finalStats.realtime60Hz ? 'PASS ✓' : 'FAIL ✗'}\n` +
            `Render fps: ${renderFps.toFixed(1)}`;
        return;
    }

    if (elapsedSeconds < warmupSeconds) {
        const remaining = Math.max(0, warmupSeconds - elapsedSeconds);
        infoLabel.textContent =
            `Agents: ${agents.length}\n` +
            `Spacing: ${getDenseSpacing().toFixed(2)}\n` +
            `Warmup: ${remaining.toFixed(1)}s left\n` +
            `Samples: ${samples.length}\n` +
            `Render fps: ${renderFps.toFixed(1)}`;
        return;
    }

    const measureElapsed = Math.min(
        measuredSeconds,
        Math.max(0, elapsedSeconds - warmupSeconds)
    );

    const currentMean = mean(samples);
    const currentHz = currentMean > 0 ? 1000 / currentMean : 0;

    infoLabel.textContent =
        `Agents: ${agents.length}\n` +
        `Spacing: ${getDenseSpacing().toFixed(2)}\n` +
        `Measuring: ${measureElapsed.toFixed(1)} / ${measuredSeconds.toFixed(1)}s\n` +
        `Samples: ${samples.length}\n` +
        `Current mean: ${currentMean.toFixed(3)} ms (${currentHz.toFixed(1)} Hz)\n` +
        `Render fps: ${renderFps.toFixed(1)}`;
}

function init(): void {
    const agentCount = getAgentCount();
    const spacing = getDenseSpacing();

    const baseMesh = createAgentMesh(0x77caff);

    anchors = buildDenseAnchorPositions(agentCount, spacing);
    goals = buildBenchmarkGoals(anchors);

    for (let i = 0; i < agentCount; i++) {
        const anchor = anchors[i]!;
        const goal = goals[i]!;

        const pos = new Linalg.vec2([anchor.v[0], anchor.v[1]]) as Vec2;
        const agentGoal = new Linalg.vec2([goal.v[0], goal.v[1]]) as Vec2;

        const mesh = baseMesh.clone();
        mesh.position.set(pos.v[0], 1.1, pos.v[1]);
        scene.add(mesh);
        agentMeshes.push(mesh);

        const agent = new Agent(i, mesh, 1, pos, agentGoal, NORMAL_WALKING_SPEED);

        const dx = agentGoal.v[0] - pos.v[0];
        const dz = agentGoal.v[1] - pos.v[1];
        agent.vel = new Linalg.vec2([dx, dz]) as Vec2;
        agent.vel = agent.vel.normalize().mulScalar(agent.speed) as Vec2;

        agents.push(agent);
    }

    metricGrid = new MetricGrid(world.x, world.z, world.cellSize);
    spatialHash = new SpatialHash(2.0);
    simulator = new Simulator(agents, [], metricGrid, spatialHash);

    resetAllAgentsToDenseState();

    benchmarkStartTime = performance.now();

    updateOverlay();
}

function animate(): void {
    requestAnimationFrame(animate);

    if (running && simulator) {
        const now = performance.now();
        const elapsedSeconds = (now - benchmarkStartTime) / 1000;

        const warmupSeconds = getWarmupSeconds();
        const measuredSeconds = getBenchmarkSeconds();

        resetAllAgentsToDenseState();

        const stepStart = performance.now();
        simulator.step();
        const stepMs = performance.now() - stepStart;

        if (elapsedSeconds >= warmupSeconds) {
            samples.push(stepMs);
        }

        if (elapsedSeconds >= warmupSeconds + measuredSeconds) {
            finishBenchmark();
        }
    }

    renderer.render(scene, camera);

    frameCount += 1;
    const now = performance.now();
    const elapsed = now - fpsUpdateTime;

    if (elapsed >= 500) {
        renderFps = (frameCount * 1000) / elapsed;
        frameCount = 0;
        fpsUpdateTime = now;
        updateOverlay();
    }
}

init();
animate();