import * as THREE from 'three';
import { createScene, registerScenarioRestart } from '../utils/Environment';
import { Agent } from '../utils/Agent';
import { Simulator } from '../sim/Simulator';
import { MetricGrid } from '../sim/MetricGrid';
import { SpatialHash } from '../sim/SpatialHash';
import { Linalg } from '../utils/Linalg';

const world = {
    x: 100,
    z: 100,
    N: 50,
    cellSize: 1
};

const NORMAL_WALKING_SPEED = 5.0;

const agentGeometry = new THREE.CylinderGeometry(1, 1, 4, 16);
const agentMaterial1 = new THREE.MeshLambertMaterial({ color: 0x00ff00 });
const agentMaterial2 = new THREE.MeshLambertMaterial({ color: 0xff0000 });

const { renderer, scene, camera } = createScene(world.x, world.z);

let agent1: Agent | undefined;
let agent2: Agent | undefined;
let simulator: Simulator;
let metricGrid: MetricGrid;
let spatialHash: SpatialHash;
let running = true;

function clearAgents() {
    if (agent1) {
        scene.remove(agent1.mesh);
        if (agent1.trailMesh) scene.remove(agent1.trailMesh);
        if (agent1.trailGlowMesh) scene.remove(agent1.trailGlowMesh);
    }

    if (agent2) {
        scene.remove(agent2.mesh);
        if (agent2.trailMesh) scene.remove(agent2.trailMesh);
        if (agent2.trailGlowMesh) scene.remove(agent2.trailGlowMesh);
    }
}

function restartScenario() {
    running = true;
    clearAgents();
    lastTime = performance.now();
    init();
}

function init() {
    agent1 = new Agent(
        1,
        new THREE.Mesh(agentGeometry, agentMaterial1),
        1,
        new Linalg.vec2([-20, -20]),
        new Linalg.vec2([20, 20]),
        NORMAL_WALKING_SPEED
    );

    agent2 = new Agent(
        2,
        new THREE.Mesh(agentGeometry, agentMaterial2),
        1,
        new Linalg.vec2([20, 20]),
        new Linalg.vec2([-20, -20]),
        NORMAL_WALKING_SPEED
    );

    metricGrid = new MetricGrid(world.x, world.z, world.cellSize);
    spatialHash = new SpatialHash(2.0);
    simulator = new Simulator([agent1, agent2], [], metricGrid, spatialHash);

    scene.add(agent1.mesh);
    scene.add(agent2.mesh);

    agent1.createTrail(scene);
    agent2.createTrail(scene);
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

registerScenarioRestart(restartScenario);
init();
requestAnimationFrame(animate);
