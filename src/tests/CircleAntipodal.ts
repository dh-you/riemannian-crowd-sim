import * as THREE from 'three';
import { createScene } from '../utils/Environment';
import { Agent } from '../utils/Agent';
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
const RADIUS = 40;
const NUM_AGENTS = 100;
const agentGeometry = new THREE.CylinderGeometry(1, 1, 4, 16);
const { renderer, scene, camera } = createScene(world.x, world.z);
let agents: Agent[];
let simulator: Simulator;
let metricGrid: MetricGrid;
let running = true;
function init() {
    agents = [];
    let id = 0;
    for (let i = 0; i < NUM_AGENTS; i++) {
        const angle = (2 * Math.PI * i) / NUM_AGENTS;
        const x = RADIUS * Math.cos(angle);
        const z = RADIUS * Math.sin(angle);
        const gx = -x;
        const gz = -z;
        const hue = i / NUM_AGENTS;
        const color = new THREE.Color().setHSL(hue, 0.9, 0.5);
        const material = new THREE.MeshLambertMaterial({ color });
        const pos = new Vec2([x, z]);
        const goal = new Vec2([gx, gz]);
        const mesh = new THREE.Mesh(agentGeometry, material);
        const agent = new Agent(id++, mesh, 1, pos, goal, NORMAL_WALKING_SPEED);
        agents.push(agent);
        scene.add(agent.mesh);
        agent.createTrail(scene);
    }
    metricGrid = new MetricGrid(world.x, world.z, world.cellSize);
    const spatialHash = new SpatialHash(2.0);
    simulator = new Simulator(agents, [], metricGrid, spatialHash);
}
let lastTime = performance.now();
function animate(now: number = performance.now()) {
    requestAnimationFrame(animate);
    const realDt = (now - lastTime) / 1000;
    lastTime = now;
    if (running && simulator) simulator.advance(realDt);
    renderer.render(scene, camera);
}
init();
requestAnimationFrame(animate);