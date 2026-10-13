# Worldgen Lab

An interactive sandbox for **procedural world generation**. Tweak any parameter and the world rebuilds around you in real time.

**Try it live: https://jjkramhoeft.github.io/worldgen/** (needs a browser with WebGL2). The site is rebuilt and redeployed by GitHub Actions on every push to `main`.

There are four world types:

| Mode | What it shows |
|---|---|
| ⛰ **Terrain** | An infinite heightmap world in the style of Minecraft 1.18+. Climate noise feeds the shaping splines, which drive biomes, rivers, uber-noise detail, water and vegetation. It streams as a quadtree of level-of-detail tiles. |
| ▦ **Voxel** | A Minecraft-like block world built from a 3D density field: overhangs, cheese, spaghetti and noodle caves, lava, ores, surface rules (with deepslate and terracotta bands) and trees. You can break and place blocks; edits are stored as *deltas*. |
| ◍ **Planet** | No Man's Sky-style planets derived from a galaxy seed (region → star system → planet). You can fly from orbit down to the surface with continuous LOD. Planets have oceans (water or lava), an atmosphere, clouds, rings, moons and a day cycle. |
| ≋ **Erosion** | Hydraulic (droplet) and thermal erosion running live on a finite map, so you can watch valleys, river networks and sediment fans form. |

Everything is a pure function of **(seed, position)**. Generation runs in a pool of Web Workers, closest tiles first. Old tiles stay on screen until their replacements are ready, so you can drag a slider and watch the world change without holes.

---

## Running it

You need Node 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5199. Other scripts:

```bash
npm test
```

```bash
npm run build
```

- `npm test` runs the unit tests. They check noise ranges and derivatives, terrain continuity for every preset, splines, the settings helpers and planet determinism.
- `npm run build` type-checks and makes a static production build in `dist/`. You can serve that folder with any static server.

The app needs a browser with WebGL2: any current Chrome, Edge, Firefox or Safari.

---

## Controls

| Key / mouse | Action |
|---|---|
| **O** Orbit | Drag to rotate, right-drag to pan, wheel to zoom. **WASD** glides the orbit target and **Q/E** turns. The target follows the ground. |
| **F** Fly | Click to capture the mouse. **WASD** moves, **Space/E** goes up, **Q/C** goes down, **Shift** boosts and the **wheel** changes speed. **Esc** releases the mouse. |
| **G** Walk | Gravity, **Space** to jump or swim up, **Shift** to sprint. You step up single blocks automatically. |
| **T** Tour | Autopilot glides over the land. On planets it spins the globe instead. |
| **M** | World map with layers: shaded relief, biomes, height, every raw climate noise and rivers. Drag pans, the wheel zooms, hovering shows values and clicking travels there. |
| **K** | Spline editor: continentalness, erosion, and peaks & valleys. |
| **R** | Random seed. **◀ Previous** in the panel goes back. |
| **[ ]** | Time of day −/+ 30 minutes. |
| **P** | Screenshot. |
| **U** | Hide or show all UI. |
| **H**, **?** | Help. Below the controls, **How it works** explains the mathematics and algorithms of every generator, with live figures. |
| Voxel mode | **Left click** breaks a block, **right click** places one, **middle click** picks one, **1–9** selects a hotbar slot. |
| Planets | In orbit, the wheel changes altitude. In flight, the ship levels itself with the horizon near the ground and **Z/X** rolls. |

---

## How the terrain is built

The heightmap generator lives in `src/gen/terrain.ts` and follows the Minecraft 1.18+ noise router, with a No Man's Sky-style detail layer on top:

1. **Domain warp (optional).** The input coordinates are displaced by fBm, in the style of Inigo Quilez: `p + k·fbm(p)`, with an optional second pass.
2. **Climate noises.** Continentalness *C*, erosion *E*, weirdness *W*, temperature *T* and humidity *H*. Each is fBm with its own wavelength, contrast and offset.
3. **Peaks and valleys.** `PV = 1 − |3·|W| − 2|` is Minecraft's fold. A slightly rounded |·| keeps crests sharp but stops them aliasing.
4. **Splines** (editable with **K**):
   - *C* → base height. The default puts deep ocean near −28 m and the ocean floor near −15 m, then rises through the coast to far inland.
   - *E* → mountain factor. Low erosion means mountainous.
   - *PV* → peak multiplier. Valleys are negative.

   Height is `base(C) + inland(C) · mountain(E) · mountainHeight · ((1 − ridgeShare) + ridgeShare · peaks(PV))`. Low erosion raises a broad massif and PV cuts ridges and valleys into it.
5. **Detail noise.** One of fBm, billow, ridged multifractal, IQ derivative "erosion" fBm, or an **uber noise** with the parameters No Man's Sky exposes:
   - *sharp ↔ round*
   - *slope erosion*, using analytic noise derivatives
   - *altitude erosion*
   - *ridge erosion*
   - *perturb features*
   - *amplify features*

   It is weighted towards mountains.
6. **Post-processing.**
   - Redistribution exponent.
   - Terraces.
   - Rivers carved along `W ≈ 0`, Minecraft's "valleys", down to below sea level.
   - An optional island mask: circle, square or square bump.
7. **Biomes.** The classifier uses Minecraft's level thresholds for T, H, E, PV and C and its "middle biome" table, including the variant, plateau, peak, beach and ocean rules. A Whittaker classifier (temperature × moisture) and plain height bands are also available.

The renderer colors vertices by biome ground color. Steep slopes turn to rock, and terracotta bands appear in badlands. Snow follows a snow line that rises in warmer climates. Shores darken where the sand is wet. **Color by** in *Terrain rendering* swaps this for any raw noise, the slope or the LOD level, which shows exactly what each layer contributes.

### Level of detail without aliasing

Each quadtree tile is a 64² grid with a one-sample border, so normals are seamless across tiles, and a skirt that hides cracks between LOD levels.

Coarse tiles pass their vertex spacing to the generator. Noise octaves finer than the Nyquist limit (`1 / (2·spacing)`) fade out and are then skipped. This is how CDLOD-style terrain and No Man's Sky avoid distant terrain turning into aliased spikes, and it also makes far tiles cheaper to build. The 2D map and the planets use the same mechanism.

### Voxels

`src/gen/voxel/voxelGen.ts` evaluates density on a coarse 4×4×4 lattice and interpolates it trilinearly. Minecraft uses 4×8×4 cells.

- **Terrain density:** `(surfaceY − y) + overhang noise × jaggedness`.
- **Caves:** they combine with `min()`:
  - *Cheese:* big caverns where 3D fBm exceeds a threshold.
  - *Spaghetti and noodle:* tunnels where two independent noises are both near zero (`max(|a|, |b|) < r`). Noodles are thinner than the lattice, so, as in Minecraft, their two noises are interpolated raw and combined per block; only cells whose corner values can contain a tube are evaluated.
  - A surface shell and a seabed guard keep caves from flooding the world.
- **Surface rules** run per column: the top block and filler come from the biome, plus deepslate, bedrock, sea water above the surface, and lava in deep caves.
- **Ores** form clusters, and **trees** sit on a jittered grid. Every chunk generates a 4-block margin, so trees and leaves cross chunk borders seamlessly.

The mesher culls hidden faces and computes per-vertex ambient occlusion with the 0fps technique. It produces separate opaque, water and emissive meshes. Player edits are stored as a delta map and re-applied whenever a chunk regenerates, even under new settings.

### Planets

`src/gen/planet/*` uses a **spherified cube**, where each face is a quadtree. The surface elevation is built up in layers:

- Warped continents, shifted by the sea level.
- Ridged mountains, masked to inland areas.
- Uber detail whose slope erosion uses the tangential part of the 3D derivative.
- Worley crater fields with raised rims.
- Optional terraces.

Climate comes from latitude, altitude and noise.

`universe.ts` turns `(galaxy seed, region, system, planet)` into everything else: the planet type (lush, desert, frozen, toxic, scorched, barren, exotic or ocean), a hue-jittered palette, radius, sea level, atmosphere, clouds, rings, moons and a generated name. **◀ ▶** step through the planets of a system.

### Erosion

`src/gen/erosion.ts` implements droplet erosion after Beyer (2015) and Sebastian Lague. Each droplet does the following:

- It runs downhill with inertia.
- It erodes with a radius brush while its capacity, ∝ slope · speed · water, exceeds its sediment load.
- It deposits sediment when it slows down or climbs.
- It evaporates. Droplets reaching the sea drop their load and build deltas.

The speed update uses the physically correct sign, `v² − Δh·g` with Δh = new − old. The original code adds, which slows droplets going downhill. Thermal erosion moves material that sits steeper than the talus angle. Color modes show natural surfaces with sediment deposits, an erosion/deposition map, water flow (the river network) and height.

---

## Project layout

```
src/
  core/      rng (hashing, PRNG) · noise (simplex/perlin/value/worley + derivatives)
             fractal (fBm/billow/ridged/IQ/uber + LOD octave fading) · spline · color
  gen/       settings (model, presets, share links) · terrain · biomes · shading
             terrainMesh · map · erosion · voxel/* · planet/*
  workers/   gen.worker (tiles, chunks, planet nodes, maps) · erosion.worker · protocol
  engine/    WorkerPool (priority queue) · QuadtreeLod (generic LOD) · Environment
             (sky, sun/moon, fog, clouds, shadows) · CameraRig · shaders
  modes/     TerrainMode · VoxelMode · PlanetMode · ErosionMode · Vegetation
  ui/        Panel (Tweakpane) · Toolbar · Hud · Minimap · MapOverlay · SplineEditor · Help
             helpDocs (the "How it works" chapters, typeset with KaTeX, loaded on first open)
             helpFigures (live plots, images and tables computed by the generator code)
  app/App.ts settings flow, modes, exports, frame loop
tests/       noise and terrain tests (Vitest)
docs/        RESEARCH.md — the research notes behind the algorithms, with sources
```

**Settings flow.** The panel binds directly to one plain settings object. Generation changes bump a version number, publish a snapshot to the workers and invalidate the active world. Tiles regenerate nearest first while the old ones stay visible.

Settings persist in `localStorage`. **Share** encodes the difference from the defaults, deflate-compressed, into the URL. **Save settings** and **Load settings** use JSON files.

**Exports** include a PNG screenshot, a `.glb` mesh of the visible terrain or chunks, and a heightmap PNG. In planet mode the heightmap export saves an equirectangular surface map instead.

---

## Presets

| Preset | Idea |
|---|---|
| Minecraft-like (default) | Multi-noise climate, splines and biomes modelled on 1.18+. |
| Amplified | Like the world type: towering mountains everywhere. |
| Large Biomes | All climate noise stretched 3×. |
| Archipelago | Warm, shallow seas full of small islands. |
| Alpine | Cold, rugged and mostly inland. |
| Badlands Mesas | Hot and dry, with terraced plateaus and terracotta bands. |
| Lone Island | A radial island mask. |
| Superflat | Every spline flattened. |
| Dreamscape | Heavy two-pass domain warping. |
| Eroded Highlands (IQ) | Derivative-damped fBm: gullies and smooth valleys. |
| Alien World (NMS-ish) | Uber noise with feature amplification, terraces and a hue-shifted palette. |

---

## Notes and limitations

- Minecraft numbers (thresholds, PV fold, spline anchors, cell sizes) come from the vanilla data and decompiled code summarized in `docs/RESEARCH.md`. The terrain is *inspired by* Minecraft, not a bit-exact clone: it uses simplex noise and simplified splines.
- No Man's Sky's exact formulas are not public. The uber noise here is a reconstruction that uses the game's parameter names; see the research notes.
- Voxel worlds span y −64…319. Very high terrain (Amplified with the voxel height scale above 1) is clipped at the top.
- Planet LOD has no horizon culling, so the far side of the planet keeps a few coarse tiles. Frustum culling hides them.

## References

See `docs/RESEARCH.md` for the full list. The key ones:

- Minecraft Wiki: *World generation*, *Noise router*, *Density function*. misode's *deepslate* reimplementation and the vanilla worldgen JSON.
- Henrik Kniberg, *Reinventing Minecraft world generation*.
- Sean Murray, *Building Worlds Using Math(s)*, and Innes McKendrick, *Continuous World Generation in No Man's Sky* (both GDC 2017).
- Inigo Quilez: fBm, domain warping and noise derivatives. Red Blob Games, *Making maps with noise functions*.
- H. T. Beyer, *Implementation of a method for hydraulic erosion* (2015). Sebastian Lague, *Hydraulic Erosion*. Olsen, *Realtime Procedural Terrain Generation* (2004).
- Stefan Gustavson, *Simplex noise demystified*. Mikola Lysenko (0fps), *Ambient occlusion for Minecraft-like worlds*.
