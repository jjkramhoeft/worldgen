/**
 * Camera controller with four behaviours:
 *  - orbit:  OrbitControls (rotate / pan / zoom) + WASD to glide the target, Q/E to turn;
 *            the target follows the ground so you orbit around the terrain
 *  - fly:    free flight with mouse look (pointer lock), speed on the wheel, optional autopilot
 *  - walk:   gravity, jumping, swimming; heightfield or voxel AABB collision with auto-step
 *  - planet: orbit around a planet with altitude-scaled zoom, or spaceship flight
 *            that auto-levels to the local horizon near the surface
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraMode, CameraSettings } from '../gen/settings';

export interface RigHooks {
  /** Ground height for flat worlds. */
  ground?: (x: number, z: number) => number;
  waterLevel?: number;
  /** Water surface at a point (NaN = dry), for worlds whose rivers and lakes sit above sea level. */
  waterAt?: (x: number, z: number) => number;
  /** Voxel collision. */
  solid?: (x: number, y: number, z: number) => boolean;
  /** Planet: centre, radius and the surface radius in a given direction. */
  planet?: { center: THREE.Vector3; radius: number; surface: (dir: THREE.Vector3) => number };
}

const UP = new THREE.Vector3(0, 1, 0);
const EYE = 1.62;
const HALF = 0.3;
const BODY = 1.8;

export class CameraRig {
  readonly orbit: OrbitControls;
  mode: CameraMode = 'orbit';
  hooks: RigHooks = {};
  speedScale = 1;
  autopilot = false;
  onGround = false;
  inWater = false;
  /** Called when pointer lock is gained or lost. */
  onLockChange: ((locked: boolean) => void) | null = null;

  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private lookDX = 0;
  private lookDY = 0;
  private readonly vel = new THREE.Vector3();
  private apTime = 0;
  private apHeading = 0;
  private dragging = false;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    readonly dom: HTMLElement,
    private readonly settings: () => CameraSettings,
  ) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.screenSpacePanning = false;
    this.orbit.zoomToCursor = true;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.minDistance = 2;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', () => (this.dragging = false));
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('pointerlockchange', () => this.onLockChange?.(this.locked));
  }

  get locked(): boolean {
    return document.pointerLockElement === this.dom;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    this.keys.add(e.code);
    if (e.code === 'Space' && this.mode !== 'orbit') e.preventDefault();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (this.mode === 'orbit' || e.button !== 0) return;
    if (!this.locked) {
      this.dragging = true;
      const p = this.dom.requestPointerLock?.() as unknown;
      if (p instanceof Promise) p.catch(() => {});
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.mode === 'orbit') return;
    if (!this.locked && !this.dragging) return;
    const s = this.settings().sensitivity * 0.0022;
    if (this.hooks.planet && this.mode === 'fly') {
      this.lookDX += e.movementX * s;
      this.lookDY += e.movementY * s;
      return;
    }
    this.yaw -= e.movementX * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * s, -1.55, 1.55);
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.mode !== 'orbit') {
      e.preventDefault();
      this.speedScale = THREE.MathUtils.clamp(this.speedScale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.05, 60);
      return;
    }
    const P = this.hooks.planet;
    if (P) {
      e.preventDefault();
      const rel = this.v1.copy(this.camera.position).sub(P.center);
      const dist = rel.length();
      const surface = P.surface(this.v2.copy(rel).normalize());
      const alt = Math.max(0.5, dist - surface);
      const next = surface + THREE.MathUtils.clamp(alt * (e.deltaY < 0 ? 0.88 : 1 / 0.88), 0.8, P.radius * 12);
      this.camera.position.copy(P.center).addScaledVector(rel.normalize(), next);
    }
  };

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.vel.set(0, 0, 0);
    this.autopilot = false;
    if (mode === 'orbit') {
      if (this.locked) document.exitPointerLock();
      this.orbit.enabled = true;
      const P = this.hooks.planet;
      if (P) {
        this.orbit.target.copy(P.center);
      } else {
        const dir = this.camera.getWorldDirection(this.v1);
        const t = this.v2.copy(this.camera.position).addScaledVector(dir, 120);
        if (this.hooks.ground) t.y = this.hooks.ground(t.x, t.z);
        this.orbit.target.copy(t);
      }
      this.camera.up.set(0, 1, 0);
      this.orbit.update();
    } else {
      this.orbit.enabled = false;
      this.syncYawPitch();
    }
  }

  /** Places the camera; in orbit mode the target becomes the orbit centre. */
  setPose(position: THREE.Vector3, target: THREE.Vector3): void {
    this.camera.position.copy(position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.orbit.target.copy(target);
    this.vel.set(0, 0, 0);
    this.syncYawPitch();
    if (this.mode === 'orbit') this.orbit.update();
  }

  /** Water surface at (x, z), or −Infinity where there is none. */
  private water(x: number, z: number): number {
    if (this.hooks.waterAt) {
      const w = this.hooks.waterAt(x, z);
      return Number.isNaN(w) ? -Infinity : w;
    }
    return this.hooks.waterLevel ?? -Infinity;
  }

  /** Moves the view to look at a ground point, keeping the current viewing offset. */
  teleport(x: number, z: number): void {
    const g = this.hooks.ground ? Math.max(this.hooks.ground(x, z), this.water(x, z)) : 0;
    if (this.mode === 'orbit') {
      const offset = this.v1.copy(this.camera.position).sub(this.orbit.target);
      this.orbit.target.set(x, g, z);
      this.camera.position.copy(this.orbit.target).add(offset);
      this.orbit.update();
    } else {
      this.camera.position.set(x, g + (this.mode === 'walk' ? EYE + 0.5 : 60), z);
      this.vel.set(0, 0, 0);
    }
  }

  private syncYawPitch(): void {
    const dir = this.camera.getWorldDirection(this.v1);
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    this.apHeading = this.yaw;
  }

  private axis(pos: string[], neg: string[]): number {
    return (pos.some((k) => this.keys.has(k)) ? 1 : 0) - (neg.some((k) => this.keys.has(k)) ? 1 : 0);
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.1);
    const s = this.settings();
    if (this.hooks.planet) {
      if (this.mode === 'fly') this.updatePlanetFly(dt, s);
      else this.updatePlanetOrbit();
      return;
    }
    if (this.mode === 'orbit') this.updateOrbit(dt);
    else if (this.mode === 'fly') {
      if (this.autopilot) this.updateAutopilot(dt, s);
      else this.updateFly(dt, s);
    } else this.updateWalk(dt, s);
  }

  // ───────────────────────────── flat worlds ─────────────────────────────

  private updateOrbit(dt: number): void {
    const ax = this.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    const az = this.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const rot = this.axis(['KeyE'], ['KeyQ']);
    const target = this.orbit.target;
    if (ax || az) {
      const dist = this.camera.position.distanceTo(target);
      const speed = Math.max(25, dist) * 0.9 * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1);
      const fwd = this.camera.getWorldDirection(this.v1);
      fwd.y = 0;
      fwd.normalize();
      const right = this.v2.crossVectors(fwd, UP);
      const delta = fwd.multiplyScalar(az).addScaledVector(right, ax).normalize().multiplyScalar(speed * dt);
      target.add(delta);
      this.camera.position.add(delta);
    }
    if (rot) {
      const offset = this.v1.copy(this.camera.position).sub(target);
      offset.applyAxisAngle(UP, rot * dt * 1.3);
      this.camera.position.copy(target).add(offset);
    }
    const ground = this.hooks.ground;
    if (ground) {
      const g = Math.max(ground(target.x, target.z), this.water(target.x, target.z));
      const dy = (g - target.y) * Math.min(1, dt * 4);
      target.y += dy;
      this.camera.position.y += dy;
      const cg = ground(this.camera.position.x, this.camera.position.z) + 2.5;
      if (this.camera.position.y < cg) this.camera.position.y = cg;
    }
    this.orbit.update();
  }

  private fwdVector(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  private updateFly(dt: number, s: CameraSettings): void {
    const ax = this.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    const az = this.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const ay = this.axis(['Space', 'KeyE'], ['KeyQ', 'KeyC']);
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1;
    const fwd = this.fwdVector(this.v1);
    const right = this.v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = this.v3.set(0, 0, 0).addScaledVector(fwd, az).addScaledVector(right, ax).addScaledVector(UP, ay);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(s.flySpeed * this.speedScale * boost);
    this.vel.lerp(wish, 1 - Math.exp(-dt * 7));
    const p = this.camera.position;
    p.addScaledVector(this.vel, dt);
    this.collideFree(s);
    this.camera.quaternion.setFromEuler(this.euler.set(this.pitch, this.yaw, 0));
  }

  private collideFree(s: CameraSettings): void {
    if (!s.collide) return;
    const p = this.camera.position;
    if (this.hooks.solid) {
      let guard = 0;
      while (this.hooks.solid(Math.floor(p.x), Math.floor(p.y - 0.2), Math.floor(p.z)) && guard++ < 64) p.y += 1;
    } else if (this.hooks.ground) {
      const min = this.hooks.ground(p.x, p.z) + 1.5;
      if (p.y < min) p.y = min;
    }
  }

  private updateAutopilot(dt: number, s: CameraSettings): void {
    this.apTime += dt;
    const ground = this.hooks.ground;
    this.apHeading += (Math.sin(this.apTime * 0.11) * 0.6 + Math.sin(this.apTime * 0.043 + 1.3) * 0.5) * dt * 0.22;
    this.yaw += (this.apHeading - this.yaw) * Math.min(1, dt * 1.5);
    const speed = s.flySpeed * this.speedScale;
    const fwd = this.v1.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const p = this.camera.position;
    p.addScaledVector(fwd, speed * dt);
    if (ground) {
      let targetY = -Infinity;
      for (const ahead of [0, 1, 2.5, 5]) {
        const d = ahead * Math.max(40, speed);
        targetY = Math.max(targetY, ground(p.x + fwd.x * d, p.z + fwd.z * d));
      }
      targetY = Math.max(targetY, this.water(p.x, p.z)) + s.autopilotAltitude;
      p.y += (targetY - p.y) * (1 - Math.exp(-dt * 0.9));
      const wantPitch = -0.16 + THREE.MathUtils.clamp((targetY - p.y) * 0.004, -0.2, 0.2);
      this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * 1.5);
    }
    this.collideFree(s);
    this.camera.quaternion.setFromEuler(this.euler.set(this.pitch, this.yaw, 0));
  }

  private updateWalk(dt: number, s: CameraSettings): void {
    const ax = this.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    const az = this.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 1.8 : 1;
    const jump = this.keys.has('Space');
    const fwd = this.v1.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = this.v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = this.v3.set(0, 0, 0).addScaledVector(fwd, az).addScaledVector(right, ax);
    const p = this.camera.position;
    this.inWater = p.y - EYE * 0.6 < this.water(p.x, p.z);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(s.walkSpeed * sprint * this.speedScale * (this.inWater ? 0.6 : 1));
    const k = 1 - Math.exp(-dt * (this.onGround ? 12 : 3));
    this.vel.x += (wish.x - this.vel.x) * k;
    this.vel.z += (wish.z - this.vel.z) * k;
    if (this.inWater) {
      this.vel.y += ((jump ? 3.5 : -1.2) - this.vel.y) * (1 - Math.exp(-dt * 4));
    } else {
      this.vel.y -= 26 * dt;
      if (jump && this.onGround) this.vel.y = 8.4;
    }

    if (this.hooks.solid) this.moveVoxel(dt);
    else {
      p.addScaledVector(this.vel, dt);
      const g = this.hooks.ground ? this.hooks.ground(p.x, p.z) : 0;
      if (p.y - EYE <= g) {
        p.y = g + EYE;
        this.vel.y = Math.max(0, this.vel.y);
        this.onGround = true;
      } else {
        this.onGround = p.y - EYE - g < 0.05;
      }
    }
    this.camera.quaternion.setFromEuler(this.euler.set(this.pitch, this.yaw, 0));
  }

  private collides(x: number, y: number, z: number): boolean {
    const solid = this.hooks.solid!;
    const e = 1e-4;
    for (let by = Math.floor(y); by <= Math.floor(y + BODY - e); by++) {
      for (let bz = Math.floor(z - HALF); bz <= Math.floor(z + HALF - e); bz++) {
        for (let bx = Math.floor(x - HALF); bx <= Math.floor(x + HALF - e); bx++) {
          if (solid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  private moveVoxel(dt: number): void {
    const p = this.camera.position;
    let x = p.x;
    let y = p.y - EYE;
    let z = p.z;
    // Escape if stuck inside blocks (e.g. after an edit or teleport).
    let guard = 0;
    while (this.collides(x, y, z) && guard++ < 80) y += 1;

    const steps = Math.max(1, Math.ceil((this.vel.length() * dt) / 0.4));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const ny = y + this.vel.y * h;
      if (this.collides(x, ny, z)) {
        if (this.vel.y < 0) {
          y = Math.floor(ny) + 1;
          this.onGround = true;
        } else {
          y = Math.floor(ny + BODY) - BODY - 1e-3;
        }
        this.vel.y = 0;
      } else {
        y = ny;
        this.onGround = this.collides(x, y - 0.06, z);
      }
      const nx = x + this.vel.x * h;
      if (this.collides(nx, y, z)) {
        if (this.onGround && !this.collides(nx, y + 1.05, z) && !this.collides(x, y + 1.05, z)) this.vel.y = 7.5;
        this.vel.x = 0;
      } else x = nx;
      const nz = z + this.vel.z * h;
      if (this.collides(x, y, nz)) {
        if (this.onGround && !this.collides(x, y + 1.05, nz) && !this.collides(x, y + 1.05, z)) this.vel.y = 7.5;
        this.vel.z = 0;
      } else z = nz;
    }
    p.set(x, y + EYE, z);
  }

  // ───────────────────────────── planets ─────────────────────────────

  private updatePlanetOrbit(): void {
    const P = this.hooks.planet!;
    const rel = this.v1.copy(this.camera.position).sub(P.center);
    const dist = rel.length();
    const surface = P.surface(this.v2.copy(rel).normalize());
    const alt = dist - surface;
    this.orbit.target.copy(P.center);
    this.orbit.enableZoom = false;
    this.orbit.enablePan = false;
    this.orbit.maxPolarAngle = Math.PI;
    this.orbit.rotateSpeed = THREE.MathUtils.clamp(alt / P.radius, 0.004, 1);
    if (alt < 1) this.camera.position.copy(P.center).addScaledVector(rel.normalize(), surface + 1);
    this.orbit.update();
  }

  private updatePlanetFly(dt: number, s: CameraSettings): void {
    const P = this.hooks.planet!;
    const cam = this.camera;
    // Mouse look in the camera's local frame (spaceship style).
    if (this.lookDX || this.lookDY) {
      this.q.setFromAxisAngle(this.v1.set(0, 1, 0), -this.lookDX);
      cam.quaternion.multiply(this.q);
      this.q.setFromAxisAngle(this.v1.set(1, 0, 0), -this.lookDY);
      cam.quaternion.multiply(this.q);
      this.lookDX = this.lookDY = 0;
    }
    const roll = this.axis(['KeyZ'], ['KeyX']);
    if (roll) {
      this.q.setFromAxisAngle(this.v1.set(0, 0, 1), roll * dt * 1.2);
      cam.quaternion.multiply(this.q);
    }
    const rel = this.v2.copy(cam.position).sub(P.center);
    const dist = rel.length();
    const up = rel.multiplyScalar(1 / dist);
    const surface = P.surface(up);
    const alt = Math.max(0.1, dist - surface);

    // Auto-level towards the local horizon when close to the ground.
    const level = 1 - THREE.MathUtils.smoothstep(alt, P.radius * 0.05, P.radius * 0.3);
    if (level > 0) {
      const fwd = this.v1.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const camUp = this.v3.set(0, 1, 0).applyQuaternion(cam.quaternion);
      const wantUp = up.clone().addScaledVector(fwd, -up.dot(fwd)).normalize();
      const angle = Math.atan2(fwd.dot(camUp.clone().cross(wantUp)), camUp.dot(wantUp));
      this.q.setFromAxisAngle(this.v3.set(0, 0, 1), -angle * Math.min(1, dt * 2.5 * level));
      cam.quaternion.multiply(this.q);
    }

    const ax = this.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    const az = this.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const ay = this.axis(['Space', 'KeyE'], ['KeyQ', 'KeyC']);
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1;
    const wish = new THREE.Vector3(ax, ay, -az);
    if (wish.lengthSq() > 0) {
      wish.normalize().applyQuaternion(cam.quaternion);
      wish.multiplyScalar(THREE.MathUtils.clamp(alt * 0.9, 2, P.radius * 1.5) * (s.flySpeed / 60) * this.speedScale * boost);
    }
    this.vel.lerp(wish, 1 - Math.exp(-dt * 5));
    cam.position.addScaledVector(this.vel, dt);

    const rel2 = this.v2.copy(cam.position).sub(P.center);
    const d2 = rel2.length();
    const s2 = P.surface(rel2.multiplyScalar(1 / d2)) + 1.2;
    if (d2 < s2) cam.position.copy(P.center).addScaledVector(rel2, s2);
  }

  dispose(): void {
    this.orbit.dispose();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('pointermove', this.onPointerMove);
  }
}
