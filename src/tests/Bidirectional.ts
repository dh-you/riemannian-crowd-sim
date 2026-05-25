import * as THREE from 'three';
import { createScene } from '../utils/Environment';
import { Agent } from '../utils/Agent';
import { Simulator } from '../sim/Simulator';
import { MetricGrid } from '../sim/MetricGrid';
import { SpatialHash } from '../sim/SpatialHash';
import { Linalg } from '../utils/Linalg';
const world = {
    x: 100,
    z: 100,
    cellSize: 1
};
const NORMAL_WALKING_SPEED = 5.0; 
const agentGeometry = new THREE.CylinderGeometry(1, 1, 4, 16);
const { renderer, scene, camera } = createScene(world.x, world.z);
let agents: Agent[];
let simulator: Simulator;
let metricGrid: MetricGrid;
let spatialHash: SpatialHash;
let running = true;
const ROWS = 8;
const COLS = 15;
const SPACING = 3.75;
const A_LEAD = -18;
const B_LEAD = 18;
const ROW_PHASE = 0.75;
const B_Z_OFFSET = SPACING * 0.45;
const JITTER = 0.25;
const GOAL_X = 80;
function deterministicJitter(r: number, c: number, scale: number): number {
    return scale * Math.sin(12.9898 * r + 78.233 * c);
}
function init() {
    agents = [];
    let id = 0;
    const rightMaterial = new THREE.MeshLambertMaterial({ color: 0x00ff00 }); 
    const leftMaterial = new THREE.MeshLambertMaterial({ color: 0xff0000 });  
    const zStart = -((ROWS - 1) * SPACING) / 2;
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            const z =
                zStart +
                r * SPACING +
                deterministicJitter(r, c, JITTER);
            const x = A_LEAD - c * SPACING - r * ROW_PHASE;
            const pos = new Linalg.vec2([x, z]);
            const goal = new Linalg.vec2([GOAL_X, z]);
            const mesh = new THREE.Mesh(agentGeometry, rightMaterial);
            const agent = new Agent(id++, mesh, 1, pos, goal, NORMAL_WALKING_SPEED);
            agent.vel = goal.sub(pos).normalize().mulScalar(agent.speed);
            agents.push(agent);
            scene.add(agent.mesh);
            agent.createTrail(scene);
        }
    }
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            const z =
                zStart +
                r * SPACING +
                B_Z_OFFSET +
                deterministicJitter(r + 17, c + 31, JITTER);
            const x = B_LEAD + c * SPACING + (ROWS - 1 - r) * ROW_PHASE;
            const pos = new Linalg.vec2([x, z]);
            const goal = new Linalg.vec2([-GOAL_X, z]);
            const mesh = new THREE.Mesh(agentGeometry, leftMaterial);
            const agent = new Agent(id++, mesh, 1, pos, goal, NORMAL_WALKING_SPEED);
            agent.vel = goal.sub(pos).normalize().mulScalar(agent.speed);
            agents.push(agent);
            scene.add(agent.mesh);
            agent.createTrail(scene);
        }
    }
    metricGrid = new MetricGrid(world.x, world.z, world.cellSize);
    spatialHash = new SpatialHash(2.0);
    simulator = new Simulator(agents, [], metricGrid, spatialHash);
}
let lastTime = performance.now();
function animate(now: number = performance.now()) {
    requestAnimationFrame(animate);
    const realDt = (now - lastTime) / 1000;
    lastTime = now;
    if (running && simulator) {
        simulator.advance(realDt);
    }
    renderer.render(scene, camera);
}
init();
requestAnimationFrame(animate);