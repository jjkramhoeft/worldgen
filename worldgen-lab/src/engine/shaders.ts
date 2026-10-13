/** Custom shader materials: sky, water, clouds, atmosphere and rings. */
import * as THREE from 'three';

const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * .1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 m = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { s += a * vnoise2(p); p = m * p * 2.02; a *= 0.5; }
  return s;
}
float vnoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
`;

// ───────────────────────────── sky dome ─────────────────────────────

export function createSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'Sky',
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uZenith: { value: new THREE.Color('#2f6fd0') },
      uHorizon: { value: new THREE.Color('#bcd7f0') },
      uGround: { value: new THREE.Color('#6b7a86') },
      uSunColor: { value: new THREE.Color('#ffffff') },
      uStars: { value: 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p;
        gl_Position.z = p.w * 0.99999;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir, uUp, uZenith, uHorizon, uGround, uSunColor;
      uniform float uStars, uOpacity;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float h = dot(d, uUp);
        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.45));
        col = mix(col, uGround, smoothstep(0.0, -0.22, h));
        float sd = max(dot(d, uSunDir), 0.0);
        float sunH = dot(uSunDir, uUp);
        col += uSunColor * (pow(sd, 1400.0) * 30.0 * step(-0.02, h) + pow(sd, 18.0) * 0.35 + pow(sd, 4.0) * 0.18 * (1.0 - abs(sunH)));
        if (uStars > 0.0 && h > -0.05) {
          vec3 p = d * 260.0;
          vec3 cell = floor(p);
          float r = hash13(cell);
          if (r > 0.996) {
            vec3 c = cell + 0.5 + (vec3(hash13(cell + 1.7), hash13(cell + 3.1), hash13(cell + 5.3)) - 0.5) * 0.5;
            float dist = length(p - c);
            col += vec3(0.9, 0.95, 1.0) * smoothstep(0.32, 0.0, dist) * uStars * (0.35 + 0.9 * hash13(cell + 9.0));
          }
        }
        gl_FragColor = vec4(col, uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    transparent: true,
    fog: false,
  });
}

// ───────────────────────────── water ─────────────────────────────

/**
 * Water with per-vertex depth color/alpha (attribute `waterColor`), fresnel
 * sky reflection, a sun glint and animated wave normals. With `planet` set,
 * "up" is the radial direction from uCenter.
 */
export function createWaterMaterial(planet = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: planet ? 'PlanetOcean' : 'Water',
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color('#ffffff') },
        uSkyColor: { value: new THREE.Color('#bcd7f0') },
        uAmbient: { value: 1 },
        uCenter: { value: new THREE.Vector3() },
        uWaveScale: { value: planet ? 2.5 : 1 },
      },
    ]),
    defines: planet ? { PLANET: '' } : {},
    vertexShader: /* glsl */ `
      attribute vec4 waterColor;
      varying vec4 vColor;
      varying vec3 vWorldPos;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vColor = waterColor;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uAmbient, uWaveScale;
      uniform vec3 uSunDir, uSunColor, uSkyColor, uCenter;
      varying vec4 vColor;
      varying vec3 vWorldPos;
      #include <common>
      #include <fog_pars_fragment>
      float whash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * .1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float wnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(whash(i), whash(i + vec2(1.0, 0.0)), f.x), mix(whash(i + vec2(0.0, 1.0)), whash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      vec3 waveGrad(vec3 p) {
        vec3 g = vec3(0.0);
        // Noise-jittered phases break up the regularity of the summed sine waves.
        float jitter = wnoise(p.xz * 0.045 / uWaveScale) * 6.2832 + wnoise(p.zy * 0.11 / uWaveScale) * 3.0;
        const int N = 5;
        vec3 dirs[N];
        dirs[0] = normalize(vec3(1.0, 0.0, 0.3));
        dirs[1] = normalize(vec3(-0.4, 0.0, 1.0));
        dirs[2] = normalize(vec3(0.7, 0.0, -0.8));
        dirs[3] = normalize(vec3(-0.9, 0.0, -0.2));
        dirs[4] = normalize(vec3(0.2, 0.0, 0.9));
        float k = 0.22 / uWaveScale, a = 0.036;
        for (int i = 0; i < N; i++) {
          vec3 d = dirs[i];
          #ifdef PLANET
          d = normalize(d + vec3(0.0, float(i) * 0.37 - 0.7, 0.0));
          #endif
          float ph = dot(d, p) * k + uTime * (1.2 + float(i) * 0.35) + jitter * (0.6 + 0.25 * float(i));
          g += d * cos(ph) * a * k * 6.0;
          k *= 1.7;
          a *= 0.6;
        }
        return g;
      }
      void main() {
        #ifdef PLANET
        vec3 up = normalize(vWorldPos - uCenter);
        #else
        vec3 up = vec3(0.0, 1.0, 0.0);
        #endif
        // Fade the wave normals with distance: far away they would only alias into moiré.
        float dist = length(cameraPosition - vWorldPos);
        vec3 g = waveGrad(vWorldPos) * (1.0 / (1.0 + dist * 0.012 / uWaveScale));
        g -= up * dot(g, up);
        vec3 N = normalize(up - g);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        float sunUp = dot(up, uSunDir);
        float light = clamp(sunUp * 0.8 + 0.25, 0.0, 1.0) * uAmbient + 0.04;
        vec3 base = vColor.rgb * light;
        vec3 refl = uSkyColor * (0.55 + 0.45 * clamp(dot(R, up), 0.0, 1.0)) * clamp(uAmbient + 0.08, 0.0, 1.2);
        vec3 col = mix(base, refl, fres * 0.85);
        #ifdef PLANET
        float spec = pow(max(dot(R, uSunDir), 0.0), 600.0) * 1.6 * step(0.0, sunUp);
        #else
        float spec = pow(max(dot(R, uSunDir), 0.0), 140.0) * 2.2 * step(0.0, sunUp);
        #endif
        col += uSunColor * spec;
        float alpha = clamp(vColor.a + fres * 0.35 + spec, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
  });
}

// ───────────────────────────── cloud layer (flat worlds) ─────────────────────────────

export function createCloudLayerMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'CloudLayer',
    uniforms: {
      uTime: { value: 0 },
      uCoverage: { value: 0.45 },
      uScale: { value: 1 / 900 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color('#ffffff') },
      uSkyColor: { value: new THREE.Color('#bcd7f0') },
      uFade: { value: 4000 },
      uDay: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uCoverage, uScale, uFade, uDay;
      uniform vec3 uSunDir, uSunColor, uSkyColor;
      varying vec3 vWorldPos;
      ${NOISE_GLSL}
      void main() {
        vec2 p = vWorldPos.xz * uScale + vec2(uTime * 0.012, uTime * 0.004);
        float n = fbm2(p + fbm2(p * 0.5 + 3.0) * 0.7);
        float c = smoothstep(1.0 - uCoverage, 1.0 - uCoverage + 0.22, n);
        float d = length(vWorldPos.xz - cameraPosition.xz);
        c *= 1.0 - smoothstep(uFade * 0.5, uFade, d);
        if (c < 0.01) discard;
        vec3 lit = mix(uSkyColor, uSunColor, 0.6) * (0.35 + 0.65 * uDay) + uSkyColor * 0.15;
        vec3 col = mix(lit, lit * 0.62, smoothstep(0.55, 1.0, n));
        gl_FragColor = vec4(col, c * 0.88);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}

// ───────────────────────────── planet clouds, atmosphere, rings ─────────────────────────────

export function createPlanetCloudMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'PlanetClouds',
    uniforms: {
      uTime: { value: 0 },
      uCoverage: { value: 0.5 },
      uScale: { value: 2.2 },
      uOpacity: { value: 0.9 },
      uColor: { value: new THREE.Color('#ffffff') },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      varying vec3 vNormalW;
      void main() {
        vDir = normalize(position);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uCoverage, uScale, uOpacity;
      uniform vec3 uColor, uSunDir;
      varying vec3 vDir;
      varying vec3 vNormalW;
      ${NOISE_GLSL}
      void main() {
        vec3 p = vDir * uScale;
        float t = uTime;
        vec3 q = vec3(fbm3(p + vec3(t * 0.6, 0.0, 0.0)), fbm3(p + vec3(5.2, t * 0.4, 1.3)), 0.0);
        float n = fbm3(p * 1.7 + q.xyx * 1.4 + vec3(0.0, 0.0, t));
        // fbm3 of value noise has mean ≈ 0.5 and std ≈ 0.12, so coverage maps to a threshold around it.
        float t0 = 0.74 - 0.4 * uCoverage;
        float c = smoothstep(t0, t0 + 0.12, n);
        if (c < 0.01) discard;
        float light = clamp(dot(vNormalW, uSunDir) * 0.9 + 0.2, 0.03, 1.0);
        vec3 col = uColor * light * mix(1.0, 0.68, smoothstep(t0 + 0.05, t0 + 0.3, n));
        gl_FragColor = vec4(col, c * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Ray-traced atmosphere shell: in-scatter ∝ optical path through the shell, lit by the sun. */
export function createAtmosphereMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'Atmosphere',
    uniforms: {
      uCenter: { value: new THREE.Vector3() },
      uR: { value: 1000 },
      uRa: { value: 1060 },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uColor: { value: new THREE.Color('#6fb3ff') },
      uIntensity: { value: 1 },
      uFade: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPosW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCenter, uSunDir, uColor;
      uniform float uR, uRa, uIntensity, uFade;
      varying vec3 vPosW;
      void main() {
        vec3 ro = cameraPosition;
        vec3 rd = normalize(vPosW - ro);
        vec3 oc = ro - uCenter;
        float b = dot(oc, rd);
        float c = dot(oc, oc) - uRa * uRa;
        float h = b * b - c;
        if (h < 0.0) discard;
        h = sqrt(h);
        float t0 = max(-b - h, 0.0);
        float t1 = -b + h;
        float cp = dot(oc, oc) - uR * uR;
        float hp = b * b - cp;
        bool hitsPlanet = false;
        if (hp > 0.0) {
          float tp = -b - sqrt(hp);
          if (tp > 0.0) { t1 = min(t1, tp); hitsPlanet = true; }
        }
        float len = max(t1 - t0, 0.0);
        float maxChord = 2.0 * sqrt(uRa * uRa - uR * uR);
        float density = len / maxChord;
        vec3 mid = ro + rd * (t0 + t1) * 0.5;
        float sun = dot(normalize(mid - uCenter), uSunDir);
        float light = smoothstep(-0.25, 0.35, sun);
        vec3 sunset = vec3(1.0, 0.55, 0.3);
        vec3 col = mix(uColor, sunset, smoothstep(0.3, 0.0, abs(sun)) * 0.55) * (0.15 + 0.85 * light);
        float a = 1.0 - exp(-density * (hitsPlanet ? 1.6 : 3.2) * uIntensity);
        a *= uFade * (0.08 + 0.92 * light);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
  });
}

export function createRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'Rings',
    uniforms: {
      uInner: { value: 1600 },
      uOuter: { value: 2500 },
      uColor: { value: new THREE.Color('#d9c7a6') },
      uOpacity: { value: 0.8 },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uCenter: { value: new THREE.Vector3() },
      uR: { value: 1000 },
      uSeed: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPosW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uInner, uOuter, uOpacity, uR, uSeed;
      uniform vec3 uColor, uSunDir, uCenter;
      varying vec3 vPosW;
      ${NOISE_GLSL}
      void main() {
        vec3 oc = vPosW - uCenter;
        float r = length(oc);
        float t = (r - uInner) / (uOuter - uInner);
        if (t < 0.0 || t > 1.0) discard;
        float bands = vnoise2(vec2(t * 60.0, uSeed)) * 0.6 + vnoise2(vec2(t * 210.0, uSeed + 4.0)) * 0.4;
        float a = smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.9, t) * (0.25 + 0.75 * bands);
        // Planet shadow: does the ray towards the sun hit the planet?
        float b = dot(oc, uSunDir);
        float c = dot(oc, oc) - uR * uR;
        float shadow = (b < 0.0 && b * b - c > 0.0) ? 0.15 : 1.0;
        vec3 col = uColor * (0.55 + 0.45 * bands) * shadow;
        gl_FragColor = vec4(col, a * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
