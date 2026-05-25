import * as THREE from "three";
import { Vec2 } from "./Linalg"; 

export class Wall {
    start: Vec2;
    end: Vec2;
    thickness: number;
    mesh: THREE.Mesh;

    constructor(start: Vec2, end: Vec2, thickness: number, mesh: THREE.Mesh) {
        this.start = start;
        this.end = end;
        this.thickness = thickness;
        this.mesh = mesh;
    }
}
