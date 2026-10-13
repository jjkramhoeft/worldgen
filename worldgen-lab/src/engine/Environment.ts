/**
 * Sky, sun/moon light, hemisphere ambient, distance fog, cloud layer and
 * shadows — driven by the time of day.
 */
import * as THREE from 'three';
import { createCloudLayerMaterial, createSkyMaterial } from './shaders';
import type { RenderSettings } from '../gen/settings';

const C = (hex: string) => new THREE.Color(hex);
const PALETTE = {
  day: { zenith: C('#2c6bd1'), horizon: C('#b9d4ee'), ground: C('#8c9ba6'), sun: C('#fff3df') },
  sunset: { zenith: C('#34508f'), horizon: C('#f2a35c'), ground: C('#6d5a52'), sun: C('#ffad62') },
  night: { zenith: C('#03060f'), horizon: C('#0f1a2c'), ground: C('#05080d'), sun: C('#8fa6ff') },
};

export interface EnvironmentFrame {
  render: RenderSettings;
  camera: THREE.PerspectiveCamera;
  /** Distance at which the fog fully hides the world. */
  viewDistance: number;
  cloudHeight: number;
  /** Centre of the shadow-casting region (usually the camera target). */
  focus: THREE.Vector3;
  shadowRadius: number;
  time: number;
}

export class Environment {
  readonly sun = new THREE.DirectionalLight('#ffffff', 3);
  readonly hemi = new THREE.HemisphereLight('#b9d4ee', '#5a5045', 0.8);
  readonly skyMaterial = createSkyMaterial();
  readonly sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.skyMaterial);
  readonly cloudMaterial = createCloudLayerMaterial();
  readonly clouds = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.cloudMaterial);
  readonly fog = new THREE.Fog('#b9d4ee', 1000, 4000);
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly sunColor = new THREE.Color();
  readonly horizonColor = new THREE.Color();
  readonly zenithColor = new THREE.Color();
  /** 0 at night … 1 at full day. */
  day = 1;
  private shadowRadius = 0;
  private readonly tmp = new THREE.Color();

  constructor(private readonly scene: THREE.Scene) {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 5;
    scene.add(this.sun, this.sun.target, this.hemi, this.sky, this.clouds);
    scene.fog = this.fog;
  }

  /** Sun direction for a time of day (hours) and azimuth (degrees). */
  static sunDirection(time: number, azimuthDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
    const a = ((time - 6) / 12) * Math.PI;
    out.set(Math.cos(a), Math.sin(a) * 0.86, Math.sin(a) * 0.5).normalize();
    out.applyAxisAngle(new THREE.Vector3(0, 1, 0), (azimuthDeg * Math.PI) / 180);
    return out;
  }

  /** Sets sky/light colors for a given sun elevation (dot of sun dir and local up). */
  applyPalette(elevation: number): void {
    const dayT = THREE.MathUtils.smoothstep(elevation, -0.05, 0.35);
    const nightT = THREE.MathUtils.smoothstep(-elevation, 0.0, 0.3);
    const mix = (key: 'zenith' | 'horizon' | 'ground' | 'sun', out: THREE.Color) =>
      out.copy(PALETTE.sunset[key]).lerp(PALETTE.day[key], dayT).lerp(PALETTE.night[key], nightT);
    mix('zenith', this.zenithColor);
    mix('horizon', this.horizonColor);
    mix('sun', this.sunColor);
    this.skyMaterial.uniforms.uZenith.value.copy(this.zenithColor);
    this.skyMaterial.uniforms.uHorizon.value.copy(this.horizonColor);
    mix('ground', this.skyMaterial.uniforms.uGround.value);
    this.skyMaterial.uniforms.uSunColor.value.copy(this.sunColor).multiplyScalar(1 - nightT);
    this.skyMaterial.uniforms.uStars.value = nightT;
    this.day = THREE.MathUtils.smoothstep(elevation, -0.12, 0.25);
  }

  update(f: EnvironmentFrame): void {
    const r = f.render;
    Environment.sunDirection(r.timeOfDay, r.sunAzimuth, this.sunDir);
    const elevation = this.sunDir.y;
    this.applyPalette(elevation);
    this.skyMaterial.uniforms.uSunDir.value.copy(this.sunDir);
    this.skyMaterial.uniforms.uUp.value.set(0, 1, 0);
    this.skyMaterial.uniforms.uOpacity.value = 1;

    // Sun by day, a dim bluish moon by night (opposite direction).
    const sunUp = THREE.MathUtils.smoothstep(elevation, -0.03, 0.12);
    const moonUp = THREE.MathUtils.smoothstep(-elevation, 0.03, 0.2);
    const lightDir = elevation >= 0 ? this.sunDir : this.tmpVec.copy(this.sunDir).negate();
    this.sun.color.copy(elevation >= 0 ? this.sunColor : PALETTE.night.sun);
    this.sun.intensity = elevation >= 0 ? 2.6 * sunUp : 0.45 * moonUp;
    // Physically based lights divide diffuse by π, so sky light needs ~π-scale intensity too.
    this.hemi.color.copy(this.zenithColor).lerp(this.horizonColor, 0.55);
    this.hemi.groundColor.set('#6b6152').multiplyScalar(0.35 + 0.65 * sunUp);
    this.hemi.intensity = 0.5 + 2.7 * sunUp + 0.5 * moonUp;

    // Shadow frustum follows the focus point.
    this.sun.castShadow = r.shadows;
    if (r.shadows) {
      if (this.shadowRadius !== f.shadowRadius) {
        this.shadowRadius = f.shadowRadius;
        const cam = this.sun.shadow.camera;
        cam.left = cam.bottom = -f.shadowRadius;
        cam.right = cam.top = f.shadowRadius;
        cam.near = 1;
        cam.far = f.shadowRadius * 8;
        cam.updateProjectionMatrix();
      }
      // Snap to shadow texels to avoid shimmering while moving.
      const texel = (f.shadowRadius * 2) / this.sun.shadow.mapSize.x;
      const fx = Math.round(f.focus.x / texel) * texel;
      const fz = Math.round(f.focus.z / texel) * texel;
      this.sun.target.position.set(fx, f.focus.y, fz);
      this.sun.position.copy(this.sun.target.position).addScaledVector(lightDir, f.shadowRadius * 4);
    } else {
      this.sun.target.position.copy(f.focus);
      this.sun.position.copy(f.focus).addScaledVector(lightDir, 1000);
    }
    this.sun.target.updateMatrixWorld();

    // Fog hides the edge of the generated world.
    const fogMul = r.fog;
    this.fog.color.copy(this.horizonColor);
    if (fogMul <= 0.01) {
      this.fog.near = 1e7;
      this.fog.far = 2e7;
    } else {
      // Fog ends at the edge of the generated world and starts ~55% of the way out.
      this.fog.far = f.viewDistance / Math.max(0.35, fogMul);
      this.fog.near = this.fog.far * THREE.MathUtils.clamp(0.8 - 0.25 * fogMul, 0.05, 0.75);
    }

    this.sky.position.copy(f.camera.position);
    this.sky.scale.setScalar(f.camera.far * 0.9);

    this.clouds.visible = r.clouds;
    if (r.clouds) {
      const size = f.viewDistance * 2.6;
      const snap = 200;
      this.clouds.position.set(Math.round(f.camera.position.x / snap) * snap, f.cloudHeight, Math.round(f.camera.position.z / snap) * snap);
      this.clouds.scale.set(size, size, 1);
      const u = this.cloudMaterial.uniforms;
      u.uTime.value = f.time;
      u.uSunDir.value.copy(this.sunDir);
      u.uSunColor.value.copy(this.sunColor);
      u.uSkyColor.value.copy(this.horizonColor);
      u.uFade.value = size * 0.5;
      u.uDay.value = sunUp;
    }
  }

  setVisible(on: boolean): void {
    this.sky.visible = on;
    this.clouds.visible = on && this.clouds.visible;
    this.hemi.visible = on;
    this.scene.fog = on ? this.fog : null;
  }

  private readonly tmpVec = new THREE.Vector3();

  /** Color used for water reflections. */
  get skyReflection(): THREE.Color {
    return this.tmp.copy(this.horizonColor).lerp(this.zenithColor, 0.35);
  }
}
