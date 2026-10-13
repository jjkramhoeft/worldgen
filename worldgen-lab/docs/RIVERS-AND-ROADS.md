# Rivers, roads and settlements: research cheat sheet

How procedural generators make rivers, roads and settlements, and what fits worldgen-lab's infinite, tiled world. Compiled 2026-10-13 for worldgen-lab (TypeScript + three.js).

**Tags:** **[V]** = checked against a primary source: the paper itself, the author's own code or write-up, official patch notes, or vanilla data and decompiled code. **[W]** = only wiki or secondary prose was available. **[U]** = unverified, inferred, or a design suggestion.

Code is cited as `file:lines` at the pinned commits listed in §9. worldgen-lab code is cited at `main` 5ec3524. The Minecraft 1.18 river numbers (the |W| < 0.05 valley slice and the S_off spline) are in RESEARCH.md §1.3–1.5 and are not repeated here.

---

## 1. TL;DR

- **A real river needs three things**: a downhill direction, accumulation (tributaries join and the river grows) and an outlet (sea or lake). Noise gives none of them. Every method that gives all three needs non-local information: the whole upstream basin and the way to the outlet [U, a synthesis of §3–4].
- **Exact hydrology on a grid is simple and fast**: fill depressions with Priority-Flood, give each cell one receiver, accumulate in flood order, threshold [V: Barnes et al. 2014; Tarboton 1997]. It only needs a finite domain with an outlet.
- **Infinite-world games bound the problem.** Each macro cell (about 12 km) drains to its own coast and is computed once and cached (TerraForged, TerraFirmaCraft) [V code]. A 2026 preprint makes the pattern exact: rivers stay inside their plate and their heights are forced downhill (Davis 2026) [V]. Planet methods compute a coarse network once and refine it locally (Derzapf et al. 2011) [V].
- **The most realistic networks** come from uplift plus stream-power erosion. It is global and iterative, but each step is cheap [V: Cordonnier et al. 2016; Schott et al. 2023].
- **Roads** are least-cost paths with a slope cost over a sparse proximity graph between settlements (Gabriel, RNG, Urquhart), reusing existing roads and classed by settlement size [V: Galin et al. 2011; FMG code].
- **Settlements** are placed by scoring cells for fresh water (river flux, confluences), harbour, flatness and fertility, then picking greedily with a minimum spacing [V: mewo2 and FMG code]. Real data agree: over half of all people live within 3 km of fresh water (Kummu et al. 2011), and cities founded at river transport breaks persist (Bleakley & Lin 2012) [V].
- **Recommendation** [U]:
  - Terrain: region-local rivers in the style of Davis 2026: coarse hydrology (Priority-Flood + receivers + accumulation) on the generator's own smoothed height, kept inside each region, cached per worker, with sloped water ribbons.
  - Planet: one coarse flow-routing pass per planet, refined locally.
  - Erosion: add Priority-Flood lakes, deterministic flow accumulation and a stream-power mode.
  - Settlements and roads: prototype in Erosion mode (finite), then port to Terrain regions.

| Family | Idea | Downhill / merges / reaches sea / lakes | Local or global | Cost | Terrain (∞) | Planet | Erosion | Key sources |
|---|---|---|---|---|---|---|---|---|
| **Noise level sets** | river = band around a noise zero set or a cell border | no / no / no / no | local, per sample | O(1) per sample | today's method | possible | — | RESEARCH.md §1; cubiomes; Mojang 2021 |
| **Grid flow routing** | fill depressions, one receiver per cell, accumulate, threshold | yes / yes / yes / yes (fill depth) | global per basin | O(n log n) | per bounded region | yes, coarse mesh | yes | O'Callaghan & Mark 1984; Tarboton 1997; Barnes 2014 |
| **Mesh map generators** | the same on 10⁴–10⁵ Voronoi/Delaunay cells, plus wind rainfall and widths | yes / yes / yes / yes (FMG) | global, small map | ms to s | per region | yes | — | mapgen2, mapgen4, mewo2, FMG |
| **River-first** | build the drainage network first (grown inland from the coast, or traced downhill on a coarse grid), then fit the terrain to it | yes / yes / yes / optional | network per region; terrain local | low | per region | yes (Derzapf) | — | Kelley 1988; Génevaux 2013; Derzapf 2011; TerraForged; TerraFirmaCraft; Davis 2026 |
| **Uplift + stream power** | iterate dh/dt = u − k·A^m·s^n on a stream graph | yes / yes / yes / yes (lake graph) | global, iterative | O(n) × 100s of steps | no | offline, coarse | yes | Braun & Willett 2013; Cordonnier 2016; Schott 2023; Tzathas 2024 |
| **Hydraulic erosion sim** | droplets or shallow-water pipes move water and sediment | mostly / yes / not guaranteed / partly | global, iterative | 10⁵–10⁶ droplets | no | no | today's method | Musgrave 1989; Mei 2007; Šťava 2008; Beyer 2015 |

The idea and realism columns summarise §3 [V]. Costs and the three fit columns are judgements [U].

---

## 2. What worldgen-lab does today

### 2.1 Terrain and Voxel
- **Rivers are a band around the zero set of weirdness W** (`terrain.ts:187–195`) [V]:
  `r = (1 − smoothstep(w, w + b, |W|)) · smoothstep(−0.26, −0.12, C)`, then `h ← h + (h_bed − h)·r` with `h_bed = seaLevel − depth`. Defaults: w 0.03, b 0.09, depth 5 m, sea level 0 (`settings.ts:264, 323`).
- **Water is one plane at sea level.** A terrain tile gets a water grid at `y = sea` wherever it dips below it (`terrainMesh.ts:161–180`). Voxel columns fill with water up to sea level (`voxelGen.ts:321–322`) and take their surface height from the same generator (`voxelGen.ts:123–124`) [V].
- **Consequences:**
  - Rivers are sea-level canals; under high ground the carve becomes a gorge down to −5 m [U]. Minecraft has the same limit. Mojang wrote that it has no support for rivers above sea level, and during 1.18 development made dry gorges rarer by having rivers cut fjords or saddle valleys instead (Mojang 2021, experimental snapshots 3–4) [V].
  - The zero set of a generic smooth 2D function is a union of disjoint curves, either closed or unbounded. So these rivers never fork or join and have no source or mouth. Their width is about 2w/|∇W|, so it follows the noise gradient, not the amount of water [U].
  - The continentalness fade dissolves rivers near the coast instead of ending them in a mouth (`terrain.ts:191`) [V].
  - The help text already says so: rivers are level sets, not flow (`helpDocs.ts:237`) [V].
- **River biome**: river or frozen river where r > 0.5 under water, or r > 0.6 within 2 m above sea level (`biomes.ts:233–237`) [V].

### 2.2 Planet
- **No rivers.** Elevation = warped continents + ridged mountains + uber detail + craters + terraces (`planetGen.ts:87–127`); ocean where e < 0 (`planetGen.ts:163–166`) [V].
- Each cube-face quadtree node evaluates the generator per vertex on the unit sphere (`planetMesh.ts:3–5, 80–89`) [V].

### 2.3 Erosion
- **A finite window of the Terrain generator** (`erosion.ts:54–91`), by default 256² cells over 2048 m with an island mask (`settings.ts:442–466`), eroded by Beyer/Lague droplets and thermal erosion. See RESEARCH.md §3.7–3.8 [V].
- **The flow view is a visit counter.** Each droplet step adds its water to its cell (`erosion.ts:164`), shown on a log scale relative to the mean (`erosion.ts:252–254, 288–296`) [V]. This is a Monte Carlo estimate of flow accumulation and the only real downhill flow in the app [U].
- **No depressions or lakes.** A droplet that climbs drops sediment into the pit behind it (`erosion.ts:169–175`) [V], so pits fill up instead of holding water [U].

### 2.4 Settlements and roads
- **None** [V: grep of `src/`]. The closest pattern is vegetation: one hashed, jittered candidate per 6 m cell, then filters on biome, height and slope (`terrainMesh.ts:248–300`) [V]. Minecraft places structures the same way at chunk scale (RESEARCH.md §1.10) [V]. "Hash a cell, then filter" is the local template for settlement candidates [U].

### 2.5 Architecture facts that shape the options
- Workers build terrain nodes, voxel chunks and planet nodes as independent jobs (`gen.worker.ts:38–57`). Each worker keeps one generator per settings version and drops it when settings change (`gen.worker.ts:12–35, 61–68`) [V]. A per-worker region cache would fit the same lifecycle [U].
- `TerrainGenerator.evaluate` already fades octaves finer than the caller's grid spacing (`terrain.ts:115–133`) [V]. A coarse hydrology grid can therefore sample a smooth, alias-free version of the same terrain [U].

---

## 3. River techniques

### 3.1 Noise and biome rivers (local, not flow)
- **Minecraft 1.18+.** The water is the global sea-level fluid. `noise_settings/overworld.json` sets `sea_level` 63 and `default_fluid` water, and near the surface the aquifer returns that global fluid, so valleys carved below y 63 fill to sea level (mcmeta 1.18-data; decompiled `Aquifer`, `NoiseBasedChunkGenerator`) [V].
  - Mojang, experimental snapshot 3: "We don't have support for actual rivers generating above sea level" ([Mojang 2021](https://www.minecraft.net/en-us/article/new-world-generation-java-available-testing)) [V].
  - Snapshots 4–5 made rivers cut fjords or raise saddle valleys instead of leaving dry gorges, and tuned depth and banks [V].
  - Aquifers and springs do put some water above sea level, but not rivers [V].
- **Minecraft ≤ 1.17 (GenLayer stack)** [V: cubiomes `layers.c`, `generator.c`; MCP 9.40 decompile]:
  1. River init branches off the 1:256 land/ocean layer. Land cells get a random int in [2, 300001]; ocean gets 0.
  2. Six zooms (2 + riverSize 4) bring it to 1:4. Each zoom copies random neighbours, which roughens cell borders.
  3. Each value is reduced to its parity (`v < 2 ? v : 2 + v mod 2`). A cell becomes river if any of its 4 neighbours differs.
  4. Smooth, then mix: ocean biomes keep their biome, snowy tundra → frozen river, mushroom fields → mushroom shore, anything else → river. A Voronoi zoom brings it to 1:1.
  - So rivers are the borders between randomly two-coloured, roughened cells, about 2 cells (≈ 8 blocks) wide at 1:4 [U, worked out from the code]. The river biome's base height of −0.5 puts the bed below sea level, so the water is flat sea-level water [V code; U conclusion].
- **No Man's Sky has no rivers.** No official update page or patch note up to Cosmos 7.06 (October 2026) mentions them ([release log](https://www.nomanssky.com/release-log/)) [V]. Worlds Part I (5.0, 2024) added floating islands with waterfalls and new water for seas and lakes; Worlds Part II (5.5, 2025) added deeper oceans and lakes on moons [V].
- **Verdict** [U]: fine for biome-scale variety and small streams. It cannot give sources, confluences, width growth or sloped water.

### 3.2 Flow routing on a grid
Four steps: condition, direct, accumulate, extract ([Tarboton 1997](https://doi.org/10.1029/96WR03137); [Barnes 2017](https://doi.org/10.1016/j.envsoft.2017.02.022)) [V].
- **Condition** the heightmap so every cell drains (§3.3).
- **Flow direction:**
  - **D8**: all flow goes to the steepest of the 8 neighbours. Channels only join, and directions come in 45° steps (O'Callaghan & Mark 1984, as described by Tarboton 1997; the original is paywalled and was not read) [V via Tarboton].
  - **MFD**: flow is split among all lower neighbours in proportion to slope (Quinn et al. 1991) or to slope^p (Freeman 1991). This spreads flow out (dispersion) [V via Tarboton]. RichDEM's docs give Freeman's p ≈ 1.1 [W].
  - **D∞**: one flow angle, the steepest descent over the 8 triangular facets around the cell. Flow is split between the two neighbours that bracket that angle (Tarboton 1997) [V].
  - Rivers as trees need convergent routing (D8, or one receiver per node). Barnes' tiled accumulation supports only non-divergent routing, because one-to-many flow defeats divide and conquer (Barnes 2017) [V]. Schott et al. use MFD for drainage area but erode along the steepest receiver (`spe_shader.glsl:110–194`) [V].
- **Accumulate**: A(p) = a(p) + Σ A(upstream neighbours), visiting cells upstream-first [V]:
  - by descending height (mewo2 `getFlux`, `terrain.js:334–352`);
  - in reverse Priority-Flood order (mapgen4 `map.ts:363–385`);
  - or along a receiver stack built from the outlets (Braun & Willett 2013, per Cordonnier et al. 2016 §5).
  - It is O(n) once the order is known.
- **Extract**: a channel exists where A exceeds a critical support area (O'Callaghan & Mark 1984, per Tarboton 1997) [V]. The threshold sets the drainage density [U].
- **Pitfalls** [U]: D8 on planar slopes makes straight parallel rivers, so keep some noise in the routing surface. Flats need explicit directions (Barnes, Lehman & Mulla 2014b) [V title only]. Grid resolution sets the smallest river.

### 3.3 Depressions and lakes
- **Planchon & Darboux (2002)**: cover the surface with a thick layer of water, then remove the excess until nothing changes. Depressions become flat (for storage capacity) or slightly sloping (for drainage extraction). Practical run time grows like N^1.2, theoretical N^1.5, against N² for older methods ([Planchon & Darboux 2002](https://doi.org/10.1016/S0341-8162(01)00164-3)) [V].
  - mewo2's `fillSinks` implements it with ε = 10⁻⁵ (`terrain.js:301–332`), and his write-up names it [V].
- **Priority-Flood** ([Barnes, Lehman & Mulla 2014](https://doi.org/10.1016/j.cageo.2013.04.024)) [V]:
  1. Push every edge cell (every outlet) into a min-heap keyed by height.
  2. Pop the lowest cell c. For each unvisited neighbour n: set h(n) = max(h(n), h(c)), mark it, push it.
  - O(n) for integer heights, O(n log n) for floats. About 20 lines of pseudocode. Works on 4-, 6- and 8-connected grids and on irregular meshes. Variants label watersheds and assign flow directions, with tiny ε increments or by carving.
  - Lake depth = filled height − original height; the lake surface is the fill level [U, standard].
  - mapgen4's `assignDownslope` is the same flood without filling. It seeds the heap with ocean triangles, and each popped triangle becomes the downslope of its unvisited neighbours (`map.ts:309–346`). Trunks higher than their tributaries are then lowered, which carves the channel (`map.ts:380–381`) [V code; the "Priority-Flood" label is U].
- **Basin graph + minimum spanning tree** ([Cordonnier, Bovy & Braun 2019](https://doi.org/10.5194/esurf-7-549-2019)) [V]: give each node its steepest receiver and label the basins. Link adjacent basins by their lowest pass and take an MST rooted outside the domain. Then reroute by carving a trench or by filling. Linear time; used with FastScape.
- **Lakes that depend on water supply** [V, abstracts]: FlowFill (Callaghan & Wickert 2019) and Fill–Spill–Merge (Barnes, Callaghan & Wickert 2021) fill a depression only as far as the runoff allows. Dry basins stay dry; full ones spill and merge. Fill–Spill–Merge runs on a "depression hierarchy" of nested basins (Barnes, Callaghan & Wickert 2020).
  - FMG does a cheap version: lake inflow against evaporation. Open lakes spill the surplus as an outlet river; lakes with no outlet and more evaporation than inflow become salt or dry (`lakes.ts:47–82`, `features-generator.ts:474–486`) [V].
- **Pitfall** [U]: every method needs an outlet, either the domain edge or the sea. An infinite plane has neither (§4).

### 3.4 Tiled hydrology at scale (Barnes)
- **Parallel Priority-Flood** ([Barnes 2016](https://doi.org/10.1016/j.cageo.2016.07.001)) [V]:
  1. Fill and watershed-label each tile on its own, with the tile edge as the outlet.
  2. Send only the perimeter heights, perimeter labels and a "spillover graph" (the lowest pass between each pair of labels) to a producer.
  3. The producer solves this small global graph and sends back a fill level per label. Each tile patches itself.
  - A fixed number of disk reads and messages per tile. 2·10¹² cells took 4.8 h on 48 cores.
- **Parallel flow accumulation** ([Barnes 2017](https://doi.org/10.1016/j.envsoft.2017.02.022)) [V]: each tile accumulates locally and records which perimeter cells feed which. The producer computes each tile's inflow offsets, and tiles add them along the flow paths. D8-style routing only. 2·10¹² cells took 24 min on 48 cores.
- **GPU flow routing: FastFlow** ([Jain et al. 2024](https://doi.org/10.1111/cgf.15243)) [V abstract]: discharge in O(log n) parallel iterations and depression routing in O(log² n); 5× and 34–52× faster than previous work at 1024².
- **Meaning here** [U]: exact, but it needs a finite domain with a known boundary and two passes over every tile. It fits a bounded region split into worker tiles, not on-demand streaming.

### 3.5 River-first terrain
- **Kelley, Malin & Nielson (1988)**: build a stream network from empirical geomorphology rules (Shreve-ordered links, tributaries added at several scales), then fit a "surface under tension" through it by triangulation and interpolation ([Kelley et al. 1988](https://doi.org/10.1145/54852.378519)) [V].
- **Prusinkiewicz & Hammel (1993)** ([PDF](http://algorithmicbotany.org/papers/mountains.gi93.pdf)) [V]:
  - The river (Mandelbrot's squig curve) and the mountain (midpoint displacement) come from one context-sensitive triangle subdivision.
  - At each level, for every edge the river crosses, one of the edge's two halves becomes the new crossing. The half is chosen by hashing the edge's endpoint coordinates, so neighbouring triangles agree and each triangle can be refined on its own.
  - Midpoints of crossed edges get the lowest possible altitude (the sum of the negative displacement limits so far), so the river never runs uphill and lies below its surroundings.
  - Open problems they list: the river runs at a constant altitude, valleys come out asymmetric, and there are no tributaries.
- **Mogensen & Isenbecker (2025)** ([arXiv:2504.08383](https://arxiv.org/abs/2504.08383); the PDF is marked as unpublished work from 2022) [V]: rivers and fjords are carried as edge attributes through recursive triangle subdivision, so any area can be zoomed without generating a full high-resolution map. They note that rivers don't always take the steepest route. About 1.4–1.5 s per 1023² map.
- **Belhadj & Audibert (2005)**: compute ridge lines and a river network, write them into the DEM, then fill in by an inverse and then a forward midpoint displacement ([Belhadj & Audibert 2005](https://doi.org/10.1145/1101389.1101479)) [V abstract].
- **Teoh, RiverLand** (ISVC 2009, not 2008): the river network first, then the terrain [W: as described by Génevaux et al. 2013 and Fischer et al. 2022; the paper is paywalled and was not read].
- **Génevaux et al. (2013)** ([paper](https://doi.org/10.1145/2461912.2461996)) [V]:
  - **Input**: the land contour, river mouths, optional sketched rivers, a river-slope map and a terrain-slope map.
  - **Growth** from the mouths by a grammar: continue (P_c), symmetric junction (P_s) or asymmetric junction (P_a), with Horton–Strahler numbers as priorities. Among candidates within [z, z + ζ] of the lowest one, the highest priority grows next. Small ζ gives many branched basins; large ζ gives one big basin.
  - **Constraints**: stay at least 1500 m from the contour and from other rivers (more for higher Strahler numbers). Elevation rises upstream following the river-slope map. A Lipschitz bound κ caps slopes.
  - **Watersheds** are the Voronoi cells of river nodes. Mean flow φ = 0.42·A^0.69 (Dunne & Leopold 1978; the printed units are off, see §5.2). Crest height = the highest of the 3 surrounding river nodes + λ·d, with λ ∈ [0, 0.25] from the terrain-slope map.
  - **Geometry**: rivers are classified by Rosgen type (A+ … G) for their course and cross-section. The terrain is a construction tree of compact primitives (blend, carve), so any sub-area can be evaluated on its own. The network for about 3000 km² takes 4–5 s; the whole pipeline 10–13 s.
  - **Limits**: branches only grow upstream, so no deltas or oxbows; greedy growth can give wandering crests.
- **Derzapf et al. (2011), planets** ([paper](https://doi.org/10.1111/j.1467-8659.2011.02052.x)) [V]:
  - **Base mesh**: an octahedron refined to a sphere, about 5000 faces in 0.27 s. Continents grow face by face to a target land fraction.
  - **Rivers**: start at mouths (land vertices next to the coast). Repeatedly turn an edge from a river vertex to an unconnected land vertex into a river edge, in pseudo-random order, until every land vertex is connected: a random spanning forest. Ground and water altitudes are assigned from the mouth upward along each river; "mountain" vertices between rivers are placed higher.
  - **Refinement** on the GPU by edge splits. Edges are typed (sea, coast, continent, river); splitting a river edge gives 2 river and 2 continent edges. New altitudes are drawn within bounds such as a minimum river slope of 1 m/km and a maximum ground slope of 1000 m/km.
  - **Determinism**: each vertex stores a seed (a new vertex gets the sum of its edge's two seeds) and each edge a split level, so any refinement order yields the same planet.
- **Fischer, Boeckers & Zachmann (2022)**: drainage basins as a random spanning forest grown over a grid from coastal outlets. Rivers follow it from their sources, lakes are grown, and the terrain is then grown outward from the water. Large maps in under 30 s ([Fischer et al. 2022](https://doi.org/10.1007/978-3-031-23473-6_27)) [V].
- **Dwarf Fortress** (a finite world; Tarn Adams interviewed in [Harris 2008](https://www.gamedeveloper.com/design/interview-the-making-of-dwarf-fortress) and Harris 2019) [V]: temporary rivers start at mountain edges, step to the lowest neighbour and dig when stuck. Real rivers follow; those that fail get forced paths to the ocean, and lakes are grown. Rivers are then loop-erased, brooks branch off, and flow and tributaries are computed. The 0.47.04 presets set `EROSION_CYCLE_COUNT` 250 and `RIVER_MINS` from 400:400 on a 257² world down to 6:6 on 33² (`world_gen.txt`); what the parameters mean comes from the DF wiki [W].
- **Infinite-world games use macro cells** [V code]:
  - **TerraForged 1.16** (by dags): continents are Voronoi cells, about 12,000 blocks across at the default scale. Per continent, computed lazily and cached: 13 main rivers run as spokes from the centre to 250 blocks past the coast, with forks 30–80 % along, plus lakes and wetlands. Meanders come from a 3-octave domain warp. Valley, banks and bed are carved by distance to the segments. Water stays at sea level.
  - **TerraForged 0.3.x**: jittered coarse cells; each land cell drains to its lowest 4-neighbour, and river halves run along the cell edges. A sample scans the 3×3 cells around its nearest cell, and each cell's river pieces are built from its neighbours and cached (`RiverGenerator.java`), so lookups stay within about ±3 cells. The water sits at the river's own level, above sea level.
  - **TerraFirmaCraft 1.21**: regions of about 12,288 blocks, each generated once and cached. Rivers grow inland from every shore point as trees, with no crossings and every step moving away from the ocean. Width grows downstream from 8 to 24. About 1/3 of sources get a lake. Midpoint displacement adds block-scale wiggle, and the river water has a flow direction.
- **Plate-local rivers: Davis (2026)**, an arXiv preprint, not peer reviewed ([arXiv:2610.00301](https://arxiv.org/abs/2610.00301)) [V]:
  - Tectonic-plate seeds define both the terrain and bounded, Voronoi-like plate domains. Each plate is processed on its own, lazily, and cached.
  - Per plate: sample the terrain on a 100×100 grid. Visit source candidates (high samples outside the border band) in descending height and trace each downhill within a (2k+1)² window, requiring a minimum drop and no crossing. A trace ends at the sea, at a confluence or in a lake at a local minimum. A path that would enter the border band is discarded, so rivers never drain into a plate border.
  - River heights are remapped affinely along each path so every segment strictly descends, and Strahler orders are stored per segment. Final terrain blends to the river height by distance, which guarantees downhill flow along every channel.
  - Plate caches took 2.3–10.1 ms each, and river queries added about 0.85 µs per sample (C++, Apple M4 Max). Code: github.com/Davismk3/plate-local-river-generation.

### 3.6 Uplift + stream power
- **The stream power law**: dh/dt = u − k·A^m·s^n, with uplift u, drainage area A and slope s. m/n ≈ 0.5; usually n = 1 and m = 0.5 ([Cordonnier et al. 2016](https://doi.org/10.1111/cgf.12820) §3.1) [V].
- **Braun & Willett (2013)**: an implicit O(n) solver. Order nodes from base level upstream along receivers and solve each node after its receiver. For n = 1 (Cordonnier et al. 2016, Eq. 2), with j the receiver and ℓ_ij the horizontal distance:
  `h_i ← (h_i + δt·(u_i + k·A_i^m·h_j / ℓ_ij)) / (1 + k·A_i^m·δt / ℓ_ij)` [V via Cordonnier 2016; the original is paywalled].
- **Cordonnier et al. (2016)** [V]:
  - The stream graph is Poisson-disk points plus a constrained Delaunay triangulation. Boundary nodes are river mouths at sea level.
  - Each iteration: receivers (the lowest neighbour) form trees. Lakes are linked through a graph of passes, processed in increasing pass height: O(N + M log M) for M lakes, against O(N√N) in Braun & Willett. Drainage area comes from a reverse BFS, then the implicit update runs. Slopes are capped at 30° as a thermal correction.
  - Settings: 50×50 km, u = 5·10⁻⁴ m/y, k = 5.61·10⁻⁷ y⁻¹, δt = 2.5·10⁵ y. 100–300 iterations, under 2 minutes. Detail comes from landform primitives.
  - At steady state s ∝ A^(−m/n) (their §6.4) [V]. So once the river tree is known, elevation can be integrated upstream from the mouth [U].
- **Schott et al. (2023)**: the user paints uplift, not heights, and erosion runs interactively on the GPU ([Schott et al. 2023](https://doi.org/10.1145/3592787)) [V abstract]. The release code, `spe_shader.glsl` [V]:
  - Each step, a cell's drainage area = its own area + Σ (neighbour's previous area × the neighbour's slope share toward it) (MFD, exponent 1). Area spreads one cell per step and settles over many steps [U].
  - Erosion follows the steepest receiver: `h ← max(h − dt·(k·A^0.8·s² − k_h·∇²h), h_receiver) + dt·u`. Defaults: k 5·10⁻⁴, k_h 200, dt 50. Border cells are fixed at 0.
- **Tzathas et al. (2024)**: analytical solutions of the stream power law, so time becomes a slider instead of a loop count. It still needs a fixed point between river network and elevation, sped up with a multigrid scheme ([Tzathas et al. 2024](https://doi.org/10.1111/cgf.15033)) [V].
- **Schott et al. (2024)**: amplifies low-resolution terrain into hydrologically consistent high-resolution terrain with fast approximations of thermal erosion, stream-power erosion and deposition at several scales ([Schott et al. 2024](https://doi.org/10.1145/3658200)) [V abstract].
- **Fit** [U]: the best dendritic networks, but global and iterative, and it needs a base level (sea or border). Good as a second Erosion-mode simulator and as an offline coarse pass for planets.

### 3.7 Hydraulic erosion simulation
- **Musgrave, Kolb & Mace (1989)**: noise synthesis plus a simple hydraulic and thermal erosion model that forms global stream and valley networks and talus slopes ([Musgrave et al. 1989](https://doi.org/10.1145/74333.74337)) [V abstract].
- **Mei, Decaudin & Hu (2007)**: shallow water by virtual pipes on the GPU ([Mei et al. 2007](https://doi.org/10.1109/PG.2007.15)) [V]. Loop: rain → pipe outflow and velocity → erode or deposit against capacity C = K_c·sin α·|v| → semi-Lagrangian sediment transport → evaporation. The time step is CFL-limited (Δt·u ≤ l_x), and no water leaves the grid.
- **Šťava et al. (2008)**: layered materials, force-based plus dissolution erosion, and bank slippage; at least 20 fps on 2048×1024 with 4 layers. Large terrains are split into tiles that copy border values before every step ([Šťava et al. 2008](https://doi.org/10.2312/SCA/SCA08/201-210)) [V].
- **Droplets (Beyer 2015)**: what the Erosion mode runs; see RESEARCH.md §3.7.
- **Fit** [U]: rivers emerge, but only after many iterations. Pits trap water unless depressions are handled. The domain must be finite, or tiles must swap halos every step.

### 3.8 Mesh map generators with readable code [V code]
- **mapgen2** ([Patel 2010](http://www-cs-students.stanford.edu/~amitp/game-programming/polygon-map-generation/); JS port at f16f485):
  - Elevation = distance from the coast (a BFS over Voronoi corners that keeps lakes flat), redistributed. Downslope = the BFS parent (`elevation.js:41–87`).
  - Rivers: 30 random springs at elevation 0.3–0.9 each add +1 flow along the downslope path to the coast. They are drawn along Voronoi edges with width 2√flow (`rivers.js`; `colormap.js:65–70`).
  - Moisture falls with distance from rivers and lakes, then is rank-redistributed (`moisture.js:38–101`).
- **mapgen4** ([Patel](https://www.redblobgames.com/maps/mapgen4/); c1d8cb0):
  - Rainfall: sort regions along the wind direction. Humidity = the mean of upwind neighbours; rain = raininess·humidity. If humidity > 1 − elevation, extra orographic rain = rain_shadow·(humidity − (1 − e)) falls and leaves the air (`map.ts:242–290`).
  - Drainage: the flood from ocean triangles described in §3.3. Flow = 0.2·moisture² per land triangle, accumulated from leaves to root (`map.ts:363–385`).
  - Drawing: rivers appear where flow ≥ e^2.7, with width = √(flow − min)·spacing·e^−2.4 (`geometry.ts:96–145`).
  - Patel tried a rivers-first method (Génevaux 2013) and dropped it because he couldn't make it fast enough (mapgen4 elevation post, 2018).
- **mewo2/terrain** ([O'Leary 2016](http://mewo2.com/notes/terrain/), now offline, read via the Wayback Machine; a2511d6):
  - After `fillSinks` (§3.3), `getFlux` passes uniform rain to the lowest neighbour in descending height order (`terrain.js:334–352`).
  - Erosion rate = min(1000·√flux·slope + slope², 200), normalised and applied with re-filling between passes (`370–402`).
  - Rivers are drawn where flux > limit × land fraction, then smoothed (`524–546`).
- **Azgaar's Fantasy Map Generator** (52e2f59, now TypeScript):
  - Precipitation: wind passes along grid rows and columns, by latitude band. Humidity rains out over land, more when climbing, and all of it falls before cells above h 85: a hard rain shadow (`precipitation-generator.ts`).
  - Depressions: closed land minima become lakes (`grid-generator.ts:151–214`); others are raised by 0.1 per pass for up to 250 passes (`river-generator.ts:446–505`). Heights first get a small tilt toward the coast (`434–444`).
  - Flux = precipitation accumulated in descending height to the lowest neighbour. A river starts at flux ≥ 30; at a confluence the larger inflow keeps the river's id (`river-generator.ts:201–326`).
  - Width grows with the running maximum flux, and meanders come from inserted offset points (`river-generator.ts:539–595`; `pathUtils.ts:421–486`).

---

## 4. Rivers in an infinite, tiled world

### 4.1 The problem
- Flow at a point depends on its whole upstream basin, and depression filling depends on where the basin spills, which can be far away. Mawhorter names rivers as hard for incremental generation for exactly this reason (Mawhorter 2021, talk slides) [V].
- Under "a pure function of (seed, position)" a tile may only read a bounded neighbourhood, so exact global hydrology is out. Every workable option bounds the dependency [U].

### 4.2 What sources do
| Strategy | Example | Dependency bound | Cost |
|---|---|---|---|
| Macro cells draining to their own coast | TerraForged 1.16 (continent ≈ 12 km); TerraFirmaCraft (region ≈ 12.3 km) | one cell; TerraFirmaCraft also reads river edges from the 3×3 neighbouring regions | once per cell, cached |
| Plate-local tracing with a border margin | Davis 2026 (preprint) | one plate; rivers never enter the plate's border band | 2–10 ms per plate (C++) |
| Coarse stencil drainage | TerraForged 0.3.x | about ±3 coarse cells | per cell, cached |
| Coarse network + local refinement | Derzapf 2011; Génevaux 2013 | coarse network over the whole finite domain; refinement is local | coarse level 0.27 s (Derzapf) to ~5 s (Génevaux) |
| Recursive subdivision with hashed edge decisions | Prusinkiewicz & Hammel 1993; Mogensen & Isenbecker 2025 | the chain of parent triangles | per triangle |
| Exact tiled solve with a small global step | Barnes 2016, 2017 | every tile of a finite DEM, in two passes | linear |
| Parallel routing in few iterations | FastFlow (Jain 2024) | the whole finite grid, O(log n) iterations | GPU |
| Lock-step tiles that swap halos | Šťava 2008 | neighbours, every step | per simulation step |
| Iterative local accumulation | Schott 2023 code | one cell per step; settles after about one path length of steps | per step |
| Fractal coordinates | Mawhorter 2021 | a chain of O(log distance) parent tiles | logarithmic |
| A finite world | Dwarf Fortress, FMG, mapgen4 | the whole map | seconds |

The examples and bounds are [V]; the ±3 bound for TerraForged 0.3.x is worked out from its code.

### 4.3 Design options for worldgen-lab [U]
- **A. Region-local rivers with a border margin (Davis 2026's pattern).**
  - Split the plane into regions, for example Voronoi cells of a jittered grid with spacing R = 16–32 km. A region owns every river inside it, and no river may enter a border band whose width exceeds any warp or carve width.
  - Per region, lazily: sample the generator's smoothed height every 64–128 m (using the octave fading in `evaluate`). Run Priority-Flood from the sea cells inside the region, or trace downhill from sources as Davis does. Accumulate rain (humidity × cell area) in reverse flood order and threshold. Drop rivers that would reach the band, or end them in lakes.
  - Force heights to decrease strictly along every river (Davis's affine remap), so the final carve can never run uphill. Store rivers as polylines with discharge, plus lake levels.
  - Consistent and deterministic by construction, and cacheable per worker, keyed by (settings version, region). The price: no river crosses a region border, so borders far from the sea get river-free bands. Use regions that are large compared with land masses.
  - Cost: Davis reports 2–10 ms per 100² plate in C++. A quick Node 24 sketch of Priority-Flood + receivers + accumulation took about 7 ms for 250² and 28 ms for 500² on one desktop (not app code). Sampling 250² heights costs about as much as building 15 terrain tiles of 65² vertices, so the sampling dominates.
- **B. Region hydrology with a halo.** As A, but each region also samples a halo of width H on every side, uses the window border as an outlet, and keeps only the rivers in its core. Rivers can then cross region borders, and both sides agree whenever the upstream basin fits inside both windows. Larger basins can disagree at borders, so there is no guarantee. Make R + 2H well above the continentalness wavelength.
- **C. Hierarchical gates (consistent by construction).** A coarser level (for example 512 m over 128 km) decides which rivers cross each region edge, where, and with how much water. The region level then routes between these gates, the coast and its own sources. This is Derzapf's typed edges and Prusinkiewicz & Hammel's hashed edge choices applied to an infinite plane. The most work.
- **D. River-first regions (TerraFirmaCraft style).** Per region, grow river trees inland from shore points on the coarse grid, then lower the terrain into valleys around them. Regions without a coast get lakes or no rivers.
- **E. Keep the level sets, fix the look.** Carve and fill only where the uncarved height is within a few metres of sea level; elsewhere carve a dry valley or nothing. This is Mojang's choice, and it costs nothing.

For A–D, the river is then drawn from the network [U]:
- **Fine course**: subdivide coarse segments with hashed midpoint displacement and domain-warped meanders (Prusinkiewicz & Hammel; TerraForged), keyed by segment id so every tile and LOD agrees.
- **Carving**: distance to the nearest segment drives valley, bank and bed profiles (as in TerraForged 1.16 `River.java`).
- **Bed height** falls monotonically from source to mouth and never rises above the uncarved terrain minus the depth.
- **Water**: a ribbon mesh at the river's own level instead of the global sea plane. TerraForged 0.3.x takes the water level from the river's own height, and Derzapf stores a water altitude per vertex [V].
- **Width and depth** from discharge (§5).

### 4.4 Planet (finite)
- **Once per planet, in a worker** [U]: sample elevation on a coarse cube-sphere grid (6 × 64² ≈ 25k nodes). Run Priority-Flood from the ocean nodes, give each node a receiver, accumulate rainfall from the planet's humidity and temperature, and threshold. On planets without oceans, the lowest basins become lakes or salt flats.
- **Per planet node** [U]: store river segments in a spatial hash on the unit sphere and look up the nearest one per vertex to carve and colour. Below the coarse spacing, refine segments by hashed subdivision so detail matches across LOD.
- Derzapf et al. grow the rivers first and derive heights from them [V]. worldgen-lab already has a height function, so routing on it is simpler [U].

---

## 5. River geometry and scaling laws

### 5.1 Ordering and branching
- **Horton (1945)** ([paper](https://doi.org/10.1130/0016-7606(1945)56[275:EDOSAT]2.0.CO;2)) [V]: fingertip tributaries are order 1, a stream that receives only order-1 tributaries is order 2, and so on; the main stream carries the highest order.
  - Stream numbers fall geometrically with order, N_o = r_b^(s−o) (bifurcation ratio r_b, basin order s). Mean lengths grow geometrically, l_o = l₁·r_l^(o−1).
  - r_b ≈ 2 in flat or rolling basins and 3–4 in mountainous or dissected ones; r_l ≈ 2–3, mean 2.32.
  - Horton relabels the main stem with the highest order all the way to its source. That rule is known here only as paraphrased by Shreve (1966) [W].
- **Strahler ordering** [W: stated by Shreve 1966; the scheme dates from Strahler's 1952–54 papers, and Strahler 1957 is a review]: two streams of order ω meet → ω + 1; streams of different order meet → the higher order continues.
  - Typical Strahler bifurcation ratios are 3–5, usually about 4 [W]. Coates (1956, quoted by Strahler 1957) measured 4.0–5.1 from order 1 to 2 and 2.8–4.9 from 2 to 3 [V].
  - On a grid with more than two inflows: if two or more inflows share the highest order, the outflow gets that order + 1, otherwise the highest order [U].
- **Shreve magnitude** ([Shreve 1967](https://doi.org/10.1086/627245)) [V]: exterior links have magnitude 1 and magnitudes add at junctions, so magnitude = the number of upstream sources. For topologically random networks Shreve predicts a Strahler bifurcation ratio of 4, length ratio 2 and area ratio 4 (Shreve 1966, 1967).
  - Magnitude is a cheap, additive stand-in for drainage area when sources are evenly spaced [U]. mapgen2's "+1 flow per spring" is exactly this (§3.8) [V code].

### 5.2 Length, area and discharge
- **Hack's law** ([Hack 1957](https://doi.org/10.3133/pp294B), eq. 3) [V]: L = 1.4·A^0.6, with L in miles (along the channel, up to the divide at the head of the longest stream) and A in square miles. Fitted on more than 100 sites of 0.12–375 sq mi.
  - The coefficient ranges from 1 to 2.5 (about 2.0 on sandstone). The exponent is 0.7 in Arizona and South Dakota; Hack calls the equation regional.
  - An exponent above 0.5 means basins grow longer and narrower as they grow.
  - Metric: L ≈ 1.27·A^0.6 with L in km and A in km² [U, unit conversion].
- **Discharge from area** [V]: in the Potomac basin, mean annual discharge in cubic feet per second roughly equals drainage area in square miles (Hack 1957). That is about 0.011 m³/s per km², or 345 mm of runoff a year [U, unit conversion].
- **A units trap** [U]: Génevaux et al. (2013) and Peytavie et al. (2019) use φ = 0.42·A^0.69 (Dunne & Leopold 1978) with A printed in m² and φ in m³/s. With those units 1 km² would yield about 5,800 m³/s, so the printed units must be wrong; with A in km² the values are plausible.
- **Use** [U]: a generator's accumulated rain × cell area already is a discharge. Hack's rule calibrates it to real units.

### 5.3 Width, depth and velocity (hydraulic geometry)
- **Leopold & Maddock (1953)** ([USGS PP 252](https://doi.org/10.3133/pp252)) [V]: w = aQ^b, d = cQ^f, v = kQ^m. Because Q = w·d·v, b + f + m = 1 and a·c·k = 1. Valid up to bankfull.
  - **Downstream** (sites compared at the same flow frequency): b ≈ 0.5, f ≈ 0.4, m ≈ 0.1.
  - **At one station** as the flow changes: b ≈ 0.26, f ≈ 0.40, m ≈ 0.34.
  - The coefficients a, c and k vary widely between rivers. Their example at 1000 cfs (28 m³/s) has w = 245 ft, d = 1.7 ft and v = 2.4 ft/s, i.e. 75 m, 0.5 m and 0.7 m/s [V; metric conversion U].
- **In generator code** [V]: mapgen4 width ∝ √(flow − threshold); mapgen2 width 2√flow; Paris et al. (2023) width ∝ A^0.5 and width = 18.8·depth^1.41 (citing Konsoer et al. 2013); TerraFirmaCraft adds a fixed width per downstream edge (8 → 24).
- **Recipe** [U]: w = w₀·(Q/Q₀)^0.5 and d = d₀·(Q/Q₀)^0.4, anchored on one reference river. The square root matches both the downstream data and the generators above.

### 5.4 Meanders, riverscapes and deltas
- **Leopold & Wolman (1960)** ([paper](https://doi.org/10.1130/0016-7606(1960)71[769:RM]2.0.CO;2)) [V]:
  - Meander wavelength λ = 10.9·w^1.01, about 11 channel widths. Amplitude = 2.7·w^1.1. λ = 4.7·r_m^0.98, with r_m the radius of curvature.
  - r_m is mostly 2–3 widths (abstract); river by river the median is 2.7 and the mean 3.1.
  - Natural channels are rarely straight for more than 10 widths.
- **Sine-generated curve** ([Langbein & Leopold 1966](https://doi.org/10.3133/pp422H)) [V]:
  - The channel direction φ, measured from the down-valley direction, varies along the channel as φ(s) = ω·sin(2πs/M), with M the along-channel length of one full meander (two bends). The planform is not a sine curve.
  - Sinuosity k relates to ω by ω ≈ 2.2·√((k − 1)/k) rad: ω = 1 rad gives k ≈ 1.3 and ω = 1.5 rad gives k ≈ 2. M = k·λ. At ω = 2.2 rad (about 125°) the loops touch.
  - Natural rivers average λ/R ≈ 4.7.
  - **Recipe** [U]: walk along a coarse segment and integrate the heading θ(s) = θ_valley + ω·sin(2πs/M + phase). Take λ ≈ 11·w, choose k from slope (higher on flat lowland, near 1 on steep reaches) and hash the phase per segment so every tile agrees.
- **Meander migration: Paris et al. (2023)** ([paper](https://doi.org/10.1145/3618350)) [V]: channel centrelines move along their normals by a curvature-driven migration law. When two non-adjacent points come closer than the channel width, the loop is cut off and becomes an oxbow lake; avulsions happen at random. Interactive: 0.6–36 ms per step. Code: github.com/aparis69/Meandering-rivers.
- **Procedural riverscapes: Peytavie et al. (2019)** ([paper](https://doi.org/10.1111/cgf.13814)) [V]:
  - From a heightfield: fill depressions, compute drainage area and stream power (A^½·S), extract a network graph with Strahler numbers.
  - Rosgen classes choose meandering courses on low slopes and straight ones on steep slopes; long profiles get pools and cascades; cross-sections are templates scaled to area = φ/|u| (asymmetric in bends, braided for type D).
  - Carved with compact primitives; 130–227 s for networks of 4–193 km. The amplification is local, but the network needs flow accumulation over the whole input [U].
- **Deltas** [V]: no simple procedural method was found. Génevaux et al. (2013) list deltas as a limitation, and FMG has no delta code. McDonald & Cordonnier (2026) get braids, meanders and short-lived deltas from a GPU particle-transport erosion model (about 51 ms per iteration at 1024², 1–10 minutes per scene).
- **Pointer** [V]: Argudo et al. (2025) survey terrain descriptors, including Strahler ordering, Horton's and Hack's laws, sinuosity and Rosgen classes, with implementations.

---

## 6. Roads and route networks

### 6.1 One road over terrain: least-cost paths
- **Galin et al. (2010)** ([paper](https://doi.org/10.1111/j.1467-8659.2009.01612.x)) [V]:
  - Find the path that minimises ∫ c(p, ṗ, p̈). A* runs on a grid where each node links to every node in a k-neighbourhood mask (offsets (i, j) with gcd(i, j) = 1). k = 5 is recommended; angle resolution goes from 45° at k = 1 to 11.3° at k = 5.
  - Cost = Σ μ_i(κ_i) over the slope along the direction of travel, curvature, water depth and vegetation density. Each transfer curve μ_i is drawn by the user and becomes infinite above a threshold.
  - Curvature uses (x, y, θ) nodes. Bridges and tunnels are long arcs taken from annulus masks, with their own costs for height above ground, depth and slope.
  - Output: a clothoid spline. The terrain is cut and filled within the asphalt width r and a blend width R, and nearby trees are removed.
  - Under 1 s on a 100×100 grid with curvature, bridges and tunnels.
- **Tobler's hiking function** ([Tobler 1993](https://escholarship.org/uc/item/05r820mz)) [V]: walking speed W = 6·exp(−3.5·|S + 0.05|) km/h on footpaths, where S = dh/dx is the slope as a tangent, not in degrees. It peaks on a slight downhill. Off-path speed is × 0.6. It was fitted to Imhof's data. Edge cost = length / W gives travel time [U].
- **Simpler costs** [V]: A* with cost d·(1 + β·(1 − n·up)), n being the surface normal (Boelter Mizdal & Pozzer 2018); FMG's land cost (§6.2).

### 6.2 Networks between settlements
- **Galin et al. (2011)** ([paper](https://doi.org/10.1111/j.1467-8659.2011.02055.x)) [V]:
  - Settlement size σ: city 2, town 1, village 0. A link's road class is min(σ_i, σ_j): highway, major road or minor road.
  - The network is built top-down, highways first. For each class: compute least-cost paths between all pairs; prune them with a proximity test in the path metric (γ → ∞ gives the relative neighbourhood graph, γ = 2 a Gabriel-like graph; larger γ keeps fewer edges); then merge near-duplicate paths (discrete Fréchet distance) into junctions.
  - Existing roads add a repulsive cost band, so new roads don't run right alongside them. Shared stretches come from merging, not from a cost discount.
  - Routing only each city's 20 nearest neighbours gave the same graph as all pairs. 200×200 km with 90 settlements took 23 s on a 128² grid and 625 s on 512².
- **Proximity graphs** [V]: MST ⊆ RNG ⊆ Gabriel graph ⊆ Delaunay triangulation ([Jaromczyk & Toussaint 1992](https://doi.org/10.1109/5.163414); [Toussaint 1980](https://doi.org/10.1016/0031-3203(80)90066-7) proved MST ⊆ RNG ⊆ DT).
  - Gabriel graph: edge pq if the circle with diameter pq holds no other point.
  - Relative neighbourhood graph (RNG): edge pq if no other point is closer to both p and q than they are to each other.
  - Urquhart graph: the Delaunay triangulation minus the longest edge of each triangle. FMG uses it as its candidate road links (`routes-generator.ts:255–298`) [V code]. Urquhart's 1980 paper was not read [U].
  - Choosing one [U]: the MST is a tree with no loops; RNG and Urquhart are sparse with a few loops; the Gabriel graph is denser; Delaunay links all natural neighbours.
- **Azgaar's FMG routes** [V code]:
  - Built in the order sea routes, roads, trails. Candidate links come from an Urquhart graph: roads join capitals on each landmass, trails join all burgs, sea routes join ports on each water body (`routes-generator.ts:221–500`).
  - Dijkstra over map cells. Land step cost = |ab|² · (1 + max(100 − habitability, 0)/1000) · (1 + max(h − 25, 25)/25) · (0.5 on an existing link) · (3 unless the target cell holds a burg) (`routes-generator.ts:300–314`). There is no river or bridge term.
  - Water step cost = |ab|² × a factor from 1 to 8 that rises with distance from the coast. Navigable rivers are usable only along their own course, and frozen sea is impassable (`316–344`).
  - A new path is cut where it joins an existing link, so shared stretches merge (`350–376`).
- **Villages: Emilien et al. (2012)** ([paper](https://doi.org/10.1007/s00371-012-0699-7)) [V]:
  - The user picks the village area. Buildings are placed by weighted interest functions: sociability, accessibility, slope, distance to water, fortification, and "domination" (height above the surroundings).
  - Each new building gets a Galin-style path to the road network or to the border points where outside roads arrive. Existing roads cost w_ex ≪ 1, and extra links to nearby road nodes create loops.
- **Traffic-driven growth: Beneš, Wilkie & Křivánek (2014)** ([paper](https://doi.org/10.1111/cgf.12283)) [V]: major roads grow where simulated traffic between neighbouring (off-map) cities exceeds road capacity. Each new route is the cheaper of "existing major roads only" and "terrain plus the existing graph". One demand function of time is shared by all city pairs.
- **Trails from walkers: Helbing, Keltsch & Molnár (1997)** ([paper](https://doi.org/10.1038/40353)) [V]: walkers head for their destinations but are pulled toward existing trails. Footsteps strengthen trails and weathering erases unused ones. The result lies between direct paths and a minimal network.
- **A least-cost "neutral" network: Etherington et al. (2024)** ([paper](https://doi.org/10.1007/s10980-024-01836-w)) [V]: sites come from a Halton sequence, ranked by least-cost catchment. Gabriel-graph neighbours are joined by least-cost paths in priority order. Cells on built routes cost 1, so later routes reuse them. Every site is also routed to the map edge.
- **Streets inside cities (brief)** [V]: Parish & Müller (2001) grow highways and streets with an extended L-system that combines global goals (population-seeking highways, grid or radial patterns) with local constraints (water, parks, snapping to intersections). Chen et al. (2008) trace streets along tensor fields blended from grid, radial, boundary and height-field bases.
- **Others** [V]:
  - mapgen2's article puts roads where contour levels change (§14.2).
  - mapgen4's trade-route branch (not in master) runs Dijkstra flow fields with cost × 15 in mountains, × 5 in hills and × 3 at land–water switches; wide rivers are impassable.
  - Dwarf Fortress roads must cross rivers in a single step, with bridges at the crossings (Adams dev log, March 2008).

### 6.3 Roads in a chunked world
- **LayerProcGen** (runevision) [V docs]: generation is split into layers with strict inputs, so results don't depend on chunk order. Locations come from one layer; a coarse height grid from another; paths are found on that grid with a cost that penalises steepness, which produces switchbacks. A path that crosses chunk borders belongs to one chunk ("owned within bounds"), and every terrain chunk it overlaps flattens itself around it.
- **Border points** for incoming roads (Emilien 2012) and routing every site to the map edge (Etherington 2024) apply the same idea: fix where a network crosses a boundary, then route inside it [U].

---

## 7. Settlements, trade and economics

### 7.1 How generators place settlements [V code]
- **mewo2** (`terrain.js:478–499`): score = √flux, −∞ on water and near the map edge, minus a penalty near the edge and 0.02/distance for each existing city. Take the best cell and repeat. Territories grow by Dijkstra with costs for distance, slope, river crossings (100·√flux) and land–water switches (`548–595`).
- **Azgaar's FMG** `rankCells` (`population-generator.ts:20–61`):
  - s = habitability(biome) + 250·norm(flux + confluence flux) − (h − 50)/5 + a coast bonus, then divided by 5.
  - Coast bonuses: estuary +15; ocean +5, plus 20 more for a sheltered harbour (exactly one water neighbour); lakes: fresh +30, salt +10, frozen +1, dry or sinkhole −5, lava −30.
  - Habitability: temperate deciduous forest 100, temperate rainforest 90, tropical rainforest 80, tropical seasonal forest 50, grassland 30, savanna 22, taiga and wetland 12, cold desert 10, hot desert and tundra 4, glacier 0 (`biomes-generator.ts:20–34`).
  - Capitals: the best of s·U(0.5, 1) with a minimum spacing of (W + H)/2/N. Towns follow with a smaller, jittered spacing (`burgs-generator.ts:89–188`). Ports need a harbour; river ports need a navigable river, flux ≥ 100 (`214–311`).
  - Population = s/5, × 1.5 for capitals, × connectivity (0.8 + 0.2 per road, 0.1 per trail, 0.2 per sea route) (`burgs-generator.ts:378–387`; `routes-generator.ts:983–1002`).
  - States grow by cost floods in which rivers are soft borders, with a cost of clamp(flux/10, 20, 100) (`states-generator.ts:328–436`).
  - Markets: centres ranked by population (× 2.5 for a capital, × 1.2 for a port). Trade between markets uses straight-line distance and goods value, not the road graph (`markets-generator.ts:55–98, 436–556`).
- **Dwarf Fortress** (Adams dev logs) [V]: world-gen territories stop at natural boundaries and tend to border at rivers (March 2008). Market towns sit by rivers or oceans near villages (August 2010). Humans no longer found towns away from rivers, brooks or aquifers (December 2011). Whether these rules still hold in v50 was not checked [U].
- **Galin et al. (2011)**: settlement size sets the road class (§6.2) [V].

### 7.2 Classic theory
- **Central places** (Christaller 1933, in Baskin's 1966 translation) [V via full-text search of the translation, without page numbers]:
  - Market areas ("complementary regions") are hexagons.
  - Place types form a hierarchy M, A, K, B, G, P, L. Under the marketing principle each level has three times as many places: 1 L, 2 P, 6 G, 18 B, 54 K, 162 A, 486 M.
  - Spacing grows by about √3 per level, from M regions of 4 km radius to the 186 km L ring [the √3 is U].
  - The range of a good has an upper limit (how far people will travel) and a lower limit (the minimum demand).
  - Three principles: marketing (the main one), traffic (as many places as possible on the routes between important towns) and separation (an administrative grouping of 6–7 units). The labels k = 3, 4, 7 are later notation and do not appear in the translation [W].
- **Gravity model** [V]:
  - Tinbergen (1962, Appendix VI): exports E_ij = a₀·Y_i^a₁·Y_j^a₂·D_ij^a₃, with Y = GNP and D = distance, fitted in logs. On 1958–59 data a₁ and a₂ come out at 0.6–1.0 and a₃ at −0.6 to −0.9. The appendix was written by Tinbergen's team.
  - Zipf (1946): travel between two cities ∝ P₁·P₂ / D, with D the shortest transport (rail) distance.
  - Anderson (1979) gives the theoretical foundation (citation checked, content not read).
- **Use** [U]: weight each link by P_i·P_j / T_ij^γ, with T the travel time on the road graph. Rank links by this weight to choose road classes (an alternative to Galin's min(σ_i, σ_j)), and grow towns at well-connected nodes (like FMG's connectivity factor).

### 7.3 Evidence: why rivers matter [V]
- **Kummu et al. (2011)** ([paper](https://doi.org/10.1371/journal.pone.0020578)): over 50 % of people live within 3 km of surface fresh water, and only 10 % live more than 10 km away; the global median is 3.0 km. Fresh water only, no coasts. People live only slightly closer to water than land in general does (median ratio 0.88), because small rivers are everywhere. The pull is far stronger in arid zones (North Africa: 0.12).
- **Fang & Jawitz (2019)** ([paper](https://doi.org/10.1038/s41467-019-08366-z)), USA 1790–2010, rivers of stream order ≥ 4: people moved closer to major rivers until about 1870, then away, as railways, roads and groundwater pumping took over. In 2010 the human-to-land distance ratio was 0.62 ± 0.24, with a stronger pull in drier regions.
- **Bleakley & Lin (2012)** ([paper](https://doi.org/10.1093/qje/qjs011)): almost every place where a river crosses the fall line (the last rapids before the sea) has a city: Washington, Philadelphia, Richmond and others. Nearness to these old portage sites still predicts higher density today, long after portage stopped mattering. They call this path dependence.
- **Gallup, Sachs & Mellinger (1999)** ([paper](https://doi.org/10.1177/016001799761012334)): across 1° cells, distance to inland rivers predicts population density more strongly than distance to the coast, while GDP concentrates on coasts. The land within 100 km of the coast in the US, Western Europe and temperate East Asia holds 13 % of people and at least 32 % of world GDP on 3 % of inhabited land.
- **Henderson et al. (2018)** ([paper](https://doi.org/10.1093/qje/qjx030)): 24 geographic attributes explain 47 % of the worldwide variation in night lights. Agricultural variables dominate; trade variables (coast, navigable river, harbour) matter more in countries that developed late.
- **Design implications** [U]:
  - Villages need fresh water, but any stream will do. Treat water as a filter, not a strong score.
  - Large towns sit at transport breaks: river mouths with harbours, confluences, fords and bridge points, fall lines, portages and coasts.
  - In dry climates water decides almost everything.
  - Placement persists. Place cities once from geography, then grow them by connectivity.

---

## 8. Options for worldgen-lab

Everything in this section is a ranked design suggestion [U].

### 8.1 Terrain (infinite)
1. **Now: fix the canal look (§4.3 E).** Fade the carve and the river biome by the uncarved height above sea level. In highlands, carve a dry valley or nothing. Keep W ≈ 0 for small streams. This is local, quick to do and needs no new data.
2. **Next: region-local rivers (§4.3 A).** It is consistent by construction, guarantees downhill flow and has a measured reference implementation (Davis 2026). Gates (C) are also consistent, but much more work.
   - 16–32 km regions, a 128 m grid, a border band.
   - Priority-Flood from the sea cells inside the region, receivers in flood order, accumulation of humidity-weighted rain, a threshold, strictly descending river heights.
   - Cache per worker. Output river polylines with discharge, plus lake levels.
   - Carve by distance with valley, bank and bed profiles. Sloped water ribbons replace the sea plane inside rivers and lakes. Width, depth and meanders from §5.
3. **Later: halos or gates (§4.3 B, C)**, if river-free bands along region borders become visible.
- **Lakes**: where the Priority-Flood fill depth exceeds a threshold, put a lake surface at the fill level. Cap lake size, or let FMG-style evaporation decide which lakes exist.
- **Avoid** a global erosion simulation in Terrain mode: there is no outlet and no bound.

### 8.2 Voxel
- Use the same heights and networks as Terrain. Columns inside a river or lake fill with water up to the local water level instead of sea level (`voxelGen.ts:321–322` today). Minecraft doesn't do this for rivers (Mojang 2021); TerraForged 0.3.x does (§3.5) [V].

### 8.3 Planet (finite)
1. **One coarse flow-routing pass per planet (§4.4)**: a cube-sphere grid of about 6 × 64², Priority-Flood from the ocean nodes, receivers, rain-weighted accumulation, a threshold. It is cheap enough to run when the planet loads.
2. **Per node**: nearest-segment lookup in a spatial hash, then carve and colour; hashed subdivision below the coarse spacing.
3. **Optional**: Derzapf-style bounds (bed slope ≥ 1 m/km, banks above the water) to keep rivers below their surroundings at every LOD.

### 8.4 Erosion (finite)
1. **Add Priority-Flood**: show lakes, and route flow through filled depressions.
2. **Add deterministic flow accumulation** (D8 or MFD in flood order) next to the droplet visit counter. It is instant and shows the network the droplets converge toward.
3. **Add a stream-power mode.** The Schott shader loop ports directly to a worker: MFD area, erosion along the steepest receiver, and uplift taken from the sampled terrain. Cordonnier's implicit solver on receivers is the alternative.
4. **Use the finite map as the testbed** for settlements and roads (§8.5).

### 8.5 Settlements and roads (all modes)
1. **Prototype in Erosion mode.**
   - FMG-like suitability: flux and confluences, harbour, flatness, biome habitability.
   - Greedy placement with a minimum spacing.
   - Candidate links from an Urquhart or Gabriel graph.
   - A* on a 16-neighbour grid (Galin's k = 2 mask) with Tobler travel time plus a river-crossing cost, and bridges where roads cross rivers.
   - A reuse discount (Emilien's w_ex) and road classes by town size.
2. **Terrain mode.**
   - Candidates from a hashed jittered grid of about 1–2 km cells (vegetation's pattern, scaled up), scored with the region hydrology.
   - Keep a candidate only if it beats every candidate within the spacing radius; a 3×3-cell check keeps this local.
   - Plan roads per region, LayerProcGen-style, and fix road crossing points on region borders (gates) so neighbours agree. Long links between big towns go on a coarser level.
3. **Economy**: gravity weights P_i·P_j / T^γ on the route graph to rank links and grow towns (§7.2).

---

## 9. References

**Hydrology algorithms**
- O'Callaghan, J. F. & Mark, D. M. (1984). The extraction of drainage networks from digital elevation data. *Computer Vision, Graphics, and Image Processing* 28(3): 323–344. https://doi.org/10.1016/S0734-189X(84)80011-0 (paywalled; not read).
- Freeman, T. (1991). Calculating catchment area with divergent flow based on a regular grid. *Computers & Geosciences* 17(3): 413–422. https://doi.org/10.1016/0098-3004(91)90048-I (not read).
- Quinn, P., Beven, K., Chevallier, P. & Planchon, O. (1991). The prediction of hillslope flow paths for distributed hydrological modelling using digital terrain models. *Hydrological Processes* 5(1): 59–79. https://doi.org/10.1002/hyp.3360050106 (abstract only).
- Tarboton, D. G. (1997). A new method for the determination of flow directions and upslope areas in grid digital elevation models. *Water Resources Research* 33(2): 309–319. https://doi.org/10.1029/96WR03137. Read: https://hydrology.usu.edu/dtarb/96wr03137.pdf
- RichDEM documentation, "Flow metrics" (secondary): https://richdem.readthedocs.io/en/latest/flow_metrics.html
- Planchon, O. & Darboux, F. (2002). A fast, simple and versatile algorithm to fill the depressions of digital elevation models. *Catena* 46(2–3): 159–176. https://doi.org/10.1016/S0341-8162(01)00164-3. Read: https://horizon.documentation.ird.fr/exl-doc/pleins_textes/divers20-05/010031925.pdf
- Barnes, R., Lehman, C. & Mulla, D. (2014). Priority-Flood: an optimal depression-filling and watershed-labeling algorithm for digital elevation models. *Computers & Geosciences* 62: 117–127. https://doi.org/10.1016/j.cageo.2013.04.024. Read: https://arxiv.org/abs/1511.04463
- Barnes, R., Lehman, C. & Mulla, D. (2014b). An efficient assignment of drainage direction over flat surfaces in raster digital elevation models. *Computers & Geosciences* 62: 128–135. https://doi.org/10.1016/j.cageo.2013.01.009 (metadata only).
- Barnes, R. (2016). Parallel Priority-Flood depression filling for trillion cell digital elevation models on desktops or clusters. *Computers & Geosciences* 96: 56–68. https://doi.org/10.1016/j.cageo.2016.07.001. Read: https://arxiv.org/abs/1606.06204
- Barnes, R. (2017). Parallel non-divergent flow accumulation for trillion cell digital elevation models on desktops or clusters. *Environmental Modelling & Software* 92: 202–212. https://doi.org/10.1016/j.envsoft.2017.02.022. Read: https://arxiv.org/abs/1608.04431
- Cordonnier, G., Bovy, B. & Braun, J. (2019). A versatile, linear complexity algorithm for flow routing in topographies with depressions. *Earth Surface Dynamics* 7: 549–562. https://doi.org/10.5194/esurf-7-549-2019
- Callaghan, K. & Wickert, A. (2019). Computing water flow through complex landscapes, Part 1: Incorporating depressions in flow routing using FlowFill. *Earth Surface Dynamics* 7: 737–753. https://doi.org/10.5194/esurf-7-737-2019 (abstract).
- Barnes, R., Callaghan, K. & Wickert, A. (2020). Part 2: Finding hierarchies in depressions and morphological segmentations. *Earth Surface Dynamics* 8: 431–445. https://doi.org/10.5194/esurf-8-431-2020 (abstract).
- Barnes, R., Callaghan, K. & Wickert, A. (2021). Part 3: Fill–Spill–Merge: flow routing in depression hierarchies. *Earth Surface Dynamics* 9: 105–121. https://doi.org/10.5194/esurf-9-105-2021 (abstract).

**Terrain with rivers (graphics)**
- Kelley, A. D., Malin, M. C. & Nielson, G. M. (1988). Terrain simulation using a model of stream erosion. *SIGGRAPH '88*, Computer Graphics 22(4): 263–268. https://doi.org/10.1145/54852.378519
- Musgrave, F., Kolb, C. & Mace, R. (1989). The synthesis and rendering of eroded fractal terrains. *SIGGRAPH '89*, Computer Graphics 23(3): 41–50. https://doi.org/10.1145/74333.74337 (abstract).
- Prusinkiewicz, P. & Hammel, M. (1993). A fractal model of mountains with rivers. *Proc. Graphics Interface '93*: 174–180. http://algorithmicbotany.org/papers/mountains.gi93.pdf
- Belhadj, F. & Audibert, P. (2005). Modeling landscapes with ridges and rivers: bottom up approach. *GRAPHITE '05*: 447–450. https://doi.org/10.1145/1101389.1101479 (abstract).
- Mei, X., Decaudin, P. & Hu, B. (2007). Fast hydraulic erosion simulation and visualization on GPU. *Pacific Graphics 2007*: 47–56. https://doi.org/10.1109/PG.2007.15. Read: https://inria.hal.science/inria-00402079
- Šťava, O., Beneš, B., Brisbin, M. & Křivánek, J. (2008). Interactive terrain modeling using hydraulic erosion. *SCA 2008*: 201–210. https://doi.org/10.2312/SCA/SCA08/201-210. Read: https://www.cs.purdue.edu/homes/bbenes/papers/Stava08SCA.pdf
- Teoh, S. T. (2009). RiverLand: an efficient procedural modeling system for creating realistic-looking terrains. *ISVC 2009*, LNCS 5875: 468–479. https://doi.org/10.1007/978-3-642-10331-5_44 (not read).
- Derzapf, E., Ganster, B., Guthe, M. & Klein, R. (2011). River networks for instant procedural planets. *Computer Graphics Forum* 30(7): 2031–2040. https://doi.org/10.1111/j.1467-8659.2011.02052.x. Read: https://www.mathematik.uni-marburg.de/~derzapf/public/2011/TG.pdf
- Génevaux, J.-D., Galin, É., Guérin, É., Peytavie, A. & Beneš, B. (2013). Terrain generation using procedural models based on hydrology. *ACM Transactions on Graphics* 32(4): 143. https://doi.org/10.1145/2461912.2461996. Read: https://hal.science/hal-01339224
- Braun, J. & Willett, S. D. (2013). A very efficient O(n), implicit and parallel method to solve the stream power equation governing fluvial incision and landscape evolution. *Geomorphology* 180–181: 170–179. https://doi.org/10.1016/j.geomorph.2012.10.008 (paywalled; described via Cordonnier et al. 2016).
- Cordonnier, G., Braun, J., Cani, M.-P., Beneš, B., Galin, É., Peytavie, A. & Guérin, É. (2016). Large scale terrain generation from tectonic uplift and fluvial erosion. *Computer Graphics Forum* 35(2): 165–175. https://doi.org/10.1111/cgf.12820. Read: https://inria.hal.science/hal-01262376
- Mawhorter, P. (2021). Fractal coordinates for incremental procedural content generation. *FDG '21*. https://doi.org/10.1145/3472538.3472576. Read: https://cs.wellesley.edu/~pmwh/papers-fcpcg/FDG2021-Mawhorter-fractal-author.pdf and the talk slides https://cs.wellesley.edu/~pmwh/papers-fcpcg/presentation/slides.html
- Fischer, R., Boeckers, J. & Zachmann, G. (2022). Procedural generation of landscapes with water bodies using artificial drainage basins. *CGI 2022*, LNCS: 345–356. https://doi.org/10.1007/978-3-031-23473-6_27. Read: https://cgvr.cs.uni-bremen.de/papers/cgi22/CGI22.pdf
- Schott, H., Paris, A., Fournier, L., Guérin, E. & Galin, E. (2023). Large-scale terrain authoring through interactive erosion simulation. *ACM Transactions on Graphics* 42(5). https://doi.org/10.1145/3592787. Code: https://github.com/H-Schott/StreamPowerErosion @ 8a0c017fe2e599c74a19c3766b1d93d428e9d451 (`data/shaders/spe_shader.glsl`).
- Tzathas, P., Gailleton, B., Steer, P. & Cordonnier, G. (2024). Physically-based analytical erosion for fast terrain generation. *Computer Graphics Forum* 43(2). https://doi.org/10.1111/cgf.15033. Read: https://hal.science/hal-04525371
- Schott, H., Galin, É., Guérin, É., Paris, A. & Peytavie, A. (2024). Terrain amplification using multi scale erosion. *ACM Transactions on Graphics* 43(4). https://doi.org/10.1145/3658200 (abstract).
- Jain, A., Kerbl, B., Gain, J., Finley, B. & Cordonnier, G. (2024). FastFlow: GPU acceleration of flow and depression routing for landscape simulation. *Computer Graphics Forum* 43(7). https://doi.org/10.1111/cgf.15243 (abstract).
- Mogensen, T. Æ. & Isenbecker, E. N. (2025). Generation of zoomable maps with rivers and fjords. arXiv:2504.08383. https://arxiv.org/abs/2504.08383
- McDonald, N. & Cordonnier, G. (2026). Stochastic geomorphological transport for terrain erosion simulation. *ACM Transactions on Graphics* 45(4): 78. https://doi.org/10.1145/3811336. Read: https://inria.hal.science/hal-05627837
- Davis, M. K. (2026). Plate-local river generation: deterministic, terrain-aware, downhill-flowing rivers for infinite procedural worlds. arXiv:2610.00301 (preprint, not peer reviewed). https://arxiv.org/abs/2610.00301 · code: https://github.com/Davismk3/plate-local-river-generation
- Beyer, H. T. (2015): see RESEARCH.md §3.7 and its Sources.

**River geometry and scaling laws**
- Horton, R. E. (1945). Erosional development of streams and their drainage basins; hydrophysical approach to quantitative morphology. *GSA Bulletin* 56(3): 275–370. https://doi.org/10.1130/0016-7606(1945)56[275:EDOSAT]2.0.CO;2 (scan read; some pages unreadable).
- Strahler, A. N. (1957). Quantitative analysis of watershed geomorphology. *Transactions AGU* 38(6): 913–920. https://doi.org/10.1029/TR038i006p00913 (cropped scan read).
- Shreve, R. L. (1966). Statistical law of stream numbers. *Journal of Geology* 74(1): 17–37. https://doi.org/10.1086/627137
- Shreve, R. L. (1967). Infinite topologically random channel networks. *Journal of Geology* 75(2): 178–186. https://doi.org/10.1086/627245
- Hack, J. T. (1957). Studies of longitudinal stream profiles in Virginia and Maryland. USGS Professional Paper 294-B: 45–97. https://doi.org/10.3133/pp294B. Read: https://pubs.usgs.gov/pp/0294b/report.pdf
- Leopold, L. B. & Maddock, T., Jr. (1953). The hydraulic geometry of stream channels and some physiographic implications. USGS Professional Paper 252. https://doi.org/10.3133/pp252. Read: https://pubs.usgs.gov/pp/0252/report.pdf
- Leopold, L. B. & Wolman, M. G. (1960). River meanders. *GSA Bulletin* 71(6): 769–793. https://doi.org/10.1130/0016-7606(1960)71[769:RM]2.0.CO;2
- Langbein, W. B. & Leopold, L. B. (1966). River meanders: theory of minimum variance. USGS Professional Paper 422-H. https://doi.org/10.3133/pp422H. Read: https://pubs.usgs.gov/pp/0422h/report.pdf
- Dunne, T. & Leopold, L. B. (1978). *Water in Environmental Planning*. W. H. Freeman (cited by Génevaux et al. 2013; not read).
- Peytavie, A., Dupont, T., Guérin, É., Cortial, Y., Beneš, B., Gain, J. & Galin, É. (2019). Procedural riverscapes. *Computer Graphics Forum* 38(7): 35–46. https://doi.org/10.1111/cgf.13814. Read: https://www.cs.purdue.edu/homes/bbenes/papers/Peytavie19CGF.pdf
- Paris, A., Guérin, É., Collon, P. & Galin, É. (2023). Authoring and simulating meandering rivers. *ACM Transactions on Graphics* 42(6): 241. https://doi.org/10.1145/3618350. Read: https://hal.science/hal-04227965 · code: https://github.com/aparis69/Meandering-rivers
- Argudo, O., Guérin, É., Schott, H. & Galin, É. (2025). Terrain descriptors for landscape synthesis, analysis and simulation. *Computer Graphics Forum* 44(2): e70080. https://doi.org/10.1111/cgf.70080

**Map generators and games (code and first-party notes)**
- Patel, A. (2010, updated 2025). *Polygonal Map Generation for Games*. http://www-cs-students.stanford.edu/~amitp/game-programming/polygon-map-generation/ · mapgen2 JS: https://github.com/redblobgames/mapgen2 @ f16f485a62510344afe13e9c6aa01f7fa25be17e · original AS3: https://github.com/amitp/mapgen2 @ d0b09469777fcaa211c31edcefa59f13f416141f
- Patel, A. mapgen4: https://www.redblobgames.com/maps/mapgen4/ · code: https://github.com/redblobgames/mapgen4 @ c1d8cb018a11a8b9e17d59233c36c176429d37eb · trade experiment branch `2515-mapgen-trading` @ 54b35255da3b1a8f004eac7ac510e9adec2df0be · "Mapgen4: elevation" (2018): https://simblob.blogspot.com/2018/08/mapgen4-elevation.html
- O'Leary, M. (2016). *Generating fantasy maps*. http://mewo2.com/notes/terrain/ (offline; read via web.archive.org) · code: https://github.com/mewo2/terrain @ a2511d6b673ae92f5983f3343365ba9326c03b63
- Azgaar. *Fantasy Map Generator*. https://github.com/Azgaar/Fantasy-Map-Generator @ 52e2f59a9ccdfdaf5832ff0961d6e8ed59ac27fd (`src/generators/`). The 2017–2018 blog posts at https://azgaar.wordpress.com describe older algorithms.
- Mojang (2021). *New world generation in Java available for testing* (experimental snapshot notes). https://www.minecraft.net/en-us/article/new-world-generation-java-available-testing
- Minecraft data and code: misode/mcmeta `1.18-data` @ cf5ae66744ba6643b80ac48504ad54feb64a7882 (`noise_settings/overworld.json`); decompiled 1.20.1 (Blackjack200/minecraft_client_1_20_1 @ c129e3e3e6ca89a731d4cfc35bb606c6bd2cae2c: `Aquifer.java`, `NoiseBasedChunkGenerator.java`); Cubitect/cubiomes @ e61f90580cbdd883214a8054670dacae655e59c0 (`layers.c`, `generator.c`); MCP 9.40 decompile of 1.12 (WangTingZheng/mcp940 @ d0c030a4139ce7cf3f284b180f0d9ea87bdf8141: `GenLayer*.java`).
- Hello Games. *No Man's Sky* release log: https://www.nomanssky.com/release-log/ · https://www.nomanssky.com/worlds-part-i-update/ · https://www.nomanssky.com/worlds-part-ii-update/
- Harris, J. (2008). Interview: The Making of Dwarf Fortress. *Gamasutra*. https://www.gamedeveloper.com/design/interview-the-making-of-dwarf-fortress · Harris, J. (2019). Q&A: Dissecting the development of Dwarf Fortress with creator Tarn Adams. https://www.gamedeveloper.com/design/q-a-dissecting-the-development-of-i-dwarf-fortress-i-with-creator-tarn-adams · Adams, T. Development logs: http://www.bay12games.com/dwarves/dev_2008.html, dev_2010.html, dev_2011.html · `data/init/world_gen.txt` of DF 0.47.04 (unofficial mirror Qartar/dwarf-fortress @ e86f86cd112d453e798ffe4990df385835d22e67).
- TerraForged 1.16 river engine by dags (the original TerraForged/Engine repository is gone; read at RomanKrajewski/Engine @ df2e6e0be9d31b8bc80288a5002c0d0683c0839a, the last commit by dags) · TerraForged 0.3.x: https://github.com/TerraForged/TerraForged @ 6dd607ebfd41a3b7274e090b1f2cf565d53d1d44
- TerraFirmaCraft 1.21.x: https://github.com/TerraFirmaCraft/TerraFirmaCraft @ 84133fbaf3805332a008904757ef654f73634232 (`world/region/AddRiversAndLakes.java`, `world/river/`)
- LayerProcGen (runevision): https://github.com/runevision/LayerProcGen @ c13d64e53f0068ea9b24d761996406d4228adbaf (`Documentation/ContextualGeneration.md`, `EffectDistance.md`)

**Roads and networks**
- Galin, É., Peytavie, A., Maréchal, N. & Guérin, É. (2010). Procedural generation of roads. *Computer Graphics Forum* 29(2): 429–438. https://doi.org/10.1111/j.1467-8659.2009.01612.x. Read: https://perso.liris.cnrs.fr/egalin/Articles/2010-roads.pdf
- Galin, É., Peytavie, A., Guérin, É. & Beneš, B. (2011). Authoring hierarchical road networks. *Computer Graphics Forum* 30(7): 2021–2030. https://doi.org/10.1111/j.1467-8659.2011.02055.x. Read: https://www.cs.purdue.edu/homes/bbenes/papers/Galin11CGF.pdf
- Parish, Y. I. H. & Müller, P. (2001). Procedural modeling of cities. *SIGGRAPH 2001*: 301–308. https://doi.org/10.1145/383259.383292
- Chen, G., Esch, G., Wonka, P., Müller, P. & Zhang, E. (2008). Interactive procedural street modeling. *ACM Transactions on Graphics* 27(3): 103. https://doi.org/10.1145/1360612.1360702
- Emilien, A., Bernhardt, A., Peytavie, A., Cani, M.-P. & Galin, É. (2012). Procedural generation of villages on arbitrary terrains. *The Visual Computer* 28(6–8): 809–818. https://doi.org/10.1007/s00371-012-0699-7. Read: https://perso.liris.cnrs.fr/egalin/Articles/2012-villages.pdf
- Beneš, J., Wilkie, A. & Křivánek, J. (2014). Procedural modelling of urban road networks. *Computer Graphics Forum* 33(6): 132–142. https://doi.org/10.1111/cgf.12283 (author preprint read).
- Gabriel, K. R. & Sokal, R. R. (1969). A new statistical approach to geographic variation analysis. *Systematic Zoology* 18(3): 259–278. https://doi.org/10.2307/2412323 (abstract only).
- Toussaint, G. T. (1980). The relative neighbourhood graph of a finite planar set. *Pattern Recognition* 12(4): 261–268. https://doi.org/10.1016/0031-3203(80)90066-7
- Jaromczyk, J. W. & Toussaint, G. T. (1992). Relative neighborhood graphs and their relatives. *Proceedings of the IEEE* 80(9): 1502–1517. https://doi.org/10.1109/5.163414
- Urquhart, R. (1980). Algorithms for computation of relative neighbourhood graph. *Electronics Letters* 16(14): 556–557. https://doi.org/10.1049/el:19800386 (metadata only; not read).
- Helbing, D., Keltsch, J. & Molnár, P. (1997). Modelling the evolution of human trail systems. *Nature* 388: 47–50. https://doi.org/10.1038/40353 (arXiv version cond-mat/9805158 read).
- Tobler, W. (1993). *Three presentations on geographical analysis and modeling*. NCGIA Technical Report 93-1. https://escholarship.org/uc/item/05r820mz
- Boelter Mizdal, T. & Pozzer, C. (2018). Procedural content generation of villages and road system on arbitrary terrains. *SBGames 2018*: 205–215. https://doi.org/10.1109/SBGAMES.2018.00032
- Etherington, T., O'Sullivan, D., Perry, G., Richards, D. & Wainwright, J. (2024). A least-cost network neutral landscape model of human sites and routes. *Landscape Ecology* 39(3): 52. https://doi.org/10.1007/s10980-024-01836-w

**Settlements and economics**
- Christaller, W. (1933). *Die zentralen Orte in Süddeutschland*. Jena: Gustav Fischer. English: *Central Places in Southern Germany*, trans. C. W. Baskin, Prentice-Hall, 1966 (searched via archive.org full text; not read in full).
- Tinbergen, J. (1962). *Shaping the World Economy*. Twentieth Century Fund. Appendix VI, "An analysis of world trade flows". https://repub.eur.nl/pub/16826
- Zipf, G. K. (1946). The P1P2/D hypothesis: on the intercity movement of persons. *American Sociological Review* 11(6): 677–686. https://doi.org/10.2307/2087063
- Anderson, J. E. (1979). A theoretical foundation for the gravity equation. *American Economic Review* 69(1): 106–116 (citation only).
- Kummu, M., de Moel, H., Ward, P. J. & Varis, O. (2011). How close do we live to water? A global analysis of population distance to freshwater bodies. *PLoS ONE* 6(6): e20578. https://doi.org/10.1371/journal.pone.0020578
- Fang, Y. & Jawitz, J. W. (2019). The evolution of human population distance to water in the USA from 1790 to 2010. *Nature Communications* 10: 430. https://doi.org/10.1038/s41467-019-08366-z
- Bleakley, H. & Lin, J. (2012). Portage and path dependence. *Quarterly Journal of Economics* 127(2): 587–644. https://doi.org/10.1093/qje/qjs011
- Gallup, J. L., Sachs, J. D. & Mellinger, A. D. (1999). Geography and economic development. *International Regional Science Review* 22(2): 179–232. https://doi.org/10.1177/016001799761012334 (CID Working Paper No. 1 read).
- Henderson, J. V., Squires, T., Storeygard, A. & Weil, D. (2018). The global distribution of economic activity: nature, history, and the role of trade. *Quarterly Journal of Economics* 133(1): 357–406. https://doi.org/10.1093/qje/qjx030 (PMC author manuscript read).
