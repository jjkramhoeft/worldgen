/**
 * No Man's Sky style planets: a cube-sphere quadtree with continuous LOD from
 * orbit down to the surface, plus ocean, atmosphere, clouds, rings, moons and
 * a starfield. Everything derives from (galaxy seed, region, system, planet).
 */
import * as THREE from 'three';
import type { App } from '../app/App';
import { QuadtreeLod, type LodNode } from '../engine/QuadtreeLod';
import { createAtmosphereMaterial, createPlanetCloudMaterial, createRingMaterial, createWaterMaterial } from '../engine/shaders';
import { PlanetGenerator, emptyPlanetSample } from '../gen/planet/planetGen';
import { cubeToSphere, planetGridIndex, type PlanetNodeResult } from '../gen/planet/planetMesh';
import { Noise } from '../core/noise';
import { deriveSeed, Rng } from '../core/rng';
import type { ProbeInfo, WorldMode } from './Mode';

interface PDesc {
  face: number;
  level: number;
  x: number;
  y: number;
}

const indexCache = new Map<string, THREE.BufferAttribute>();
function sharedIndex(res: number, skirt: boolean): THREE.BufferAttribute {
  const key = `${res}:${skirt}`;
  let a = indexCache.get(key);
  if (!a) {
    a = new THREE.BufferAttribute(planetGridIndex(res, skirt), 1);
    indexCache.set(key, a);
  }
  return a;
}

class PlanetLod extends QuadtreeLod<PDesc, PlanetNodeResult> {
  private readonly tmp = new Float64Array(3);
  private readonly v = new THREE.Vector3();

  constructor(
    private readonly app: App,
    private readonly material: THREE.Material,
    private readonly ocean: () => THREE.Material,
  ) {
    super();
    this.cacheLimit = 700;
  }

  private get p() {
    return this.app.settings.planet;
  }

  protected roots(): PDesc[] {
    return [0, 1, 2, 3, 4, 5].map((face) => ({ face, level: 0, x: 0, y: 0 }));
  }

  protected children(d: PDesc): PDesc[] {
    const level = d.level + 1;
    return [
      { face: d.face, level, x: d.x * 2, y: d.y * 2 },
      { face: d.face, level, x: d.x * 2 + 1, y: d.y * 2 },
      { face: d.face, level, x: d.x * 2, y: d.y * 2 + 1 },
      { face: d.face, level, x: d.x * 2 + 1, y: d.y * 2 + 1 },
    ];
  }

  protected keyOf(d: PDesc): string {
    return `${d.face}:${d.level}:${d.x}:${d.y}`;
  }

  private distance(d: PDesc, node: LodNode<PDesc> | undefined): number {
    const span = 1 / 2 ** d.level;
    cubeToSphere(d.face, (d.x + 0.5) * span * 2 - 1, (d.y + 0.5) * span * 2 - 1, this.tmp);
    const e = node && !Number.isNaN(node.minH) ? (node.minH + node.maxH) / 2 : 0;
    const r = this.p.radius * (1 + e * this.p.heightScale);
    this.v.set(this.tmp[0] * r, this.tmp[1] * r, this.tmp[2] * r);
    return this.v.distanceTo(this.app.camera.position);
  }

  private size(d: PDesc): number {
    return (this.p.radius * 1.6) / 2 ** d.level;
  }

  protected shouldSplit(d: PDesc, node: LodNode<PDesc> | undefined): boolean {
    return d.level < this.p.view.maxLevel && this.distance(d, node) < this.size(d) * this.p.view.lodFactor;
  }

  protected priority(d: PDesc, node: LodNode<PDesc>): number {
    return this.distance(d, node) / this.size(d) + (node.object ? 4 : 0);
  }

  protected request(d: PDesc, node: LodNode<PDesc>, valid: () => boolean) {
    return this.app.pool.run(
      'planetNode',
      { face: d.face, level: d.level, x: d.x, y: d.y, res: this.p.view.resolution },
      { priority: () => this.priority(d, node), valid },
    );
  }

  protected createObject(_d: PDesc, r: PlanetNodeResult, node: LodNode<PDesc>): THREE.Object3D {
    const res = this.p.view.resolution;
    const group = new THREE.Group();
    group.position.set(r.center[0], r.center[1], r.center[2]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(r.colors, 3));
    geo.setIndex(sharedIndex(res, true));
    geo.userData.sharedIndex = true;
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'terrain';
    group.add(mesh);
    if (r.ocean) {
      const og = new THREE.BufferGeometry();
      og.setAttribute('position', new THREE.BufferAttribute(r.ocean.positions, 3));
      og.setAttribute(this.p.ocean.lava ? 'color' : 'waterColor', new THREE.BufferAttribute(r.ocean.colors, 4));
      og.setIndex(sharedIndex(res, false));
      og.userData.sharedIndex = true;
      og.computeBoundingSphere();
      const om = new THREE.Mesh(og, this.ocean());
      om.name = 'ocean';
      om.renderOrder = 2;
      group.add(om);
    }
    node.minH = r.minE;
    node.maxH = r.maxE;
    return group;
  }
}

export class PlanetMode implements WorldMode {
  readonly id = 'planet' as const;
  readonly root = new THREE.Group();
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  private readonly oceanMaterial = createWaterMaterial(true);
  private readonly lavaMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly lod: PlanetLod;
  private readonly atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), createAtmosphereMaterial());
  private readonly clouds = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), createPlanetCloudMaterial());
  private readonly rings = new THREE.Mesh(new THREE.RingGeometry(1, 2, 256, 1), createRingMaterial());
  private readonly moons = new THREE.Group();
  private readonly stars: THREE.Points;
  private readonly sunGlow: THREE.Sprite;
  private readonly ambient = new THREE.AmbientLight('#ffffff', 0.08);
  private gen: PlanetGenerator;
  readonly sunDir = new THREE.Vector3(1, 0.25, 0.3).normalize();
  private sunAngle = 0.4;
  private moonSpec: { mesh: THREE.Mesh; radius: number; speed: number; phase: number; incl: number }[] = [];
  private moonKey = '';
  private initialized = false;
  private readonly sample = emptyPlanetSample();
  private altitude = 0;

  constructor(private readonly app: App) {
    this.lod = new PlanetLod(app, this.material, () => (app.settings.planet.ocean.lava ? this.lavaMaterial : this.oceanMaterial));
    this.gen = new PlanetGenerator(app.settings.seed, app.settings.planet);
    this.root.add(this.lod.group, this.clouds, this.rings, this.moons, this.atmosphere, this.ambient);
    this.atmosphere.renderOrder = 8;
    this.clouds.renderOrder = 6;
    this.rings.renderOrder = 7;
    this.atmosphere.frustumCulled = false;

    // Starfield
    const rng = new Rng(4242);
    const n = 7000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const u = rng.range(-1, 1);
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(1 - u * u);
      pos.set([r * Math.cos(a), u, r * Math.sin(a)], i * 3);
      c.setHSL(rng.pick([0.6, 0.08, 0.13, 0.0, 0.55]), rng.range(0.2, 0.7), rng.range(0.55, 0.95));
      col.set([c.r, c.g, c.b], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -5;
    this.root.add(this.stars);

    // Sun glow sprite (radial gradient texture).
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,245,1)');
    grd.addColorStop(0.12, 'rgba(255,240,200,0.9)');
    grd.addColorStop(0.35, 'rgba(255,200,140,0.25)');
    grd.addColorStop(1, 'rgba(255,180,120,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.root.add(this.sunGlow);
  }

  activate(): void {
    this.app.scene.add(this.root);
    this.app.env.setVisible(false);
    this.app.env.sky.visible = true;
    this.app.env.sun.castShadow = false;
    this.syncHooks();
    if (!this.initialized) {
      this.initialized = true;
      this.resetCamera();
    }
  }

  resetCamera(): void {
    const R = this.app.settings.planet.radius;
    this.app.rig.setPose(new THREE.Vector3(R * 1.6, R * 0.9, R * 2.3), new THREE.Vector3());
  }

  deactivate(): void {
    this.app.scene.remove(this.root);
    this.lod.clear();
    this.app.scene.fog = this.app.env.fog;
  }

  private syncHooks(): void {
    const p = this.app.settings.planet;
    this.app.rig.hooks = {
      planet: {
        center: new THREE.Vector3(),
        radius: p.radius,
        surface: (dir) => this.surfaceRadius(dir),
      },
    };
  }

  surfaceRadius(dir: THREE.Vector3): number {
    const p = this.app.settings.planet;
    const e = this.gen.sample(dir.x, dir.y, dir.z, this.sample);
    return p.radius * (1 + Math.max(e, p.ocean.enabled ? 0 : e) * p.heightScale);
  }

  regenerate(version: number): void {
    const p = this.app.settings.planet;
    const key = `${p.view.resolution}`;
    if (key !== this.lod.group.userData.key) {
      this.lod.group.userData.key = key;
      this.lod.clear();
    }
    this.gen = new PlanetGenerator(this.app.settings.seed, p);
    this.lod.invalidate(version);
    this.syncHooks();
    this.buildMoons();
  }

  applyVisual(): void {
    const v = this.app.settings.planet.view;
    this.material.wireframe = v.wireframe;
    this.material.flatShading = v.flatShading;
    this.material.needsUpdate = true;
  }

  private buildMoons(): void {
    const p = this.app.settings.planet;
    const key = `${this.gen.seed}:${p.moons}:${p.radius}`;
    if (key === this.moonKey) return;
    this.moonKey = key;
    for (const m of this.moonSpec) {
      this.moons.remove(m.mesh);
      m.mesh.geometry.dispose();
    }
    this.moonSpec = [];
    const rng = new Rng(deriveSeed(this.gen.seed, 777));
    for (let i = 0; i < p.moons; i++) {
      const r = p.radius * rng.range(0.08, 0.2);
      const geo = new THREE.IcosahedronGeometry(1, 5);
      const noise = new Noise(deriveSeed(this.gen.seed, 800 + i));
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const colors = new Float32Array(pos.count * 3);
      const cell = new Float64Array(3);
      const base = new THREE.Color().setHSL(rng.range(0, 1), rng.range(0, 0.18), rng.range(0.45, 0.7));
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
        noise.worley3(x * 4, y * 4, z * 4, cell);
        const t = cell[0] / 0.38;
        const crater = t < 1 ? (t * t - 1) * 0.05 : Math.exp(-((t - 1) ** 2) / 0.05) * 0.015;
        const bump = noise.simplex3(x * 3, y * 3, z * 3) * 0.04 + crater;
        pos.setXYZ(k, x * (1 + bump), y * (1 + bump), z * (1 + bump));
        const shade = 0.85 + bump * 3;
        colors.set([base.r * shade, base.g * shade, base.b * shade], k * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
      mesh.scale.setScalar(r);
      this.moons.add(mesh);
      this.moonSpec.push({ mesh, radius: p.radius * rng.range(2.6, 5.5), speed: rng.range(0.01, 0.04) * (rng.chance(0.2) ? -1 : 1), phase: rng.range(0, Math.PI * 2), incl: rng.range(-0.35, 0.35) });
    }
  }

  update(dt: number, time: number): void {
    const p = this.app.settings.planet;
    const R = p.radius;
    const cam = this.app.camera;
    this.sunAngle += dt * p.view.rotationSpeed;
    this.sunDir.set(Math.cos(this.sunAngle), 0.28, Math.sin(this.sunAngle)).normalize();

    this.lod.update();

    // Altitude-dependent sky, fog and atmosphere fade.
    const dist = cam.position.length();
    const up = cam.position.clone().normalize();
    this.altitude = dist - this.surfaceRadius(up);
    // The sky "deepens" from space to a blue dome as you descend. It is measured from sea
    // level and reaches well above the mountains (the glowing shell itself stays thin).
    const skyHeight = R * Math.max(p.atmosphere.thickness * 2.5, p.heightScale * 5);
    const inside = p.atmosphere.enabled ? 1 - THREE.MathUtils.smoothstep(dist - R, skyHeight * 0.35, skyHeight * 1.2) : 0;
    const env = this.app.env;
    const sunUp = up.dot(this.sunDir);
    env.applyPalette(sunUp);
    const atmo = new THREE.Color(p.atmosphere.color);
    const sky = env.skyMaterial.uniforms;
    sky.uUp.value.copy(up);
    sky.uSunDir.value.copy(this.sunDir);
    sky.uZenith.value.copy(atmo).multiplyScalar(0.55).lerp(env.zenithColor, 0.35);
    sky.uHorizon.value.copy(atmo).lerp(new THREE.Color('#ffffff'), 0.45).lerp(env.horizonColor, 0.3);
    const night = 1 - THREE.MathUtils.smoothstep(sunUp, -0.15, 0.15);
    sky.uZenith.value.multiplyScalar(1 - night * 0.92);
    sky.uHorizon.value.multiplyScalar(1 - night * 0.9);
    sky.uGround.value.copy(sky.uHorizon.value).multiplyScalar(0.6);
    sky.uOpacity.value = inside;
    env.sky.visible = inside > 0.01;
    env.sky.position.copy(cam.position);
    env.sky.scale.setScalar(cam.far * 0.9);

    const scene = this.app.scene;
    if (inside > 0.01) {
      scene.fog = env.fog;
      env.fog.color.copy(sky.uHorizon.value);
      env.fog.far = THREE.MathUtils.lerp(R * 0.08, R * 3, 1 - inside) + this.altitude * 2;
      env.fog.near = env.fog.far * 0.08;
    } else {
      scene.fog = null;
    }

    // Lighting.
    env.sun.visible = true;
    env.sun.position.copy(this.sunDir).multiplyScalar(R * 10);
    env.sun.target.position.set(0, 0, 0);
    env.sun.target.updateMatrixWorld();
    env.sun.color.set('#fff6e8');
    env.sun.intensity = 3.2;
    env.hemi.visible = inside > 0.01;
    env.hemi.color.copy(sky.uZenith.value);
    env.hemi.intensity = 0.5 * inside * (1 - night);
    this.ambient.intensity = 0.07 + 0.08 * inside;

    // Ocean / atmosphere / clouds / rings uniforms.
    const ou = this.oceanMaterial.uniforms;
    ou.uTime.value = time;
    ou.uSunDir.value.copy(this.sunDir);
    ou.uSunColor.value.set('#fff1dd');
    ou.uSkyColor.value.copy(atmo).lerp(new THREE.Color('#ffffff'), 0.3);
    ou.uCenter.value.set(0, 0, 0);
    ou.uAmbient.value = 1;

    const au = (this.atmosphere.material as THREE.ShaderMaterial).uniforms;
    this.atmosphere.visible = p.atmosphere.enabled;
    this.atmosphere.scale.setScalar(R * (1 + p.atmosphere.thickness));
    au.uR.value = R;
    au.uRa.value = R * (1 + p.atmosphere.thickness);
    au.uSunDir.value.copy(this.sunDir);
    au.uColor.value.copy(atmo);
    au.uIntensity.value = p.atmosphere.intensity;
    au.uFade.value = 1 - inside * 0.85;

    const cu = (this.clouds.material as THREE.ShaderMaterial).uniforms;
    this.clouds.visible = p.clouds.enabled && p.clouds.coverage > 0;
    this.clouds.scale.setScalar(R * (1 + p.heightScale * 2.4));
    cu.uTime.value = time * p.clouds.speed * 10;
    cu.uCoverage.value = p.clouds.coverage;
    cu.uScale.value = p.clouds.scale;
    cu.uOpacity.value = p.clouds.opacity;
    cu.uColor.value.set(p.clouds.color);
    cu.uSunDir.value.copy(this.sunDir);

    this.rings.visible = p.rings.enabled;
    if (p.rings.enabled) {
      const ru = (this.rings.material as THREE.ShaderMaterial).uniforms;
      this.rings.scale.setScalar(1);
      if (this.rings.userData.key !== `${p.rings.inner}:${p.rings.outer}:${R}`) {
        this.rings.userData.key = `${p.rings.inner}:${p.rings.outer}:${R}`;
        this.rings.geometry.dispose();
        this.rings.geometry = new THREE.RingGeometry(R * p.rings.inner, R * p.rings.outer, 256, 1);
      }
      this.rings.rotation.set(-Math.PI / 2 + p.rings.tilt, 0, p.rings.tilt * 0.5);
      ru.uInner.value = R * p.rings.inner;
      ru.uOuter.value = R * p.rings.outer;
      ru.uColor.value.set(p.rings.color);
      ru.uOpacity.value = p.rings.opacity;
      ru.uSunDir.value.copy(this.sunDir);
      ru.uR.value = R;
      ru.uSeed.value = (this.gen.seed % 1000) / 10;
    }

    for (const m of this.moonSpec) {
      const a = m.phase + time * m.speed;
      m.mesh.position.set(Math.cos(a) * m.radius, Math.sin(a) * m.radius * m.incl, Math.sin(a) * m.radius);
      m.mesh.rotation.y = a * 0.5;
    }

    // Background follows the camera.
    this.stars.position.copy(cam.position);
    this.stars.scale.setScalar(cam.far * 0.8);
    (this.stars.material as THREE.PointsMaterial).opacity = 1;
    this.stars.visible = inside < 0.98 || night > 0.5;
    this.sunGlow.position.copy(cam.position).addScaledVector(this.sunDir, cam.far * 0.6);
    this.sunGlow.scale.setScalar(cam.far * 0.6 * 0.12);
  }

  clip(): [number, number] {
    const R = this.app.settings.planet.radius;
    const alt = Math.max(0.1, this.altitude);
    const dist = this.app.camera.position.length();
    return [THREE.MathUtils.clamp(alt * 0.05, 0.03, R * 0.05), dist + R * 8];
  }

  viewDistance(): number {
    return this.app.settings.planet.radius * 4;
  }

  probe(): ProbeInfo {
    const p = this.app.settings.planet;
    const dir = this.app.camera.position.clone().normalize();
    const e = this.gen.sample(dir.x, dir.y, dir.z, this.sample);
    const lat = (Math.asin(dir.y) * 180) / Math.PI;
    const lon = (Math.atan2(dir.z, dir.x) * 180) / Math.PI;
    return {
      title: `${p.name} · ${p.type}`,
      rows: [
        ['Altitude', `${this.altitude.toFixed(1)} u`],
        ['Lat / Lon', `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`],
        ['Elevation', `${e.toFixed(3)}${e < 0 && p.ocean.enabled ? ' (ocean)' : ''}`],
        ['Temperature', this.sample.temperature.toFixed(2)],
        ['Humidity', this.sample.humidity.toFixed(2)],
        ['Coordinates', `R(${p.region.x},${p.region.y},${p.region.z}) S${p.system} P${p.planet}`],
        ['Planet seed', `0x${this.gen.seed.toString(16).padStart(8, '0')}`],
      ],
    };
  }

  stats(): [string, string][] {
    return [
      ['LOD nodes', `${this.lod.visible.length} visible / ${this.lod.nodeCount} cached`],
      ['Generating', `${this.lod.pendingCount}`],
      ['Max level', `${this.app.settings.planet.view.maxLevel}`],
    ];
  }

  exportObject(): THREE.Object3D | null {
    const group = new THREE.Group();
    for (const n of this.lod.visible) {
      const mesh = n.object?.children.find((c) => c.name === 'terrain') as THREE.Mesh | undefined;
      if (!mesh || !n.object) continue;
      const copy = new THREE.Mesh(mesh.geometry.clone(), new THREE.MeshStandardMaterial({ vertexColors: true }));
      copy.position.copy(n.object.position);
      group.add(copy);
    }
    return group.children.length ? group : null;
  }
}
