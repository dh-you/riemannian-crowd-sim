import * as THREE from 'three';
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import type { MetricGrid } from "../sim/MetricGrid";
import oipTextureUrl from '../../public/OIP.jpg?url';

let renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera;
let composer: EffectComposer;

// Figure export resolution (long edge in pixels). 3000 is plenty for LNCS print.
const FIGURE_LONG_EDGE = 3000;
const DEFAULT_VIEW_TARGET = new THREE.Vector3(0, 0, 0);
const DEFAULT_VIEW_POSITION = new THREE.Vector3(0, 120, 0);
const DEFAULT_VIEW_UP = new THREE.Vector3(0, 1, 0);

function applyTopDownView(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
    camera.position.copy(DEFAULT_VIEW_POSITION);
    camera.up.copy(DEFAULT_VIEW_UP);
    controls.target.copy(DEFAULT_VIEW_TARGET);
    camera.lookAt(DEFAULT_VIEW_TARGET);
    controls.update();
}

export function createScene(x: number, z: number) {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Tone mapping is now handled by OutputPass at the end of the composer chain.
    // Leaving ACES on the renderer here would tone-map twice and crush the bloom.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    const screenshotButton = document.createElement('button');
    screenshotButton.type = 'button';
    screenshotButton.textContent = 'Download figure (top view)';
    screenshotButton.style.position = 'fixed';
    screenshotButton.style.bottom = '16px';
    screenshotButton.style.right = '16px';
    screenshotButton.style.zIndex = '20';
    screenshotButton.style.padding = '10px 14px';
    screenshotButton.style.border = '1px solid rgba(120, 160, 240, 0.25)';
    screenshotButton.style.borderRadius = '10px';
    screenshotButton.style.background = 'rgba(24, 32, 52, 0.95)';
    screenshotButton.style.color = '#eef';
    screenshotButton.style.cursor = 'pointer';
    screenshotButton.style.fontFamily = 'system-ui, sans-serif';
    screenshotButton.style.fontSize = '13px';
    screenshotButton.addEventListener('click', () => captureFigureScreenshot(renderer, scene, { x, z }));
    document.body.appendChild(screenshotButton);

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.textContent = 'Reset camera';
    resetButton.style.position = 'fixed';
    resetButton.style.bottom = '60px';
    resetButton.style.right = '16px';
    resetButton.style.zIndex = '20';
    resetButton.style.padding = '10px 14px';
    resetButton.style.border = '1px solid rgba(120, 160, 240, 0.25)';
    resetButton.style.borderRadius = '10px';
    resetButton.style.background = 'rgba(24, 32, 52, 0.95)';
    resetButton.style.color = '#eef';
    resetButton.style.cursor = 'pointer';
    resetButton.style.fontFamily = 'system-ui, sans-serif';
    resetButton.style.fontSize = '13px';
    document.body.appendChild(resetButton);

    const controlsHint = document.createElement('div');
    controlsHint.textContent = 'drag to rotate · right-drag to pan · scroll to zoom';
    controlsHint.style.position = 'fixed';
    controlsHint.style.top = '16px';
    controlsHint.style.right = '16px';
    controlsHint.style.zIndex = '20';
    controlsHint.style.padding = '6px 10px';
    controlsHint.style.borderRadius = '999px';
    controlsHint.style.background = 'rgba(11, 18, 32, 0.86)';
    controlsHint.style.color = 'rgba(238, 238, 255, 0.95)';
    controlsHint.style.fontFamily = 'system-ui, sans-serif';
    controlsHint.style.fontSize = '12px';
    controlsHint.style.pointerEvents = 'none';
    controlsHint.style.backdropFilter = 'blur(6px)';
    document.body.appendChild(controlsHint);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1220);
    scene.fog = new THREE.FogExp2(0x0b1220, 0.0018);

    camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.5, 1200);

    composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    composer.setSize(window.innerWidth, window.innerHeight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.addEventListener('change', render);
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.minDistance = 8;
    controls.maxDistance = 140;
    controls.maxPolarAngle = Math.PI * 0.48;
    applyTopDownView(camera as THREE.PerspectiveCamera, controls);
    controls.saveState();
    resetButton.addEventListener('click', () => {
        applyTopDownView(camera as THREE.PerspectiveCamera, controls);
        controls.saveState();
        render();
    });

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0x99bbff, 0x220022, 0.25);
    hemiLight.position.set(0, 50, 0);
    scene.add(hemiLight);

    const directionalLight = new THREE.DirectionalLight(0xfff1d5, 0.75);
    directionalLight.position.set(30, 50, -28);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;

    const d = 50;
    directionalLight.shadow.camera.left = -d;
    directionalLight.shadow.camera.right = d;
    directionalLight.shadow.camera.top = d;
    directionalLight.shadow.camera.bottom = -d;
    directionalLight.shadow.camera.near = 1;
    directionalLight.shadow.camera.far = 150;
    scene.add(directionalLight);

    const fillLight = new THREE.DirectionalLight(0x88b7ff, 0.32);
    fillLight.position.set(-28, 38, 26);
    scene.add(fillLight);

    const rimLight = new THREE.PointLight(0x6699ff, 0.22, 120, 2);
    rimLight.position.set(-18, 32, 18);
    scene.add(rimLight);

    const groundGeometry = new THREE.PlaneGeometry(x, z, 40, 40);
    const groundMaterial = new THREE.MeshStandardMaterial({
        color: 0x181c28,
        roughness: 0.8,
        metalness: 0.04,
        emissive: 0x050814,
        emissiveIntensity: 0.08,
        side: THREE.DoubleSide,
    });

    const grid = new THREE.GridHelper(Math.max(x, z), Math.max(10, Math.floor(Math.max(x, z) / 2)), 0x334466, 0x111122);
    grid.name = 'sceneGrid';
    grid.position.y = 0.02;
    scene.add(grid);

    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.name = 'sceneGround';
    ground.receiveShadow = true;
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(oipTextureUrl, (texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.magFilter = THREE.NearestFilter;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        const repeats = 40 / 32;
        texture.repeat.set(repeats, repeats);
        groundMaterial.map = texture;
        groundMaterial.needsUpdate = true;
    });

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envRT = pmremGenerator.fromScene(new THREE.Scene(), 0.04);
    scene.environment = envRT.texture;

    // ── Postprocessing pipeline ───────────────────────────────────────
    // RenderPass → UnrealBloomPass → OutputPass
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.85,   // strength
        0.6,    // radius
        0.7     // threshold
    );
    composer.addPass(bloomPass);

    const outputPass = new OutputPass();
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    composer.addPass(outputPass);

    window.addEventListener('resize', () => resize(renderer, camera));
    resize(renderer, camera);

    return { renderer, scene, camera, controls, composer };
}

export function createMetricOverlay(metricGrid: MetricGrid, cellStep = 4, scale = 0.35) {
    const group = new THREE.Group();
    group.name = 'metricOverlay';

    const material = new THREE.LineBasicMaterial({
        color: 0x88ff88,
        transparent: true,
        opacity: 0.75,
        depthTest: true,
        depthWrite: false,
    });

    const geometry = new THREE.BufferGeometry();
    const lines = [] as number[];

    for (let j = 0; j < metricGrid.height; j += cellStep) {
        for (let i = 0; i < metricGrid.width; i += cellStep) {
            const M = metricGrid.getMetric(i, j);
            const { eigvals, eigvecs } = M.eigh();
            const center = metricGrid.gridToWorld(i, j);
            const major = eigvecs[0].mulScalar(Math.max(0.25, Math.min(1.2, eigvals[0] * scale)));
            const minor = eigvecs[1].mulScalar(Math.max(0.15, Math.min(0.8, eigvals[1] * scale)));

            lines.push(
                center.v[0] - major.v[0], 2.01, center.v[1] - major.v[1],
                center.v[0] + major.v[0], 2.01, center.v[1] + major.v[1],
                center.v[0] - minor.v[0], 2.01, center.v[1] - minor.v[1],
                center.v[0] + minor.v[0], 2.01, center.v[1] + minor.v[1],
            );
        }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    group.add(new THREE.LineSegments(geometry, material));
    return group;
}

export function refreshMetricOverlay(group: THREE.Group, metricGrid: MetricGrid, cellStep = 4, scale = 0.35) {
    if (!group.children.length) return;
    const line = group.children[0] as THREE.LineSegments;

    const geometry = new THREE.BufferGeometry();
    const lines = [] as number[];

    for (let j = 0; j < metricGrid.height; j += cellStep) {
        for (let i = 0; i < metricGrid.width; i += cellStep) {
            const M = metricGrid.getMetric(i, j);
            const { eigvals, eigvecs } = M.eigh();
            const center = metricGrid.gridToWorld(i, j);
            const major = eigvecs[0].mulScalar(Math.max(0.25, Math.min(1.2, eigvals[0] * scale)));
            const minor = eigvecs[1].mulScalar(Math.max(0.15, Math.min(0.8, eigvals[1] * scale)));

            lines.push(
                center.v[0] - major.v[0], 2.01, center.v[1] - major.v[1],
                center.v[0] + major.v[0], 2.01, center.v[1] + major.v[1],
                center.v[0] - minor.v[0], 2.01, center.v[1] - minor.v[1],
                center.v[0] + minor.v[0], 2.01, center.v[1] + minor.v[1],
            );
        }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    line.geometry.dispose();
    line.geometry = geometry;
}

/**
 * Capture a top-down orthographic screenshot suitable for paper figures.
 *
 * - Renders at FIGURE_LONG_EDGE px on the long edge (crisp at print resolution).
 * - Bypasses the composer (no bloom / tone-mapping noise).
 * - Swaps in a light background, hides fog and grid for the duration of the render.
 * - Restores all scene state before returning.
 */
export function captureFigureScreenshot(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    world: { x: number; z: number }
) {
    // --- compute target render size (preserve world aspect ratio) ---
    const worldAspect = world.x / world.z;
    const renderW = worldAspect >= 1 ? FIGURE_LONG_EDGE : Math.round(FIGURE_LONG_EDGE * worldAspect);
    const renderH = worldAspect >= 1 ? Math.round(FIGURE_LONG_EDGE / worldAspect) : FIGURE_LONG_EDGE;

    // --- save state we're about to mutate ---
    const origBg = scene.background;
    const origFog = scene.fog;
    const origSize = new THREE.Vector2();
    renderer.getSize(origSize);
    const origPixelRatio = renderer.getPixelRatio();
    const origToneMapping = renderer.toneMapping;
    const origExposure = renderer.toneMappingExposure;

    const grid = scene.getObjectByName('sceneGrid');
    const gridWasVisible = grid?.visible ?? false;

    // --- swap to figure-friendly state ---
    scene.background = new THREE.Color(0x0b1220);
    scene.fog = null;
    if (grid) grid.visible = false;

    const boostedTrailMaterials: Array<{
        material: THREE.Material;
        opacity: number;
        size?: number;
    }> = [];

    scene.traverse((obj) => {
        if (obj instanceof THREE.Line && obj.name.startsWith('trailLine-')) {
            const mat = obj.material as THREE.LineBasicMaterial;
            boostedTrailMaterials.push({
                material: mat,
                opacity: mat.opacity,
            });
            mat.opacity = 1.0;
        }

        if (obj instanceof THREE.Points && obj.name.startsWith('trailGlow-')) {
            const mat = obj.material as THREE.PointsMaterial;
            boostedTrailMaterials.push({
                material: mat,
                opacity: mat.opacity,
                size: mat.size,
            });
            mat.opacity = 1.0;
            mat.size *= 1.5; // make glow points pop in the export
        }
    });

    // Disable the renderer's tone mapping for the direct render path (the
    // ACES tonemap was set with the OutputPass in mind, not direct render).
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;

    // Resize to high-res output. The `false` arg prevents canvas CSS resize so
    // the on-screen UI doesn't reflow during capture.
    renderer.setPixelRatio(1);
    renderer.setSize(renderW, renderH, false);

    // --- ortho top-down camera ---
    const aspect = renderW / renderH;
    let viewWidth: number;
    let viewHeight: number;
    if (aspect >= worldAspect) {
        viewWidth = world.z * aspect;
        viewHeight = world.z;
    } else {
        viewWidth = world.x;
        viewHeight = world.x / aspect;
    }

    const topCamera = new THREE.OrthographicCamera(
        -viewWidth / 2,
        viewWidth / 2,
        viewHeight / 2,
        -viewHeight / 2,
        0.1,
        500
    );
    topCamera.position.set(0, 120, 0);
    topCamera.up.set(0, 0, -1);
    topCamera.lookAt(0, 0, 0);
    topCamera.updateProjectionMatrix();

    // --- render (force a clean clear, bypass composer) ---
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(scene, topCamera);

    // --- save to disk ---
    const dataURL = renderer.domElement.toDataURL('image/png');
    const anchor = document.createElement('a');
    anchor.href = dataURL;
    anchor.download = `figure-${Date.now()}.png`;
    anchor.click();

    // --- restore all state ---
    scene.background = origBg;
    scene.fog = origFog;
    if (grid) grid.visible = gridWasVisible;

    renderer.toneMapping = origToneMapping;
    renderer.toneMappingExposure = origExposure;
    renderer.setPixelRatio(origPixelRatio);
    renderer.setSize(origSize.x, origSize.y, false);

    for (const entry of boostedTrailMaterials) {
        if (entry.material instanceof THREE.PointsMaterial) {
            entry.material.opacity = entry.opacity;
            if (entry.size !== undefined) entry.material.size = entry.size;
        } else if (entry.material instanceof THREE.LineBasicMaterial) {
            entry.material.opacity = entry.opacity;
        }
    }
}

// Backwards-compatible alias (the old export name is still imported elsewhere).
export const captureTopDownScreenshot = captureFigureScreenshot;

function resize(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height);
    composer.setSize(width, height);
    if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }
    render();
}

function render() {
    composer.render();
}