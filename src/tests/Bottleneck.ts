import * as THREE from 'three';
import { createScene, registerScenarioRestart } from '../utils/Environment';
import { Agent } from '../utils/Agent';
import { Wall } from '../utils/Wall';
import { Simulator } from '../sim/Simulator';
import { MetricGrid } from '../sim/MetricGrid';
import { SpatialHash } from '../sim/SpatialHash';
import { Vec2 } from '../utils/Linalg';

const world = {
    x: 100,
    z: 100,
    cellSize: 1
};

const NORMAL_WALKING_SPEED = 5.0;
const GOAL_X = 75;
const GAP_HALF = 3;
const WALL_LEN = 45;
const WALL_T = 1;
const SPAWN_ROWS = 16;
const SPAWN_COLS = 14;
const SPAWN_SPACING = 3.2;
const SPAWN_X_START = -64;
const SPAWN_Z_START = -((SPAWN_ROWS - 1) * SPAWN_SPACING) / 2;
const TRAIL_EVERY = 1;

const agentGeometry = new THREE.CylinderGeometry(1, 1, 4, 16);
const agentMaterial = new THREE.MeshLambertMaterial({ color: 0x00ff00 });
const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0xe3e3e3,
    metalness: 0.4,
    roughness: 0.3
});

const { renderer, scene, camera } = createScene(world.x, world.z);

let agents: Agent[] = [];
let walls: Wall[] = [];
let simulator: Simulator;
let metricGrid: MetricGrid;
let spatialHash: SpatialHash;
let running = true;

function deterministicJitter(i: number, scale: number): number {
    return scale * Math.sin(i * 12.9898 + 78.233);
}

function createWall(zMin: number, zMax: number): Wall {
    const length = zMax - zMin;
    const midZ = (zMin + zMax) / 2;
    const geometry = new THREE.BoxGeometry(WALL_T, 6, length);
    const mesh = new THREE.Mesh(geometry, wallMaterial);
    mesh.position.set(0, 3, midZ);
    return new Wall(
        new Vec2([0, zMin]),
        new Vec2([0, zMax]),
        WALL_T,
        mesh
    );
}

function clearDynamicObjects() {
    for (const agent of agents) {
        scene.remove(agent.mesh);
        if (agent.trailMesh) scene.remove(agent.trailMesh);
        if (agent.trailGlowMesh) scene.remove(agent.trailGlowMesh);
    }

    for (const wall of walls) {
        scene.remove(wall.mesh);
    }

    agents = [];
    walls = [];
}

function restartScenario() {
    running = true;
    clearDynamicObjects();
    lastTime = performance.now();
    init();
}

function init() {
    agents = [];
    walls = [];
    let id = 0;

    const topWall = createWall(GAP_HALF, GAP_HALF + WALL_LEN);
    const bottomWall = createWall(-GAP_HALF - WALL_LEN, -GAP_HALF);
    walls.push(topWall, bottomWall);
    scene.add(topWall.mesh);
    scene.add(bottomWall.mesh);

    for (let c = 0; c < SPAWN_COLS; c++) {
        for (let r = 0; r < SPAWN_ROWS; r++) {
            const x = SPAWN_X_START + c * SPAWN_SPACING + deterministicJitter(id, 0.25);
            const z = SPAWN_Z_START + r * SPAWN_SPACING + deterministicJitter(id + 1000, 0.25);
            const pos = new Vec2([x, z]);
            const goal = new Vec2([2, 0]);
            const mesh = new THREE.Mesh(agentGeometry, agentMaterial);
            const agent = new Agent(id++, mesh, 1, pos, goal, NORMAL_WALKING_SPEED);
            agent.vel = goal.sub(pos).normalize().mulScalar(agent.speed);
            agents.push(agent);
            scene.add(agent.mesh);
            if (TRAIL_EVERY > 0 && id % TRAIL_EVERY === 0) {
                agent.createTrail(scene);
            }
        }
    }

    metricGrid = new MetricGrid(world.x, world.z, world.cellSize);
    spatialHash = new SpatialHash(2.0);
    simulator = new Simulator(agents, walls, metricGrid, spatialHash);
}

function updateGoals() {
    for (const agent of agents) {
        if (!agent.arrived && agent.pos.v[0] < 2) {
            agent.goal = new Vec2([2, 0]);
        } else {
            agent.goal = new Vec2([GOAL_X, 0]);
        }
    }
}

let lastTime = performance.now();

function animate(now: number = performance.now()) {
    requestAnimationFrame(animate);
    const realDt = (now - lastTime) / 1000;
    lastTime = now;

    if (running && simulator) {
        updateGoals();
        simulator.advance(realDt);
    }

    renderer.render(scene, camera);
}

registerScenarioRestart(restartScenario);
init();
requestAnimationFrame(animate);