# Watershed mode: design

The fifth world type of worldgen-lab, placed between **Terrain** and **Voxel** in the toolbar. It builds land in the opposite order from Terrain mode. Each continent first gets its river outlets on the coast. Then a drainage network grows inland from them, the rivers get heights from the mouth upward, and only then is the terrain built around the rivers.

**Status:** implemented 2026-10-13 (milestones M1–M4 in §12; M5 is still open). The design was written first and then adjusted while building; the places where the build differs from the first draft are noted in the text. Decisions: **one continent per region** and **64 km regions**. The research behind it is in [RIVERS-AND-ROADS.md](RIVERS-AND-ROADS.md), cited below as **R§n**.

Measured numbers below are for the default settings and seed (`worldgen-lab`), region (0, 0).

---

## 1. Summary

- **What it is.** An infinite heightmap world, streamed with the same quadtree LOD as Terrain mode. It is an endless ocean with one continent per 64 km region. Each continent is a complete drainage system: every river starts inland, grows as tributaries join, and ends in the sea.
- **How it differs from Terrain mode.** Terrain mode carves rivers along a noise level set (W ≈ 0), so they never fork or join and have no source or mouth (R§2.1). Here the river network is built first, as a graph, and the terrain is made to fit it (R§3.5).
- **Why.** Two things follow from building rivers first:
  1. **Correct hydrology by construction.** Rivers run downhill, tributaries join, every river reaches an outlet, and nothing is trapped in a pit.
  2. **The network is data.** It is a graph with drainage area, discharge and stream order on every reach. Settlements and roads need exactly that later (§14, R§7).
- **Where the ideas come from** (R§3.5–3.6, R§4.2):
  - Outlets and inland growth: Génevaux et al. 2013 and TerraFirmaCraft.
  - The drainage forest: Derzapf et al. 2011 and Fischer et al. 2022.
  - Heights: the steady state of the stream power law (Cordonnier et al. 2016).
  - One self-contained drainage system per macro cell: TerraForged and TerraFirmaCraft.

---

## 2. Goals and non-goals

**Goals**
1. **Downhill everywhere.** A river's water level never rises downstream, at every LOD.
2. **A real network.** Tributaries join, and rivers never cross.
3. **Size follows flow.** Width, depth and valley size come from drainage area (R§5).
4. **Water at its own level.** Rivers and lakes get their own water surfaces instead of the single sea plane.
5. **Pure and infinite.** Everything is a function of (seed, settings, position). Any worker can build any tile in any order and get the same result.
6. **Inspectable.** Basins, stream order and discharge show up in the map, the colour modes and the probe.
7. **Interactive.** A 64 km region builds in about 0.2 s and is cached, so changing a setting rebuilds the visible world in a second or two.

**Non-goals for this version**
- **Settlements and roads.** The data is designed for them (§14), but they come later.
- **Rivers that cross between continents.** Each continent drains on its own (§4.3).
- **Deltas, braided rivers, oxbow lakes and waterfalls as features.** R§5.4 found no simple procedural method for deltas.
- **Erosion simulation** (Erosion mode has it) **and a voxel version** (milestone M5). Voxel mode is untouched.
- **Changes to Terrain mode.** Terrain keeps its own rivers and looks the same; R§8.1 covers improving them.

---

## 3. Place in the app

### 3.1 Mode order
The toolbar makes one button per entry of `MODES` (`src/ui/Toolbar.ts`). The new entry sits at index 1, so its button is between Terrain and Voxel:

| Order | Id | Label | Icon | Blurb |
|---|---|---|---|---|
| 1 | `terrain` | Terrain | ⛰ | Infinite heightmap world with LOD, biomes, rivers and vegetation |
| **2** | **`watershed`** | **Watershed** | **⋔** | **River-first continents: every river runs downhill to the sea** |
| 3 | `voxel` | Voxel | ▦ | Minecraft-style blocks: 3D density, caves, ores, trees, editable |
| 4 | `planet` | Planet | ◍ | No Man's Sky style planets from a galaxy seed, with continuous LOD |
| 5 | `erosion` | Erosion | ≋ | Hydraulic + thermal erosion simulation on a finite map |

```ts
// src/gen/settings.ts
export type ModeId = 'terrain' | 'watershed' | 'voxel' | 'planet' | 'erosion';
export const MODES = [
  { id: 'terrain', /* … */ },
  { id: 'watershed', label: 'Watershed', icon: '⋔', blurb: 'River-first continents: every river runs downhill to the sea' },
  { id: 'voxel', /* … */ },
  // planet, erosion
];
```

**The name** fits both meanings of the word. In US usage a watershed is a drainage basin; in UK usage it is the divide between two basins. The mode is made of both. The icon (U+22D4, a fork) suggests a confluence.

### 3.2 Everywhere else the order appears
- `src/ui/Panel.ts`: `ALL` gets `'watershed'` after `'terrain'`. The Terrain-generator folders (`FLAT`: Terrain, Voxel, Erosion) do not apply to it; a new `SKY` list shows *Sky & lighting* in every flat world including Watershed. *(The first draft put Watershed in `FLAT`; that would have shown Terrain's settings.)*
- `src/app/App.ts`: the `modes` object has `watershed: new WatershedMode(this)` after `terrain`.
- `src/ui/helpDocs.ts`: the chapter `doc-watershed` ("Watershed worlds: rivers first") sits between `doc-lod` and `doc-voxel`; the quick help (`Help.ts`) lists the mode second.
- `README.md`: the mode table, a "Watershed worlds" section, the presets and the project layout.

---

## 4. The world

### 4.1 What you see
- **An endless ocean** with a continent in most regions (90 %). Continents have bays, peninsulas and some offshore islands.
- **Varied relief.** Mountains rise where the uplift field is high, coastal plains lie where it is low, and branching river systems run between them.
- **Rivers that grow.** They start as brooks in steep headwater valleys, join and widen, flatten toward the coast, and end in estuaries.
- **Valleys** are steep and narrow upstream and open into floodplains downstream, where the rivers meander. Forests and wetlands follow the rivers.
- **Lakes** sit on flat stretches of river, behind a sill.

### 4.2 Scale at the defaults
| Quantity | Value | Note |
|---|---|---|
| Region spacing R | 64 km | jittered lattice, at most one continent per region |
| Open sea inside each region border | ≥ 4 km | so continents are ≥ 8 km apart |
| Continent | about 2,100 km² of land (≈ 50 km across) | region (0, 0); size varies by up to 35 % per region |
| Network grid g | 256 m | 80,647 nodes in the region, 32,460 of them land, 1,956 outlets |
| River threshold | 3 km² of drainage | about 46 grid cells |
| Rivers | 386 reaches, 822 km, Strahler order up to 4 | 2,555 river nodes |
| Lakes | 23 | chance 0.25 per flat candidate |
| Largest basin | 249 km² | |
| River width | 3.8 m where a river starts, 35 m at the largest mouth | `width100` = 22 m at 100 km² |
| Relief | highest node 576 m | from the stream power profile (§5.6) |

Terrain mode's mountains reach about 200 m plus 38 m of detail, so a Watershed continent is somewhat higher but similar in feel. *(The first draft assumed 16 km regions on a 128 m grid; with 64 km regions the grid is 256 m, so a region has about 80,000 nodes instead of 16,000.)*

### 4.3 Why one continent per region
All the guarantees need the whole upstream basin and the route to the outlet, so they can't be computed point by point (R§1, R§4.1). The design bounds that dependency the way TerraForged and TerraFirmaCraft do (R§4.2). The plane is split into regions, and **each region's land is a complete continent surrounded by its own sea.** A continent never touches a region border, so:
- a region's network depends only on (seed, settings, region id);
- neighbouring regions only have to agree about open ocean, which is an analytic function;
- every land sample needs exactly one region's network.

Alternatives considered:

| Option | Why not now |
|---|---|
| A finite map, like Erosion mode | Simplest, but it loses infinite streaming, and Erosion already covers finite maps. |
| Rivers traced over Terrain mode's heights (Davis 2026 style) | That is an upgrade for Terrain mode (R§8.1, option A), not river-first, and its guarantees depend on the input heights. |
| Continents spanning regions, with river gates on region edges | Consistent, but much more work (R§4.3 C). It is the natural next step (§13). |

The cost of this design is that every continent is an island. Warp, jitter, land chance and size variation hide the lattice.

---

## 5. Generation pipeline

Stages 5.1–5.8 run **once per region** and are cached (`network.ts`). Stages 5.9–5.11 run **per sample** in tile, map and probe jobs (`watershedGen.ts`).

```
per region (cached):
  5.1 regions → 5.2 land and sea → 5.3 outlets → 5.4 growth → 5.5 area and order
             → 5.6 heights → 5.8 lakes → 5.7 river curves
per sample:
  5.9 surface → 5.10 water → 5.11 climate, biome, vegetation
```

### 5.1 Regions
`regions.ts`
- **Sites** sit on a jittered lattice: `site(i, j) = ((i + ½ + J·(u − ½))·R, (j + ½ + J·(v − ½))·R)`, with u and v from `unit(hash2i(i, j, ·))` and J = 0.7.
- **Domain warp first:** `p' = p + A_w·(fbm₁(p), fbm₂(p))`, with A_w = 6 km at a 40 km wavelength (3 octaves). Every region lookup uses p', so borders and coastlines come out wavy, not polygonal. The warp is always evaluated in full, so region membership never depends on the level of detail.
- **The region of p** is the site nearest to p', searched over the 5×5 block of lattice cells around p'. That search is exact for J ≤ 1.
- **Border distance:** `b(p) = min over other sites s_k of (|p' − s_k|² − |p' − s₁|²) / (2·|s_k − s₁|)`. This is the exact distance to the Voronoi edge. It is 0 on the border from both sides, so it is continuous.
- **Land regions:** a region with `unit(hash) ≥ landChance` (0.9) is open ocean.

### 5.2 Land and sea
- **Coast function:** `L(p) = f·b(p) − m − setback·n(p')`. Here m is the sea margin (4 km), setback is 14 km, n = clamp(0.5 + 0.8·fbm, 0, 1) is an 8-octave coast noise with a 24 km wavelength, and f ∈ [0.65, 1] is hashed per region (`sizeVariation` 0.35). Land is where L > 0.
- **Ocean regions** use `L = −b(p) − m − setback·n(p')`. On a border, where b = 0, both forms give the same value, so L is continuous across all regions.
- **L as a distance.** L is roughly a signed distance to the coast in metres. The ocean floor, beaches and biomes use it (§5.9, §5.11).
- **Islands.** Land pieces detached from the main body become islands. They get their own small drainage systems in the same pass.

### 5.3 Outlets
- **Shared grid.** Network nodes sit on a global lattice with spacing g, so neighbouring regions use the same node positions.
- **Region nodes** come from a flood fill outward from the site, keeping each node whose nearest site is this region's site. A border fragment the fill misses is always sea, because land stays at least m from every border.
- **Outlets** are land nodes with a sea neighbour (8-connectivity). Each one is the root of a drainage tree and starts at the beach height (0.6 m).
- **Mouth bias.** Each outlet starts with an extra cost of `mouthBias · 10·g · n_m(p)`, where n_m is a low-frequency noise (9 km). Outlets with a high start cost lose land to their neighbours. A low bias gives many small coastal basins; a high bias gives a few large rivers. This plays the role of Génevaux's ζ (R§3.5). Default 0.6.
- **Inland seas.** Bodies of sea enclosed by land are sea too, so their shores are outlets as well.

### 5.4 Growing the drainage network
Growth is a **shortest-path forest from the outlets**: Dijkstra with a binary heap. It is the same idea as Génevaux's "grow the lowest open node first" and as Priority-Flood (R§3.3, R§3.5).
- **Edge cost** from a settled node a to a neighbour b: `c = |ab| · U(b) · (1 + jitter·(2ξ(b) − 1))`. U is the uplift field (§5.6), ξ = `unit(hash2i(b, ·))`, and jitter defaults to 0.45. The jitter breaks ties and grid regularity, so basins branch naturally, and basins spread fastest through low uplift, so rivers run in the structural lows.
- **Receivers.** When b is settled, its receiver is the neighbour it was reached from. Every land node then has exactly one receiver, and following receivers always ends at an outlet. The result is a spanning forest (Derzapf; Fischer; R§3.5).
- **No crossings.** A diagonal edge is rejected if the other diagonal of the same 2×2 cell is already a tree edge. The node is then re-pushed with its next-best settled neighbour.
- **Settle order** is recorded. A node's receiver always comes before it.

### 5.5 Area, discharge and stream order
These are computed in reverse settle order, children before parents:
- **Effective area:** `A(n) = g²·rain(n) + Σ A(children)`, in km². `rain` = 1 + 0.6·v is a noise field with values in [0.4, 1.6].
- **Discharge:** `Q = A × runoff`. The default runoff is 350 mm/yr, about 0.011 m³/s per km², from Hack's Potomac rule (R§5.2). The probe shows Q; river geometry uses A.
- **River nodes** have `A ≥ threshold` (3 km²). A river node's receiver always has a larger area, so the rivers form a sub-forest that ends at outlets.
- **Strahler order** is computed on the river sub-forest only. Sources are order 1. If two or more inflows share the highest order, the outflow gets that order + 1; otherwise it keeps the highest order (R§5.1).
- **Reaches** are the chains of river nodes between sources, junctions and mouths. Each is keyed by its first node, whose hash also seeds its meander phases.

### 5.6 Heights: rivers first
Heights are assigned **from the outlets upward**, in settle order:

```
h(outlet) = beach
h(n)      = h(receiver(n)) + |n − receiver(n)| · S(n)
S(n)      = clamp( k · U(n) · A(n)^(−θ),  minSlope,  maxSlope )      A in km²
```

- **The law behind it.** This is the steady state of the stream power law, S ∝ A^(−m/n) with m/n ≈ 0.5 (Cordonnier et al. 2016 §6.4; R§3.6). Big rivers get gentle slopes and headwaters steep ones. Long profiles come out concave, main valleys cut deep, and the land between rivers rises into ridges. Divides form where neighbouring trees meet.
- **No pits.** Every node is strictly higher than its receiver, so the coarse surface has no pits, and water from any node reaches the sea.
- **Defaults** are k = 0.045, θ = 0.5, minSlope = 0.0004 and maxSlope = 0.85.
  - At U = 1, a single 256 m cell (0.066 km²) gets a slope of about 0.18 (10°), and a 100 km² river about 0.0045.
  - In nature, lowland rivers fall about 0.0001–0.001 and mountain streams 0.02–0.1, so these values are in range.
- **Uplift:** `U(p) = (0.3 + 1.5·(1 − |v(p)|)³) · (0.5 + 0.5·smoothstep(0, 3 km, L))`. v is a 4-octave noise with a 28 km wavelength. Its zero lines become mountain belts, as in ridged noise, and the second factor keeps coasts gentle. Û = U / 1.8.
- **Water level** of a river node: `w(n) = h(n) − beach + seaLevel`, so rivers meet the sea at sea level.
- **Hillslope:** `S_hill(p) = clamp(k·U(p)·(g²)^(−θ), minSlope, maxSlope)`, the slope a single headwater cell gets at p. The valley walls in §5.9 use 1.3 × this.

### 5.7 Rivers as curves
On the grid, a reach is a chain of 45° steps. To draw it:
1. **Jitter the control points.** Each node's point moves by up to ±0.25·g, hashed per node. Every reach that meets a junction uses the same point there.
2. **Smooth** with a centripetal Catmull–Rom spline, at about 4 samples per grid step (g/4 = 64 m).
3. **Meander.** The channel is offset along the curve's normal by `a·sin(φ(s))` (evaluated per sample, not stored as geometry), with wavelength λ = max(11·W, 80 m) and amplitude a = min(2.7·W^1.1, 0.3·g), from Leopold & Wolman's fits (R§5.4).
   - The amplitude is scaled by `meander · (1 − smoothstep(0.002, 0.02, S))`, so steep reaches stay straight, limited to 0.35 × the curve's radius of curvature, changes by at most 0.25 m per metre, and fades to 0 at both ends of a reach.
   - Natural meanders are irregular, so the wavelength wanders by ±30 % and the amplitude by ±35 % along the river, with phases hashed per reach. *(Added after the first look: a pure sine looked artificial.)*
   - The distance to the meandering channel is `|lat − m| / √(1 + m′²)`, with lat the signed offset from the centreline.
4. **Extend into the sea.** The mouth reach continues 2·g past the outlet, with water at sea level, so the channel cuts through the beach. TerraForged does the same (R§3.5).
5. **Store per point** (stride 14): position, arc length, water level (interpolated along arc length, so it never rises), width `W = width100·(A/100)^0.5`, depth `D = depth100·(A/100)^0.4` (downstream hydraulic geometry, Leopold & Maddock 1953, R§5.3), slope, area, meander amplitude and phase, floodplain half-width `F = max(floodplain·W, a + W)` (so the floodplain covers the meander belt), the reach of the valley terms `F + 6W + 120 m`, the Strahler order and a lake flag.
6. **Index** the segments in a bucket grid with 256 m cells. Each segment is entered in every bucket its reach (plus 45 m for far-tile widening) touches, so a sample reads a single bucket.

### 5.8 Lakes
Lakes are built before the curves, so the curves know where the lakes are.
- **Sites:** river nodes with S < 0.01 and `unit(hash) < chance` (0.25), at least 3·g from the coast, and at least max(2.5·radius, 6·g) from another lake.
- **Level:** the sill n is raised to `h(n) + dam`, with the dam hashed between 3 and 12 m; the lake level is that height's water level.
- **Footprint:** a flood fill **within n's upstream subtree** over nodes below the level, limited to `radius` (2.5 km). Restricting the fill to the tree keeps the lake inside one catchment. Nodes that touch the sill's downstream chain are left out, so the lake can never reach around its sill.
- **Rim guard:** any other 8-neighbour of the footprint lower than the level + 1 m is raised to it, and its upstream subtree is lifted to keep draining (`h(c) = max(h(c), h(parent) + ℓ·max(minSlope, 0.002))`). A lake whose rim would touch the sea, an outlet, another lake or a protected chain is dropped. Heights only ever go up, so every node outside a lake still lies above its receiver.
- **Rivers and bed:** river curves inside a lake are not carved or indexed; curves entering or leaving it get no levees. The lake bed is the drowned valley itself.

### 5.9 The surface at a point
For a sample p (world x, z), Δ is the sample spacing of the caller's grid. As in Terrain mode, detail octaves finer than Δ fade out.

1. **Region and coast.** Compute p', the region, b and L (§5.1–5.2).
2. **Rivers in reach.** Read the bucket of p and, for each segment, the distance d to the centreline, the meandering channel distance d_c, and the water level w, width W, depth D and floodplain F at the projection.
3. **Ground before rivers, g₀.**
   - **Ocean** (L ≤ 0): `g₀ = sea − 12·smoothstep(0, 1.5 km, −L) − 18·smoothstep(1.5 km, 6 km, −L)`. That reaches −12 m on the shelf and −30 m in deep water, close to Terrain mode's −15 and −28 m.
   - **Land** (L > 0): a Catmull–Rom interpolation of the 4×4 surrounding node heights (beach height for sea nodes), plus detail noise × amplitude × (1 − bias + bias·Û) × fadeRiver × smoothstep(0, 300 m, L). Then blend to the coast: `g₀ = sea + (base − sea)·smoothstep(0, 150 m, L)`. *(The draft said bilinear; bicubic avoids visible creases on the 256 m grid.)*
   - Both branches give `sea` at L = 0, so g₀ is continuous.
4. **River terms**, with wall slope s = 1.3·S_hill(p), bank β and c = smoothstep(0, 150 m, L):
   ```
   valley_i = w + β + s·max(0, d − F)                     rises away from the river
   levee_i  = w + β − s·max(0, d − F) − 50·(1 − c)        falls away from the river
   chan_i   = w + β − (D + β)·r·(1 − (2·d_c/W′)²)         if d_c < W′/2
   e_i      = smoothstep(F + W, reach_i, d)                hand-over to g₀
   valley′  = valley < g₀ ? valley + (g₀ − valley)·e : valley
   levee′   = levee  > g₀ ? levee  + (g₀ − levee)·e  : levee
   h = min( max( min(g₀, min valley′), max levee′ ), min chan )
   ```
   - **valley** cuts the terrain down into a valley with a flat floodplain at w + β.
   - **levee** raises the ground to w + β wherever the base surface was below the water (a perched river), so water never spills. Its `−50·(1 − c)` switches it off smoothly in the sea, so river mouths don't build embankments into the ocean. Lake edges get no levee.
   - **chan** cuts a parabolic bed from w + β at the edge down to w − D in the middle.
   - **The hand-over e** blends both profiles into g₀ across the outer band. *(The draft cut the terms off at a fixed reach; where hillsides were steeper than the valley wall, that left vertical cliffs.)*
   - Every term is a min or a max of continuous functions, so the surface stays continuous, including at confluences and coastlines.
   - Samples within 2·g + 150 m of the coast on the sea side also query the network, so mouth channels continue into the shallows.
5. **Far tiles.** W′ = max(W, min(2.5Δ, 6W, 80 m)) widens big rivers so they stay visible; r = smoothstep(0.8Δ, 1.6Δ, W′) leaves channels the grid cannot resolve uncut (they would otherwise break up into stray water patches); meanders fade out once Δ > λ/16.
6. **`fadeRiver`** goes from 0 at the floodplain edge to 1 at `F + 2·W + 30 m`, so detail noise never dams a river.

### 5.10 Water
- **The sample's water level** (NaN when dry):
  1. inside a grid cell that touches a lake node: the lake level;
  2. inside a channel or floodplain (`d < F + W′/2 + 2Δ`): w of the nearest such river;
  3. otherwise, ground below sea level: sea level;
  4. otherwise: NaN.
- **Tile water mesh.** The water mesh uses the same grid as the tile, with y = the water level; dry vertices sit at min(sea, ground − 1), below their ground. The surface slopes along each river; at the edges it slides under the banks, which are at least β above it. Depth colouring uses water − ground.
- **Camera.** The rig has a `waterAt(x, z)` hook next to the old single `waterLevel`, so you can swim in rivers and lakes and the orbit target rides on their surface.
- **Flow direction.** Each water vertex carries its downstream direction × speed (`waterFlow`, speed from the slope); a `FLOW` variant of the water shader carries its ripples downstream. Terrain and Planet water use the unchanged shader.

### 5.11 Climate, biomes and vegetation
`WatershedGenerator.sample()` fills a `TerrainSample` (plus the extra fields of `WatershedSample`), so the tile builder, `TerrainShader`, the map renderer and vegetation all work with it:

| Field | Value in this mode |
|---|---|
| `height` | §5.9 |
| `temperature` | a climate noise (90 km, offset +0.2); altitude cools it in the biome rules |
| `humidity` | 1.2·(rain − 1) + 0.45·(1 − smoothstep(0, 900 m, distance to the river network)) + 0.05, so forests and wetlands follow the rivers |
| `continentalness` | clamp(L / 5 km, −1, 1), so the beach and ocean rules work |
| `erosion` | 1 − 2·Û: low erosion means mountainous, as in Minecraft's convention |
| `mountain` | Û |
| `weirdness`, `pv` | 0 (no meaning here) |
| `river` | 1 in the channel, fading to 0 at the bank |
| `water`, `flowX`, `flowZ` | §5.10 |
| `biome` | own rules, then Whittaker (below) |

**Biome rules** (default `whittaker`): water bodies first (rivers and lakes above sea level are *River* / *Frozen River*, the sea gets the ocean biomes by temperature and depth); then beaches; then **wetlands** (*Swamp*, *Mangrove Swamp* when hot) on the floodplains of rivers of order ≥ 2; then peaks above 520 m; otherwise the Whittaker table with the temperature cooled by altitude / 1000 m. *Height bands* is the alternative classifier. Vegetation is placed as in Terrain mode, but never under a river or lake.

---

## 6. Guarantees
These hold by construction, and §11 tests each one.

| # | Guarantee | Why it holds |
|---|---|---|
| G1 | Every land node drains to an outlet, with no cycles | a spanning forest grown from the outlets (§5.4) |
| G2 | Every node outside a lake is strictly higher than its receiver; lake beds lie below their lake, and each lake's sill is higher than its receiver | S ≥ minSlope > 0 (§5.6); lakes only raise heights outside their footprint (§5.8) |
| G3 | Water never rises downstream; it strictly falls along every river above sea level | node levels fall along receivers, arc-length interpolation keeps that (§5.7); lakes are level and are not river curves |
| G4 | Rivers never cross | tree edges plus the diagonal rule (§5.4) |
| G5 | Banks are at least β above the water on land | the levee term (§5.9) |
| G6 | The surface is continuous, including across region borders and coastlines | b, L, the bicubic base and every river term are continuous (§5.1–5.9) |
| G7 | The network and the water levels are the same at every LOD | the network doesn't depend on Δ; far tiles only fade detail and meanders, and widen or skip channels (§5.9 step 5) |
| G8 | Results don't depend on tile, region or worker order | a region depends only on (seed, settings, i, j) |

**Not guaranteed:** small closed hollows from detail noise, away from rivers. They never hold water, because water is only drawn for rivers, lakes and the sea.

---

## 7. Data and caching

```ts
interface RegionNetwork {
  i: number; j: number; land: boolean; g: number;
  a0: number; b0: number; bw: number; bh: number;  // node bounding box (global lattice coordinates)
  index: Int32Array;                               // bbox cell → node, −1 = not in this region
  n: number; ga: Int32Array; gb: Int32Array;       // node coordinates
  kind: Uint8Array;                                // 1 sea, 2 land, 3 outlet
  L: Float32Array; uplift: Float32Array;           // coast function and uplift at the node
  height: Float32Array;                            // ground height (m); sea nodes hold the beach height
  water: Float32Array;                             // water level of river and lake nodes, NaN elsewhere
  area: Float32Array; slope: Float32Array;         // upstream area (km²), channel slope
  receiver: Int32Array; basin: Int32Array;         // downstream node, the outlet it drains to
  strahler: Uint8Array; lake: Int16Array;          // 0 = not a river; lake id, −1 = none
  dRiver: Float32Array;                            // distance to the river network (m)
  lakes: LakeInfo[];
  pts: Float32Array; segs: Int32Array;             // river curve points (stride 14) and segments
  bucket: { x0; z0; size; nx; nz; start: Int32Array; items: Int32Array };
  stats: RegionStats;                              // build time, counts, river length, max order
}
```

- **Size.** About 80,000 nodes × ~50 bytes, plus the bounding-box index, the curve points and the buckets, comes to roughly **6 MB per region**.
- **Per-worker LRU** of 4 regions, keyed by region id, plus a fast path for the last region used. A worker keeps its Watershed generator (and so its region cache) across settings changes that don't touch the world, such as the colour mode or the view settings.
- **Main thread.** `WatershedMode` keeps its own generator for `groundAt`, `waterAt`, the probe and the camera, as `TerrainMode` does. The first query in a new region builds that region synchronously, a one-off hitch of about 0.2–0.3 s.
- **Duplicate builds.** Every worker that needs a region builds it itself. That duplicates work but keeps everything pure. Sharing memory between workers would need cross-origin isolation headers, which GitHub Pages can't set.

---

## 8. Performance (measured)

| Step | Measured | Notes |
|---|---|---|
| Region build (all of §5.1–5.8) | 160–310 ms | Node and Chrome, one core; 80k nodes, 32k land; membership and noise dominate |
| One sample | about 3 µs on average, about 7 µs next to rivers | ~30 noise calls plus one bucket |
| One tile job (65² samples plus vegetation) | about 20 ms on average | the worker pool's running average |

*(The draft targeted 40 ms per region for 16 km regions. A 64 km region has 16 times the area, so 0.2 s is in line; regions are cached and rarely rebuilt.)*

---

## 9. Settings and UI

### 9.1 Settings
A top-level `watershed: WatershedSettings` in `AppSettings`, with `defaultWatershed()`. `mergeSettings` fills in missing keys, so saved settings and share links from before the change still load.

```ts
export interface WatershedSettings {
  seaLevel: number;                    // 0
  verticalScale: number;               // 1
  regions: { size; jitter; warp; warpScale; landChance };
  //         64000  0.7     6000  40000      0.9
  coast: { margin; setback; scale; octaves; beach; sizeVariation };
  //       4000    14000    24000  8        0.6    0.35
  network: { grid; jitter; mouthBias };
  //         256   0.45    0.6
  relief: { k; concavity; minSlope; maxSlope; uplift: ClimateNoise; detail: DetailSettings };
  //        0.045 0.5     0.0004    0.85      28 km, 4 oct           uber, 22 m, 900 m
  climate: { rain: ClimateNoise; runoff; temperature: ClimateNoise };
  //         30 km, 3 oct        350     90 km, offset 0.2
  rivers: { threshold; width100; depth100; floodplain; bank; meander };
  //        3 km²      22 m      2.2 m     2 (× W)     0.8 m  1
  lakes: { enabled; chance; radius };  // true, 0.25, 2500 m
  biomes: { mode; beachHeight; peakHeight; snowLine; lapse };  // 'whittaker', 2, 520, 520, 1000
  colorMode: WatershedColorMode;       // 'natural'
}
```

LOD, water colours, vegetation and shading come from the existing `terrainView` settings, shared by both heightmap modes; the colour mode is Watershed's own.

### 9.2 Panel folders (Watershed only)
| Folder | Controls |
|---|---|
| Preset | Temperate continents (default), Highlands, Lowland plains, Archipelago, Great rivers, Arid — all with 64 km regions |
| Continents | region size, land chance, site jitter, border warp and its wavelength, sea margin, coast setback, wavelength and octaves, size variation, sea level, vertical scale |
| Drainage network | grid spacing (128 / 192 / 256 / 384 / 512 m), growth jitter, mouth bias, runoff, rain noise |
| Relief (stream power) | slope constant k, concavity θ, min and max slope, uplift noise, detail noise |
| Rivers & lakes | river threshold, width and depth at 100 km², floodplain, bank height, meanders, lakes on/off, chance and radius |
| Climate & biomes | temperature noise, classifier, cooling with altitude, beach height, peaks, snow line |
| Watershed rendering | colour mode, plus the shared view distance, LOD, water and vegetation controls |

The **Splines** button and the **K** key stay disabled in this mode, because there are no climate splines. The orbit hint drops "K splines".

### 9.3 Colour modes, map, probe and stats
- **Colour modes and map layers:** drainage basins (a hashed colour per outlet), stream order, upstream area (log scale), uplift and rain, plus natural, biome, height, slope, temperature, humidity, rivers and LOD.
- **Map and minimap:** their own layer list and zoom in this mode (the map opens at about 50 km across, the minimap reaches 128 km). Rivers are drawn on every layer, at least about a pixel wide; when zoomed out, only rivers of higher order (order ≥ 2 from 40 m per pixel, ≥ 3 from 120 m, ≥ 4 from 300 m). Hovering shows height, water, region, upstream area, discharge and order.
- **Probe rows:** position · region (i, j) · height · water · upstream area (km²) · discharge (m³/s) · Strahler order · distance to river · basin mouth position · uplift.
- **Stats:** LOD nodes · vegetation · the last region build (ms, land nodes) · its rivers (reaches, km, highest order, lakes).
- **Camera start:** the camera starts over the continent nearest the origin, since (0, 0) may be open ocean.
- **Heightmap export:** 1024² pixels at 16 m (16 km square), heights −40 … 700 m.

---

## 10. Code map

**New files**

| File | Contents |
|---|---|
| `src/gen/watershed/regions.ts` | lattice, warp, nearest sites, border distance b, coast function L |
| `src/gen/watershed/fields.ts` | uplift, rain, temperature, outlet noise, detail noise, hillslope |
| `src/gen/watershed/network.ts` | the region build: membership, outlets, growth, area, heights, lakes, order, river distance, reaches, curves, buckets |
| `src/gen/watershed/watershedGen.ts` | `WatershedGenerator`: region LRU, `sample`, `height`, biome rules, probe data (§5.9–5.11) |
| `src/gen/watershed/shading.ts` | `WatershedShader`: the colour modes |
| `src/gen/watershed/map.ts` | map strips for the map, minimap and heightmap export |
| `src/modes/WatershedMode.ts` | the `WorldMode`: shared LOD quadtree with job kind `watershedNode`, flowing water, probe and stats |
| `tests/watershed.test.ts` | §11 |

**Changed files**

| File | Change |
|---|---|
| `src/gen/settings.ts` | `ModeId`; `MODES` with the new entry at index 1; `WatershedSettings`, colour modes, `defaultWatershed()`, `WATERSHED_PRESETS`; `AppSettings.watershed` |
| `src/gen/terrainMesh.ts` | `buildTerrainNode` takes a `HeightfieldSource` (any generator with seed, sea level, snow line, vertical scale, `sample`, `height`) and a `SurfaceShader`; optional per-sample water levels, flow vectors and packed extra shader fields |
| `src/gen/terrain.ts`, `src/gen/shading.ts` | optional `water` and flow fields on `TerrainSample`; the shader takes only the settings it reads |
| `src/gen/map.ts` | the Watershed map layers |
| `src/workers/protocol.ts`, `src/workers/gen.worker.ts` | job kinds `watershedNode` and `watershedMap`; the generator is reused while the world settings are unchanged |
| `src/modes/TerrainMode.ts` | `TerrainLod` exported and parameterised by job kind and height range; water bounding box from the water heights |
| `src/engine/CameraRig.ts` | an optional `waterAt(x, z)` hook |
| `src/engine/shaders.ts` | a `FLOW` variant of the water material |
| `src/app/App.ts` | `modes.watershed`, presets, map readout, heightmap export, cloud height |
| `src/ui/Panel.ts`, `UI.ts`, `MapOverlay.ts`, `Minimap.ts`, `Help.ts` | folders and presets, spline gating and hint, map layers and jobs per mode, quick help |
| `src/ui/helpDocs.ts`, `src/ui/helpFigures.ts` | the chapter "Watershed worlds: rivers first" with two live figures: a region's basins and relief, and the main river's long profile with the slope–area law |
| `README.md` | mode table, "Watershed worlds" section, presets, layout |

Voxel mode is untouched.

---

## 11. Tests
`tests/watershed.test.ts`, on the default region and every preset:
1. **The network exists:** thousands of land nodes, hundreds of river nodes, Strahler order ≥ 3, at least one lake, highest node between 150 and 1,500 m.
2. **Determinism.** Two generators build identical region arrays; building neighbouring regions first changes nothing; a different seed gives a different world.
3. **G1, drainage.** From every land node, following receivers reaches an outlet within the node count.
4. **G2, descent.** Every node outside a lake is higher than its receiver; lake beds lie below their lake; each sill is higher than its receiver.
5. **G3, rivers.** Water never rises along a segment and strictly falls along river segments above sea level; no lake-interior segment is indexed.
6. **G4, no crossings.** No two diagonal tree edges share a grid cell.
7. **Presets.** Every preset builds a network that keeps G2.
8. **G5, banks.** At both floodplain edges of 400 random river segments, the ground stands at least 0.9·β above the water (fewer than 2 % exceptions, from other rivers' channels).
9. **G6, continuity.** Random lines across the continent, its coast and a region border: after 24 bisections the steepest step vanishes.
10. **G7, LOD.** The water level at river points is the same at Δ = 0 and Δ = 8 m.
11. **Borders.** No land within the sea margin of a region border.
12. **Water above the sea.** Rivers and lakes carry their own water levels.
13. **Speed** is logged: region build and µs per sample.

---

## 12. Milestones

| # | Milestone | Status |
|---|---|---|
| M1 | **Skeleton:** settings, the new `MODES` order, `WatershedMode`, regions, coast, ocean floor | done |
| M2 | **Network:** outlets, growth, area, order, heights, base surface; basin, order and discharge views; the probe | done |
| M3 | **Rivers:** curves, meanders, carving, sloped water, widths; the `waterAt` hook | done |
| M4 | **Polish:** lakes, biome and vegetation tuning, flowing water, the help chapter, presets and the README | done |
| M5 | **Later:** settlements and roads (§14); Voxel mode able to use either surface | open |

---

## 13. Risks and open questions

**Seen while building, and fixed**
- **Cliffs at the edge of a river's reach.** Cutting the valley terms off at a fixed distance left vertical walls wherever the hillside was steeper than the valley wall; they now hand over to the ground smoothly (§5.9).
- **Stray water on far tiles.** Channels narrower than the tile's vertex spacing showed up as broken dashes of water; far tiles now widen big rivers and leave unresolved channels uncut (§5.9 step 5).
- **Too regular meanders, too much snow and desert.** Meanders now wander (§5.7); the climate defaults were warmed and the humidity rebalanced.

**Remaining**
- **Evenly spaced continents.** Warp, jitter, land chance and size variation hide the lattice reasonably well. If they don't for some seeds, let continents span regions, with river and road gates on region edges (R§4.3 C).
- **Perched rivers.** The tree can put a river next to a lower node in another basin. The levee keeps the water in, but a big drop right beside a river looks odd. If it shows up often, add a coarse divide guard like the lake rim guard.
- **Uniform hills.** A single slope law can make ridges look alike. Uplift variation and detail noise help; escarpments, plateaus and mesas are out of scope.
- **Main-thread hitch** of 0.2–0.3 s the first time the camera enters a region (§7). Building regions in a worker and sending them over would hide it.

**Open questions**
1. Should continents be allowed to span regions later (river gates on region edges)?
2. Should Voxel mode be able to take its surface from Watershed mode (M5)?

---

## 14. Later: settlements and roads
Building rivers first is worth it because the network is data. With it, R§7–8.5 becomes a job each region can do on its own:
- **Candidate sites** come straight from the graph, scored the way Azgaar's FMG and mewo2 score them (R§7.1):
  - river mouths with a sheltered harbour: ports;
  - confluences of rivers of order 2 or more: market towns;
  - points where a river's slope jumps from steep to gentle, or where its order drops below the navigable limit: fall-line and portage towns (Bleakley & Lin 2012, R§7.3);
  - wide, shallow, gentle reaches: fords and bridge points.
- **Fresh water is a filter, not a score.** Any stream will do for a village. Over half of all people live within 3 km of fresh water (Kummu et al. 2011, R§7.3).
- **Greedy placement** with a minimum spacing, and road classes set by settlement size (Galin et al. 2011, R§6.2).
- **Roads** are A* paths on the region grid, costed with Tobler's travel time plus a river-crossing cost, with bridges at fords (R§6.1). Candidate links come from a Gabriel or Urquhart graph (R§6.2).
- **Self-contained road networks.** Each continent is self-contained, so its road network is too. Sea routes between continents come later.

---

## References
- [RIVERS-AND-ROADS.md](RIVERS-AND-ROADS.md): the research behind this design, cited as R§n.
- Génevaux, J.-D., Galin, É., Guérin, É., Peytavie, A. & Beneš, B. (2013). Terrain generation using procedural models based on hydrology. *ACM Transactions on Graphics* 32(4): 143. https://doi.org/10.1145/2461912.2461996
- Derzapf, E., Ganster, B., Guthe, M. & Klein, R. (2011). River networks for instant procedural planets. *Computer Graphics Forum* 30(7): 2031–2040. https://doi.org/10.1111/j.1467-8659.2011.02052.x
- Fischer, R., Boeckers, J. & Zachmann, G. (2022). Procedural generation of landscapes with water bodies using artificial drainage basins. *CGI 2022*, LNCS: 345–356. https://doi.org/10.1007/978-3-031-23473-6_27
- Cordonnier, G., Braun, J., Cani, M.-P., Beneš, B., Galin, É., Peytavie, A. & Guérin, É. (2016). Large scale terrain generation from tectonic uplift and fluvial erosion. *Computer Graphics Forum* 35(2): 165–175. https://doi.org/10.1111/cgf.12820
- Hack, J. T. (1957). Studies of longitudinal stream profiles in Virginia and Maryland. USGS Professional Paper 294-B: 45–97. https://doi.org/10.3133/pp294B
- Leopold, L. B. & Maddock, T., Jr. (1953). The hydraulic geometry of stream channels and some physiographic implications. USGS Professional Paper 252. https://doi.org/10.3133/pp252
- Leopold, L. B. & Wolman, M. G. (1960). River meanders. *GSA Bulletin* 71(6): 769–793. https://doi.org/10.1130/0016-7606(1960)71[769:RM]2.0.CO;2
- Galin, É., Peytavie, A., Guérin, É. & Beneš, B. (2011). Authoring hierarchical road networks. *Computer Graphics Forum* 30(7): 2021–2030. https://doi.org/10.1111/j.1467-8659.2011.02055.x
- Kummu, M., de Moel, H., Ward, P. J. & Varis, O. (2011). How close do we live to water? A global analysis of population distance to freshwater bodies. *PLoS ONE* 6(6): e20578. https://doi.org/10.1371/journal.pone.0020578
- Bleakley, H. & Lin, J. (2012). Portage and path dependence. *Quarterly Journal of Economics* 127(2): 587–644. https://doi.org/10.1093/qje/qjs011
- TerraForged 0.3.x and 1.16, and TerraFirmaCraft 1.21.x: source code at the commits pinned in R§9.
