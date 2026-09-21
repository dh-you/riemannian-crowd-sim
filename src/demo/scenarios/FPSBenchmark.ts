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

const { renderer, scene, camera } = createScene(world.x, world.z, { showRestartButton: false });
renderer.shadowMap.enabled = false;
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NoToneMapping;

interface BenchmarkConfig {
    count: number;
    seconds: number;
    warmup: number;
    spacing: number;
}

interface BenchmarkControls {
    countInput: HTMLInputElement;
    secondsInput: HTMLInputElement;
    warmupInput: HTMLInputElement;
    spacingInput: HTMLInputElement;
    runButton: HTMLButtonElement;
}

let agents: Agent[] = [];
let agentMeshes: THREE.Mesh[] = [];
let anchors: Vec2[] = [];
let goals: Vec2[] = [];

let simulator: Simulator;
let metricGrid: MetricGrid;
let spatialHash: SpatialHash;

let started = false;
let running = false;
let finished = false;

let renderFps = 0;
let frameCount = 0;
let fpsUpdateTime = performance.now();

let benchmarkStartTime = performance.now();
let samples: number[] = [];
let finalStats: BenchmarkStats | null = null;

const defaultConfig: BenchmarkConfig = {
    count: defaultAgentCount,
    seconds: DEFAULT_SECONDS,
    warmup: DEFAULT_WARMUP_SECONDS,
    spacing: DEFAULT_DENSE_SPACING,
};

let currentConfig: BenchmarkConfig = { ...defaultConfig };

const overlay = createOverlay();
const infoLabel = overlay.querySelector<HTMLDivElement>('.benchmark-info')!;
const controls = createControlsPanel();

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

function clampCount(value: number): number {
    return Math.min(maxAgentCount, Math.max(10, Math.round(value)));
}

function clampBenchmarkSeconds(value: number): number {
    return Math.max(1, Math.round(value));
}

function clampWarmupSeconds(value: number): number {
    return Math.max(0, Number(value.toFixed(1)));
}

function clampSpacing(value: number): number {
    return Math.max(0.5, Number(value.toFixed(2)));
}

function getNumberParam(name: string, fallback: number): number {
    const params = new URL(window.location.href).searchParams;
    const parsed = Number(params.get(name));

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return parsed;
}

function loadConfigFromURL(): BenchmarkConfig {
    return {
        count: clampCount(getNumberParam('count', defaultConfig.count)),
        seconds: clampBenchmarkSeconds(getNumberParam('seconds', defaultConfig.seconds)),
        warmup: clampWarmupSeconds(getNumberParam('warmup', defaultConfig.warmup)),
        spacing: clampSpacing(getNumberParam('spacing', defaultConfig.spacing)),
    };
}

function fillControlsFromConfig(config: BenchmarkConfig): void {
    controls.countInput.value = String(config.count);
    controls.secondsInput.value = String(config.seconds);
    controls.warmupInput.value = String(config.warmup.toFixed(1));
    controls.spacingInput.value = String(config.spacing.toFixed(2));
}

function readConfigFromControls(): BenchmarkConfig {
    return {
        count: clampCount(Number(controls.countInput.value)),
        seconds: clampBenchmarkSeconds(Number(controls.secondsInput.value)),
        warmup: clampWarmupSeconds(Number(controls.warmupInput.value)),
        spacing: clampSpacing(Number(controls.spacingInput.value)),
    };
}

function createOverlay(): HTMLDivElement {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.top = '84px';
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
    info.textContent = 'Waiting for user input…';

    const hint = document.createElement('div');
    hint.textContent = 'Set the values below and press Run to start the benchmark.';
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

function createControlsPanel(): BenchmarkControls {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.top = '48px';
    container.style.left = '16px';
    container.style.zIndex = '10';
    container.style.padding = '14px 16px';
    container.style.background = 'rgba(8, 12, 24, 0.88)';
    container.style.color = '#eef';
    container.style.fontFamily = 'system-ui, sans-serif';
    container.style.fontSize = '13px';
    container.style.border = '1px solid rgba(120, 160, 240, 0.18)';
    container.style.borderRadius = '12px';
    container.style.maxWidth = '330px';
    container.style.pointerEvents = 'auto';

    const title = document.createElement('div');
    title.textContent = 'Benchmark controls';
    title.style.fontWeight = '700';
    title.style.marginBottom = '10px';
    title.style.color = '#c8d7ff';

    const addField = (labelText: string, input: HTMLInputElement, step = '1') => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.gap = '12px';
        row.style.marginBottom = '10px';

        const label = document.createElement('label');
        label.textContent = labelText;
        label.style.color = '#dbe7ff';
        label.style.flex = '1';

        input.style.width = '96px';
        input.style.padding = '6px 8px';
        input.style.borderRadius = '8px';
        input.style.border = '1px solid rgba(120, 160, 240, 0.2)';
        input.style.background = 'rgba(8, 12, 24, 0.92)';
        input.style.color = '#eef';
        input.style.fontSize = '13px';
        input.step = step;

        row.appendChild(label);
        row.appendChild(input);
        container.appendChild(row);
    };

    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.min = '10';
    countInput.max = String(maxAgentCount);
    countInput.step = '10';

    const secondsInput = document.createElement('input');
    secondsInput.type = 'number';
    secondsInput.min = '1';
    secondsInput.step = '1';

    const warmupInput = document.createElement('input');
    warmupInput.type = 'number';
    warmupInput.min = '0';
    warmupInput.step = '0.1';

    const spacingInput = document.createElement('input');
    spacingInput.type = 'number';
    spacingInput.min = '0.5';
    spacingInput.step = '0.1';

    addField('Agents', countInput);
    addField('Seconds', secondsInput);
    addField('Warmup', warmupInput);
    addField('Spacing', spacingInput);

    const runButton = document.createElement('button');
    runButton.type = 'button';
    runButton.textContent = 'Run benchmark';
    runButton.style.marginTop = '6px';
    runButton.style.padding = '10px 14px';
    runButton.style.border = '1px solid rgba(120, 160, 240, 0.25)';
    runButton.style.borderRadius = '10px';
    runButton.style.background = 'rgba(24, 32, 52, 0.95)';
    runButton.style.color = '#eef';
    runButton.style.cursor = 'pointer';
    runButton.style.fontFamily = 'system-ui, sans-serif';
    runButton.style.fontSize = '13px';
    runButton.style.width = '100%';

    container.appendChild(runButton);
    document.body.appendChild(container);

    return { countInput, secondsInput, warmupInput, spacingInput, runButton };
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

function clearBenchmarkAgents(): void {
    for (const mesh of agentMeshes) {
        scene.remove(mesh);
    }
    agentMeshes = [];
    agents = [];
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

    return {
        agents: agents.length,
        spacing: currentConfig.spacing,
        warmupSeconds: currentConfig.warmup,
        measuredSeconds: currentConfig.seconds,
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
    if (!started) {
        infoLabel.textContent =
            `Ready to run\n` +
            `Agents: ${currentConfig.count}\n` +
            `Spacing: ${currentConfig.spacing.toFixed(2)}\n` +
            `Warmup: ${currentConfig.warmup.toFixed(1)}s\n` +
            `Seconds: ${currentConfig.seconds.toFixed(0)}s\n` +
            `Render fps: ${renderFps.toFixed(1)}`;
        return;
    }

    const now = performance.now();
    const elapsedSeconds = (now - benchmarkStartTime) / 1000;
    const warmupSeconds = currentConfig.warmup;
    const measuredSeconds = currentConfig.seconds;

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
            `Spacing: ${currentConfig.spacing.toFixed(2)}\n` +
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
        `Spacing: ${currentConfig.spacing.toFixed(2)}\n` +
        `Measuring: ${measureElapsed.toFixed(1)} / ${measuredSeconds.toFixed(1)}s\n` +
        `Samples: ${samples.length}\n` +
        `Current mean: ${currentMean.toFixed(3)} ms (${currentHz.toFixed(1)} Hz)\n` +
        `Render fps: ${renderFps.toFixed(1)}`;
}

function init(): void {
    clearBenchmarkAgents();

    const agentCount = currentConfig.count;
    const spacing = currentConfig.spacing;

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

function startBenchmark(): void {
    currentConfig = readConfigFromControls();
    started = true;
    running = true;
    finished = false;
    finalStats = null;
    samples = [];
    renderFps = 0;
    frameCount = 0;
    fpsUpdateTime = performance.now();
    clearBenchmarkAgents();
    benchmarkStartTime = performance.now();
    init();
    updateOverlay();
}

function animate(): void {
    requestAnimationFrame(animate);

    if (started && running && simulator) {
        const now = performance.now();
        const elapsedSeconds = (now - benchmarkStartTime) / 1000;

        const warmupSeconds = currentConfig.warmup;
        const measuredSeconds = currentConfig.seconds;

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

const initialConfig = loadConfigFromURL();
currentConfig = initialConfig;
fillControlsFromConfig(currentConfig);
updateOverlay();
controls.runButton.addEventListener('click', startBenchmark);
animate();