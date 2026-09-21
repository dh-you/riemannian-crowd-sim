import * as THREE from "three";
import { Vec2 } from "./Linalg";

// Soft circular sprite for the glow points — built once, shared across all agents.
// Without a bloom pass, this is what actually makes the trail read as "glowing"
// rather than as a row of hard squares.
let _glowSprite: THREE.Texture | null = null;
function getGlowSprite(): THREE.Texture {
    if (_glowSprite) return _glowSprite;
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const cx = size / 2;
    const cy = size / 2;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
    grad.addColorStop(0.0, "rgba(255,255,255,1.0)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.85)");
    grad.addColorStop(0.55, "rgba(255,255,255,0.35)");
    grad.addColorStop(1.0, "rgba(255,255,255,0.0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    _glowSprite = tex;
    return tex;
}

// Trail height above the floor. Agents sit at y=2, so this floats the trails
// above agent bodies for visibility in dense crowds.
const TRAIL_HEIGHT_LINE = 2.7;
const TRAIL_HEIGHT_GLOW = 2.72;

export class Agent {
    id: number;
    mesh: THREE.Mesh;
    radius: number;
    pos: Vec2;
    goal: Vec2;
    vel: Vec2 = new Vec2([0, 0]);
    speed: number;
    arrived: boolean = false;
    trailPoints: Vec2[] = [];
    trailMesh?: THREE.Line;
    trailGlowMesh?: THREE.Points;
    trailMaxLength: number = 50;

    constructor(id: number, mesh: any, radius: number, pos: Vec2, goal: Vec2, speed: number) {
        this.id = id;
        this.mesh = mesh;
        this.radius = radius;
        this.pos = pos;
        this.goal = goal;
        this.speed = speed;
    }

    createTrail(scene: THREE.Scene) {
        // Trails are always white, regardless of any requested color.

        // ── Line layer ────────────────────────────────────────────────
        const linePositions = new Float32Array(this.trailMaxLength * 3);
        const lineColors = new Float32Array(this.trailMaxLength * 3);

        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
        lineGeometry.setAttribute("color", new THREE.BufferAttribute(lineColors, 3));
        lineGeometry.setDrawRange(0, 0); // nothing drawn until updateTrail populates points

        const lineMaterial = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 1.0,
            // depthTest off → trails always draw over agents and ground, so they
            // stay visible in crowded scenes where agents would otherwise occlude
            // them. renderOrder below ensures correct draw order between layers.
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
        });

        this.trailMesh = new THREE.Line(lineGeometry, lineMaterial);
        this.trailMesh.name = `trailLine-${this.id}`;
        this.trailMesh.renderOrder = 999;
        scene.add(this.trailMesh);

        // ── Points (glow) layer ───────────────────────────────────────
        const glowPositions = new Float32Array(this.trailMaxLength * 3);
        const glowColors = new Float32Array(this.trailMaxLength * 3);

        const glowGeometry = new THREE.BufferGeometry();
        glowGeometry.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
        glowGeometry.setAttribute("color", new THREE.BufferAttribute(glowColors, 3));
        glowGeometry.setDrawRange(0, 0);

        const glowMaterial = new THREE.PointsMaterial({
            vertexColors: true,
            size: 0.8,              // was 0.8
            sizeAttenuation: true,
            map: getGlowSprite(),
            alphaTest: 0.001,        // was 0.01
            transparent: true,
            opacity: 1.0,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
        });

        this.trailGlowMesh = new THREE.Points(glowGeometry, glowMaterial);
        this.trailGlowMesh.name = `trailGlow-${this.id}`;
        this.trailGlowMesh.renderOrder = 1000;
        scene.add(this.trailGlowMesh);

        this.updateTrail();
    }

    updateTrail() {
        this.trailPoints.push(new Vec2([this.pos.v[0], this.pos.v[1]]));
        if (this.trailPoints.length > this.trailMaxLength) {
            this.trailPoints.shift();
        }

        if (!this.trailMesh || !this.trailGlowMesh) return;

        const linePositions = this.trailMesh.geometry.attributes.position.array as Float32Array;
        const lineColors = this.trailMesh.geometry.attributes.color.array as Float32Array;
        const glowPositions = this.trailGlowMesh.geometry.attributes.position.array as Float32Array;
        const glowColors = this.trailGlowMesh.geometry.attributes.color.array as Float32Array;

        const filled = this.trailPoints.length;

        // i = 0 is the oldest point (tail), i = filled-1 is the newest (head, at agent).
        // Fade brightness from tail (dim) to head (bright) for a consistent white trail.
        for (let i = 0; i < filled; i++) {
            const point = this.trailPoints[i];
            const baseIndex = i * 3;

            linePositions[baseIndex] = point.v[0];
            linePositions[baseIndex + 1] = TRAIL_HEIGHT_LINE;
            linePositions[baseIndex + 2] = point.v[1];

            glowPositions[baseIndex] = point.v[0];
            glowPositions[baseIndex + 1] = TRAIL_HEIGHT_GLOW;
            glowPositions[baseIndex + 2] = point.v[1];

            const edge = filled > 1 ? i / (filled - 1) : 1;
            const fade = edge * edge * (3 - 2 * edge); // smoothstep

            // Make the oldest part of the trail still reasonably visible.
            const brightness = 0.72 + fade * 0.28;
            const glowStrength = 0.85 + fade * 0.15;

            lineColors[baseIndex] = brightness;
            lineColors[baseIndex + 1] = brightness;
            lineColors[baseIndex + 2] = brightness;

            glowColors[baseIndex] = glowStrength;
            glowColors[baseIndex + 1] = glowStrength;
            glowColors[baseIndex + 2] = glowStrength;
        }

        // Only draw the vertices that actually have data. This kills the
        // "phasing" you were seeing — previously all 96 vertices were drawn
        // and the unfilled ones were stuck at the agent's starting position.
        this.trailMesh.geometry.setDrawRange(0, filled);
        this.trailGlowMesh.geometry.setDrawRange(0, filled);

        this.trailMesh.geometry.attributes.position.needsUpdate = true;
        this.trailMesh.geometry.attributes.color.needsUpdate = true;
        this.trailGlowMesh.geometry.attributes.position.needsUpdate = true;
        this.trailGlowMesh.geometry.attributes.color.needsUpdate = true;
    }

    setTrailLength(length: number) {
        const trimmed = Math.max(8, Math.round(length));
        this.trailMaxLength = trimmed;
        if (this.trailPoints.length > trimmed) {
            this.trailPoints = this.trailPoints.slice(this.trailPoints.length - trimmed);
        }

        if (!this.trailMesh || !this.trailGlowMesh) return;

        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(trimmed * 3), 3));
        lineGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(trimmed * 3), 3));
        lineGeometry.setDrawRange(0, 0);
        this.trailMesh.geometry.dispose();
        this.trailMesh.geometry = lineGeometry;

        const glowGeometry = new THREE.BufferGeometry();
        glowGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(trimmed * 3), 3));
        glowGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(trimmed * 3), 3));
        glowGeometry.setDrawRange(0, 0);
        this.trailGlowMesh.geometry.dispose();
        this.trailGlowMesh.geometry = glowGeometry;

        this.updateTrail();
    }

    updateMeshPosition() {
        this.mesh.position.set(this.pos.v[0], 2, this.pos.v[1]);
        if (this.trailMesh) {
            this.updateTrail();
        }
    }
}