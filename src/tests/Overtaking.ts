import * as THREE from 'three';
import { createScene } from '../utils/Environment';
import { Agent } from '../utils/Agent';
import { Simulator } from '../sim/Simulator';
import { MetricGrid } from '../sim/MetricGrid';
import { SpatialHash } from '../sim/SpatialHash'
import { Linalg } from '../utils/Linalg';

const world = {
    x: 100,
    z: 100, 
    N: 50,
    cellSize: 1
};

const NORMAL_WALKING_SPEED = 2.5; // ~1.25 m/s if 1 unit = 0.25 m
const FAST_WALKING_SPEED = 7.0;   // brisk pace for overtaking agents

const agentGeometry = new THREE.CylinderGeometry(1, 1, 4, 16);
const agentMaterial1 = new THREE.MeshLambertMaterial({ color: 0x00ff00 });
const agentMaterial2 = new THREE.MeshLambertMaterial({ color: 0xff0000 });

const { renderer, scene, camera } = createScene(world.x, world.z);

let agent1: Agent, agent2: Agent, simulator: Simulator, metricGrid: MetricGrid, spatialHash: SpatialHash;
let running = true;

function init() {
    agent1 = new Agent(
        1, new THREE.Mesh(agentGeometry, agentMaterial1), 1,
        new Linalg.vec2([-20, -20]),
        new Linalg.vec2([20, 20]),
        NORMAL_WALKING_SPEED
    );

    agent2 = new Agent(
        2, new THREE.Mesh(agentGeometry, agentMaterial2), 1,
        new Linalg.vec2([-30, -30]),
        new Linalg.vec2([20, 20]),
        FAST_WALKING_SPEED
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

    if (running && simulator) simulator.advance(realDt);

    renderer.render(scene, camera);
}

init();
requestAnimationFrame(animate);
