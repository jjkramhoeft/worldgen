# Worldgen research cheat sheet

Minecraft 1.18+ ("Caves & Cliffs"), No Man's Sky, and general terrain techniques, compiled 2026-10-13 for worldgen-lab (TypeScript + three.js).

**Tags:** **[V]** = checked against vanilla data JSON, decompiled code, or a faithful reimplementation. **[W]** = Minecraft Wiki prose. **[U]** = unverified, inferred or reconstructed; treat it as a design choice, not a fact.

The Minecraft numbers come from Java 1.20.4 data (`misode/mcmeta`, tag `1.20.4-data`) and 1.21.x code. The overworld algorithms are the same from 1.18.2 to 1.21.x. Snapshots from 2025–26 renamed and restructured the router (`preliminary_surface_level`, `chunk_surface_level`, `base_octave`, and so on). You can ignore those changes for a 1.18-style clone.

---

## 1. Minecraft 1.18+ overworld

### 1.1 Constants [V]
| item | value |
|---|---|
| world Y | −64 … 319 (`min_y` −64, `height` 384) |
| sea level | 63. Below y = −54, where no aquifer applies, air becomes lava (the global fluid picker) |
| noise cell | `size_horizontal 1`, `size_vertical 2`, so each cell is **4 × 8 × 4** blocks (x·y·z). Functions marked `interpolated` are sampled at cell corners and interpolated trilinearly |
| biome grid | 1 biome per 4×4×4 "quart". 2D climate values are cached per 4×4 column (`flat_cache`) |
| density sign | final density > 0 gives stone. Otherwise the aquifer decides between air, water and lava |
| chunk stages | structure starts → biomes → noise (terrain + caves + aquifers + ore veins) → surface rules → carvers → features |

### 1.2 Noise primitives (to match Minecraft scales) [V]
- **ImprovedNoise** is Perlin's 2002 noise. It uses a 256-entry permutation shuffled by the seeded RNG and a random origin offset (xo, yo, zo) ∈ [0,256)³. The fade is 6t⁵−15t⁴+10t³. The 16 gradients are the 12 cube edges plus (1,1,0), (0,−1,1), (−1,1,0) and (0,−1,−1). Output is roughly [−1, 1].
- **Octave sum** (`PerlinNoise`): with n = `amplitudes.length`,
  `v(p) = Σ_i amp[i] · (2^(n−1)/(2^n−1)) · 2^(−i) · improved_i(p · 2^(firstOctave+i))`.
  Inputs are wrapped modulo 2^25 (3.3554432e7).
- **NormalNoise** (what every JSON `noise` reference uses):
  `N(p) = (A(p) + B(p·337/331)) · (1/6) / (0.1·(1 + 1/(k−j+1)))`.
  Here j and k are the first and last indices with amp ≠ 0, and 337/331 = 1.0181268882175227. Output stays mostly within [−1, 1].
- `noise(xz_scale, y_scale)` samples `N(x·xz, y·ys, z·xz)`. `shifted_noise` adds `shift_x`/`shift_z` to the *scaled* coordinates.
- `shift_a = 4·N_offset(x/4, 0, z/4)` and `shift_b = 4·N_offset(z/4, x/4, 0)` (note the swapped axes). `N_offset` has firstOctave −3 and amps [1,1,1,0].
- **Climate noises** are all `shifted_noise` with xz_scale 0.25 and y_scale 0, which makes them 2D. The shift noise domain-warps them by roughly ±16 blocks [U magnitude]. "Wavelength" below is 1/(0.25·2^firstOctave), the period of the lowest octave.

| router field | noise | firstOctave | amplitudes | wavelength (blocks) | large biomes |
|---|---|---|---|---|---|
| temperature | temperature | −10 | 1.5,0,1,0,0,0 | 4096 | −12 |
| vegetation (= humidity) | vegetation | −8 | 1,1,0,0,0,0 | 1024 | −10 |
| continents | continentalness | −9 | 1,1,2,2,2,1,1,1,1 | 2048 | −11 |
| erosion | erosion | −9 | 1,1,0,1,1 | 2048 | −11 |
| ridges (= weirdness) | ridge | −7 | 1,2,1,0,0,0 | 512 | unchanged |

### 1.3 Climate parameters and peaks & valleys [V]
- There are 6 parameters: temperature **T**, humidity **H** (`vegetation`), continentalness **C**, erosion **E**, weirdness **W** (`ridges`) and depth **D**. Only D is 3D.
- **PV** (`ridges_folded`) = `−3·(| |W| − 2/3 | − 1/3)` = **`1 − |3|W| − 2|`**. W = 0 gives −1 (valleys/rivers), |W| = 2/3 gives +1 (peaks), |W| = 1 gives 0.
- **Depth** is `D(y) = 1.5 − (y+64)/128 + offset`, a `y_clamped_gradient` from (−64 → 1.5) to (320 → −1.5) plus the terrain offset. It is about 0 at the surface and increases by 1/128 per block going down.

| level | T | H | E |
|---|---|---|---|
| 0 | −1.0 … −0.45 | −1.0 … −0.35 | −1.0 … −0.78 |
| 1 | −0.45 … −0.15 | −0.35 … −0.1 | −0.78 … −0.375 |
| 2 | −0.15 … 0.2 | −0.1 … 0.1 | −0.375 … −0.2225 |
| 3 | 0.2 … 0.55 | 0.1 … 0.3 | −0.2225 … 0.05 |
| 4 | 0.55 … 1.0 | 0.3 … 1.0 | 0.05 … 0.45 |
| 5 | | | 0.45 … 0.55 |
| 6 | | | 0.55 … 1.0 |

- **C bands:** mushroom −1.2…−1.05 · deep ocean −1.05…−0.455 · ocean −0.455…−0.19 · coast −0.19…−0.11 · near-inland −0.11…0.03 · mid-inland 0.03…0.3 · far-inland 0.3…1.0. A separate "inland" span (−0.11…0.55) is used for valley swamps.
- **PV levels:** valleys −1…−0.85 · low −0.85…−0.2 · mid −0.2…0.2 · high 0.2…0.7 · peaks 0.7…1.0.

### 1.4 Biome selection (OverworldBiomeBuilder) [V]
- **Matching.** Each entry is 6 intervals plus an offset. Values are quantized as `(long)(v·10000)`. `fitness = Σ dist(v,[min,max])² + offset²`, where dist is 0 inside the interval and otherwise the distance to the nearest bound. The **minimum** fitness wins, so there is always a nearest match. Vanilla searches with an R-tree. Brute force over the ~7–8k entries also works if you cache results per quart column.
- **Depth.** Every surface biome is emitted at both D = 0 and D = 1, so it continues underground unless a cave biome fits better:
  - dripstone caves: C 0.8…1.0, D 0.2…0.9
  - lush caves: H 0.7…1.0, D 0.2…0.9
  - deep dark: E −1…−0.375 (levels 0–1), D = 1.1

  D = 0.2 is about 26 blocks below the surface, 0.9 about 115 and 1.1 about 141.
- **Off-coast.** Mushroom fields cover C −1.2…−1.05 with every other parameter at full range. Oceans are chosen by T level:
  - deep: `deep_frozen, deep_cold, deep_ocean, deep_lukewarm, warm_ocean`
  - shallow: `frozen, cold, ocean, lukewarm, warm`
- **Inland.** W is cut into 13 slices. |W| selects the slice, and the sign of W selects variants ("W≥0" below means the slice lies on the positive side).

| \|W\| | 0–0.05 | 0.05–0.2667 | 0.2667–0.4 | 0.4–0.5667 | 0.5667–0.7667 | 0.7667–0.9333 | 0.9333–1.0 |
|---|---|---|---|---|---|---|---|
| slice | valleys | low | mid | high | peaks | high | mid |

Slice tables: rows are erosion level, columns are coast / near / mid / far inland.

Legend:
- **M** = middle biome
- **MB** = middle, or badlands if T=4
- **MBS** = like MB, but a slope biome if T=0
- **P** = plateau
- **SH** = shattered (falls back to M)
- **WS(x)** = windswept savanna if T>1, H<4 and W≥0, otherwise x
- **PK** = peak
- **SL** = slope
- **B** = beach
- **SC** = shattered coast
- **SS** = stony shore
- **R** = river (frozen river at T0)
- **SW** = swamp at T1–2, mangrove swamp at T3–4, M at T0
- **SW'** = like SW, but frozen river at T0

| E | PEAKS | HIGH | MID | LOW | VALLEYS |
|---|---|---|---|---|---|
| 0 | PK PK PK PK | M SL PK PK | SS SL SL SL | SS MB MBS MBS | (W<0 ? SS : R) R MB MB |
| 1 | MBS MBS PK PK | M MBS SL SL | SS MBS MBS (T0 ? SL : P) | SS MB MBS MBS | (W<0 ? SS : R) R MB MB |
| 2 | M M P P | M M P P | SS M MB P | SS M MB MB | R R R R |
| 3 | M M MB P | M M MB P | M M MB MB | B M MB MB | R R R R |
| 4 | M M M M | M M M M | (W<0 ? B : M) M M M | B M M M | R R R R |
| 5 | WS(SH) WS(SH) SH SH | WS(M) WS(M) SH SH | SC WS(M) SH SH | SC WS(M) M M | R R R R |
| 6 | M M M M | M M M M | (W<0 ? B : M) SW SW SW | B SW SW SW | R SW' SW' SW' |

Pick helpers:
- `middle(T,H)`: W<0 gives MIDDLE[T][H]. Otherwise use VARIANT[T][H] if it exists, else MIDDLE.
- `badlands(H)`: H≤1 gives badlands, or eroded badlands if W≥0. H=2 gives badlands. H≥3 gives wooded badlands.
- `slope`: T≥3 gives plateau(T,H). Otherwise H≤1 gives snowy slopes and H≥2 gives grove.
- `peak`: T≤2 gives jagged peaks (W<0) or frozen peaks (W≥0). T3 gives stony peaks. T4 gives badlands(H).
- `beach`: T0 gives snowy beach, T4 gives desert, everything else gives beach.
- `shatteredCoast`: W≥0 ? M : beach, then wrapped in WS(...).
- `plateau`: W≥0 and a variant exists gives the variant, otherwise PLATEAU[T][H].

Tables: rows T0–T4, columns H0–H4. "a/b" means base/variant, where the variant applies when W≥0. Versions: 1.19 added mangrove swamp and deep dark, 1.20 added cherry grove, and 1.21.4 added pale garden.

| T | MIDDLE (variant) | PLATEAU (variant) | SHATTERED |
|---|---|---|---|
| 0 | snowy_plains/ice_spikes, snowy_plains, snowy_plains/snowy_taiga, snowy_taiga, taiga | snowy_plains/ice_spikes, snowy_plains, snowy_plains, snowy_taiga, snowy_taiga | windswept_gravelly_hills ×2, windswept_hills, windswept_forest ×2 |
| 1 | plains, plains, forest, taiga, old_growth_spruce/old_growth_pine | meadow/cherry_grove, meadow, forest/meadow, taiga/meadow, old_growth_spruce/old_growth_pine | windswept_gravelly_hills ×2, windswept_hills, windswept_forest ×2 |
| 2 | flower_forest/sunflower_plains, plains, forest, birch_forest/old_growth_birch, dark_forest | meadow/cherry_grove, meadow/cherry_grove, meadow/forest, meadow/birch_forest, pale_garden (dark_forest before 1.21.4) | windswept_hills ×3, windswept_forest ×2 |
| 3 | savanna, savanna, forest/plains, jungle/sparse_jungle, jungle/bamboo_jungle | savanna_plateau ×2, forest, forest, jungle | none, so M |
| 4 | desert ×5 | badlands/eroded_badlands ×2, badlands, wooded_badlands ×2 | none, so M |

### 1.5 Terrain shaping: offset, factor, jaggedness [V]
```
offset   = −0.50375 + S_off(C, E, PV)          // per column. The blend terms vanish in fresh chunks
factor   = S_fac(C, E, W, PV)
jagged   = S_jag(C, E, W, PV)
D(y)     = 1.5 − (y+64)/128 + offset
sloped_cheese = 4·qneg( (D + jagged·hneg(N_jagged(x·1500, 0, z·1500))) · factor ) + base3d
qneg(x) = x<0 ? x/4 : x      hneg(x) = x<0 ? x/2 : x
```
- **Surface height** (2D estimate, where D = 0): **`y ≈ 128 + 128·offset ≈ 63.5 + 128·S_off`**. One unit of offset is 128 blocks.
- **3D-noise influence.** Below the surface the density slope is factor/32 per block. Above the surface it is factor/128, because qneg flattens it. So a base3d value b moves the surface up by about 128·b/factor blocks (overhangs) or down by about 32·|b|/factor. A **low factor gives wild 3D terrain**.
- **base3d** is `old_blended_noise(xz_scale 0.25, y_scale 0.125, xz_factor 80, y_factor 160, smear 8)`, the legacy 1.17 noise. An 8-octave selector (firstOctave −7, sampled at p·684.412·scale/factor) lerps between two 16-octave limit noises (firstOctave −15), and the result is divided by 128.
- **`N_jagged`** has firstOctave −16, 16 amplitudes of 1, and y_scale 0. The lowest octave has a wavelength of about 44 blocks.
- **Spline evaluation** (CubicSpline): locations xᵢ, values yᵢ (each a number or a nested spline), derivatives dᵢ (default 0). With t = (x−x₀)/(x₁−x₀):
  `p = d₀(x₁−x₀) − (y₁−y₀)`, `q = −d₁(x₁−x₀) + (y₁−y₀)`,
  `y = lerp(t, y₀, y₁) + t(1−t)·lerp(t, p, q)`.
  Outside the range it extends linearly: `y_end + d_end·(x − x_end)`.
- **S_off outer spline over C:**
  - −1.1 → 0.044 (mushroom islands, y≈69)
  - −1.02 … −0.51 → −0.2222 (deep ocean floor, y≈35)
  - −0.44 … −0.18 → −0.12 (ocean floor, y≈48)
  - −0.16, −0.15, −0.1, 0.25 and 1.0 → nested E splines (below)

  Each nested cell below lists `PV → value`, with the derivative shown as `d` where it is large.

| E point | C = −0.16 / −0.15 (coast) | C = −0.1 (near) | C = 0.25 (mid) | C = 1.0 (far) |
|---|---|---|---|---|
| −0.85 | −1→−0.089, 1→0.69 (d 0.389) | same | −1→0.202, 0→0.716, 1→1.23 | −1→0.348, 0→0.924, 1→1.5 |
| −0.7 | −1→−0.116, 1→0.64 (d 0.378) | same | −1→0.2, 0→0.447, 1→0.88 | −1→0.2, 0→0.539, 1→1.0 |
| −0.4 | −1→−0.222, −0.75→−0.222, −0.65→0, 0.605→0, 1→0.1 | same | −1→0.2, 0→0.308, 1→0.70 | as −0.7 |
| −0.35 | −1→−0.3, −0.4…0.4→0.05, 1→0.06 | −1→−0.25, rest same | −1→−0.25, −0.4…0.4→0.35, 1→0.42 | −1→−0.2, −0.4…0.4→0.5, 1→0.6 |
| −0.1 | −1→−0.15, −0.4/0→0, 0.4→0.05, 1→0.06 | −1→−0.1, −0.4→0.001, 0→0.003, 0.4→0.05, 1→0.06 | −1→−0.1, −0.4→0.007, 0→0.021, 0.4→0.35, 1→0.42 | −1→−0.05, −0.4→0.01, 0→0.03, 0.4→0.5, 1→0.6 |
| 0.2 | −1→−0.15, −0.4…1→0 | −1→−0.1, −0.4/0→0.01, 0.4→0.03, 1→0.1 | same as near | −1→−0.05, −0.4/0→0.01, 0.4→0.03, 1→0.1 |
| 0.4 / 0.58 | (no point) | (no point) | as 0.2 | as 0.2 |
| 0.45 / 0.55 | (no point) | (no point) | −1→−0.1, −0.4→(0.2 row), 0→**0.17** | −1→−0.05, −0.4→(0.2 row), 0→**0.17** |
| 0.7 | −1→−0.02, −0.4/0→−0.03, 0.4→0, 1→0 | −1→−0.02, −0.4/0→−0.03, 0.4→0.03, 1→0.1 | as near | −1→−0.02, −0.4/0→0.01, 0.4→0.03, 1→0.1 |

  This produces three effects. River beds sit at PV = −1, where offsets of −0.02 to −0.3 put them at y ≈ 25–61, below sea level. Mountains appear where erosion is low and PV is high (up to 1.5, y ≈ 256). The 0.17 plateau at E 0.45–0.55 is the windswept/"shattered" step.
- **S_fac** (higher means flatter and more 2D; the inner splines are keyed on raw W and on PV):
  - oceans (C ≤ −0.19): 3.95
  - inland base by C: −0.15 → 6.25, −0.1 → 5.47, 0.03 → 5.08, ≥0.06 → 4.69. At the W-keyed erosion points the base applies for W ≥ 0.2, and W ≤ −0.2 gives 6.3
  - **2.67** at the E = −0.5 point when W ≥ 0.05 (W ≤ −0.05 gives 6.3), and at the E = −0.1 point when W ≤ −0.05 (W ≥ 0.05 gives 6.3)
  - **0.625** for C ≤ 0.03 at E 0.45–0.55 with W ≥ 0.1 and PV ≥ −0.69 (shattered terrain)
  - for C ≥ 0.06: **1.56** at E 0.05–0.4 with PV ≥ 0.7, and **1.37** at E 0.45–0.55 with PV ≥ −0.15
- **S_jag:**
  - 0 for C ≤ −0.11 or E ≥ −0.375
  - otherwise ramps with PV from 0.2–0.45 to 1.0, reaching **0.63** (W<0) or **0.3** (W>0) at E −1, and 0.315/0.15 at E −0.78…−0.5775 near C = 0.03
- **Amplified preset** (applied to the spline values): S_off → (s<0 ? s : 2s), S_fac → 1.25 − 6.25/(f+5), S_jag ×2.

### 1.6 Final density and noise caves [V]
```
final = min( squeeze( 0.64 · interpolated( slides( X ) ) ), noodle )      // squeeze(c)=c/2−c³/24, c clamped to [−1,1]
slides(X): top: lerp to −0.078125 between y 240→256;  bottom: lerp to +0.1171875 between y −40→−64
X = sloped_cheese < 1.5625 ? min(sloped_cheese, 5·entrances)                      // near-surface: only entrances cut in
                           : max( min( min(cheese, entrances), spaghetti2d + roughness ), pillarsOrNone )
cheese   = 4·N_cave_layer(1, 8)² + clamp(0.27 + N_cave_cheese(1, 0.667), −1, 1) + clamp(1.5 − 0.64·sloped_cheese, 0, 0.5)
entrances= min( 0.37 + N_cave_entrance(0.75, 0.5) + ygrad(−10→0.3, 30→0),
                roughness + clamp( max(WS1(N_spag3d_1), WS1(N_spag3d_2)) − 0.0765 − 0.0115·N_spag3d_thickness, −1, 1) )
roughness= (−0.05 − 0.05·N_rough_mod) · (−0.4 + |N_rough|)
spaghetti2d = clamp( max( WS2(N_spag2d) + 0.083·TM,  (|8·N_spag2d_elev(1, 0) + ygrad(−64→8, 320→−40)| + TM)³ ), −1, 1 )
TM       = −0.95 − 0.35·N_spag2d_thickness(2, 1)
pillars  = (2·N_pillar(25, 0.3) − 1 − N_pillar_rareness) · (0.55 + 0.55·N_pillar_thickness)³ ;  pillarsOrNone = pillars ≥ 0.03 ? pillars : −1e6
noodle   = (y∉[−60,320] or interp(N_noodle) < 0) ? 64
           : interp(−0.075 − 0.025·N_noodle_thick) + 1.5·max(|interp(N_ridge_a(2.667))|, |interp(N_ridge_b(2.667))|)
```
- `N_x(a, b)` means `noise(xz_scale a, y_scale b)`. The firstOctaves are:
  - cheese −8 (amps 0.5,1,2,1,2,1,0,2,0) · cave_layer −8 · entrance −7 (0.4,0.5,1)
  - spaghetti_3d_1/2 −7 · spaghetti_3d_rarity −11 (scale 2,1) · spaghetti_3d_thickness −8 · spaghetti_roughness −5 · roughness_modulator −8
  - spaghetti_2d −7 · its modulator −11 (scale 2,1) · elevation −8 · thickness −11
  - noodle / noodle_thickness −8 · noodle ridges −7 · pillar −7 (1,1) · pillar rareness and thickness −8
- **Weird scaled sampler:** `WS(n) = r·|n(p/r)|`, where r comes from the rarity mapper:
  - type_1 (3D spaghetti): v<−0.5 gives 0.75, v<0 gives 1, v<0.5 gives 1.5, else 2
  - type_2 (2D spaghetti): v<−0.75 gives 0.5, v<−0.5 gives 0.75, v<0.5 gives 1, v<0.75 gives 2, else 3
- **Tube trick:** `max(|a|,|b|) + t < 0` only where *both* noises are near 0, which is the intersection of two zero-isosurfaces and therefore a 3D curve. Noodles are air where `max(|a|,|b|) < (0.075+0.025n)/1.5 ≈ 0.033–0.067`. Spaghetti 2D intersects one noise's zero sheet with an elevation band about ±7.6 blocks thick.
- **Preliminary surface** (used by aquifers and surface rules): scan y down in 8-block steps from the top until `initial_density_without_jaggedness > 0.390625`. That density is `slides(clamp(−0.703125 + 4·qneg(D·factor), −64, 64))`.

### 1.7 Aquifers [W] (pressure formula [V] from deepslate)
- **Cells** are 16×12×16. The grid is shifted −5 in x/z and +1 in y. Each cell has one random centre at offset x,z ∈ [0,9] and y ∈ [0,8].
- **Nearest centres.** Each block checks 2×3×2 cells and takes the 4 nearest centres (squared distances d₁ ≤ d₂ ≤ d₃). If `d₂ − d₁ ≥ 25`, the block simply takes the nearest cell's status: fluid if y < that cell's level, otherwise air.
- **Barriers.** Otherwise `sim(a,b) = 1 − |b−a|/25` and `pressure = 2·max(0,sim₁₂)·max(P₁₂, P₁₃·max(0,sim₁₃), P₂₃·max(0,sim₂₃))`. The block becomes stone when `density + pressure > 0`.
  - P for a water/lava pair = 1. Equal levels give 0.
  - Otherwise `a = y+0.5 − (L₁+L₂)/2` and `p = |L₁−L₂|/2 − |a|`.
  - `P = a>0 ? (p>0 ? p/1.5 : p/2.5) : (p>−3 ? (p+3)/3 : (p+3)/10)`. Add the barrier noise (sampled at y·0.5) if |P| ≤ 2.
- **Cell status.** The preliminary surface is sampled at 13 chunk offsets and raised by 8. Then:
  - If the cell bottom (centre y − 12) is above its own chunk's surface, the global rule applies (water to 63, lava below −54).
  - Otherwise the cell is **sea** (level 63) if its top (centre y + 12) is above a sampled surface that is below sea level.
  - Otherwise floodedness is `clamp(N,−1,1)`. Thresholds lerp from shallow to deep, where deep means ≥ 64 blocks below the surface. **Full flood** if > −0.3…0.8, giving the global level (63, or −54 for lava). **Partial flood** if > −0.8…0.4, giving level `40·floor(y/40) + 20 + spread`, where spread ∈ [−10,10] in steps of 3 (from `fluid_level_spread`).
  - Anything else is **dry**.
- **Lava** if the level is ≤ −10 and `|N_lava| > 0.3`, sampled per 64×40×64 region. **No aquifers** where E < −0.225 and D > 0.9, which is why the deep dark is dry.

### 1.8 Ore veins (OreVeinifier) [V]
```
t = vein_toggle = interp(N_ore_veininess(1.5,1.5)) for y∈[−60,51) else 0
type = t>0 ? COPPER(y 0..50, copper_ore / raw_copper_block / granite) : IRON(y −60..−8, deepslate_iron_ore / raw_iron_block / tuff)
a = |t| + clampedMap(min(maxY−y, y−minY), 0, 20, −0.2, 0);  if a < 0.4 → no vein (also outside the y range)
if rand > 0.7 → unchanged;   if vein_ridged ≥ 0 → unchanged    // vein_ridged = −0.08 + max(|N_vein_a(4,4)|, |N_vein_b(4,4)|)
richness = clampedMap(a, 0.4, 0.6, 0.1, 0.3)
if rand < richness && vein_gap(N_ore_gap) > −0.3 → (rand < 0.02 ? raw block : ore) else filler
```

### 1.9 Surface rules (highlights) [V]
- **Surface depth:** `surfaceDepth(x,z) = int(N_surface(x,0,z)·2.75 + 3 + rand·0.25)`. N_surface has firstOctave −6 and amps 1,1,1, giving about 0–6 blocks.
- **Floor conditions** (stoneDepth counts solid blocks from the top; the top block is 1):
  - ON_FLOOR: depth ≤ 1
  - UNDER_FLOOR: ≤ 1 + surfaceDepth
  - DEEP_UNDER_FLOOR: adds `secondary ∈ [0,6]`, from `surface_secondary` mapped −1..1 → 0..6
  - VERY_DEEP: secondary range 0…30
- **Default column:** grass block if ON_FLOOR and above the water line (`water(−1,0)`), otherwise dirt under the floor and stone deeper. Deserts and beaches use sand with sandstone at DEEP/VERY_DEEP_UNDER_FLOOR.
- **Deepslate** is a vertical gradient: always at y ≤ 0, with probability fading linearly to 0 at y 8. The **bedrock floor** is always present at −64 and fades to none by −59.
- **Stony peaks:** calcite where `N_calcite ∈ [−0.0125, 0.0125]`, otherwise stone. Jagged and frozen peaks use stone on steep floors and snow, powder snow or packed ice chosen by noise windows.
- **"Steep"** means the WORLD_SURFACE_WG height at z+1 ≥ height at z−1 + 4, or height at x−1 ≥ height at x+1 + 4. Only north- and east-facing slopes count.
- **Badlands:**
  - y ≥ 256 gives orange terracotta.
  - Above about 74 (+surfaceDepth) you get **bands**: `band[(y + round(4·N_clay_bands_offset(x,0,z))) mod 192]`. Plain terracotta appears where N_surface ∈ [−0.909,−0.545] ∪ [−0.182,0.182] ∪ [0.545,0.909].
  - Near water you get red sand or red sandstone. Wooded badlands put coarse dirt or grass at y ≥ 97.
- **Band table** (192 rows, all terracotta at first):
  - an orange row every 1–5 rows
  - 6–15 yellow bands (1–3 thick), 6–15 brown bands (2–4), 6–15 red bands (1–3)
  - 9–15 white rows spaced 4–19 apart, each neighbour turning light gray with 50% chance
- **Eroded-badlands hoodoos:** top = `64 + min(e²·2.5, ceil(|N_roof(0.75x)|·1.5·50) + 24)`, with `e = min(|N_badlands_surface·8.25|, N_badlands_pillar(0.2x)·15)`.
- **Swamps:** water at y 62 where N_swamp ≥ 0.

### 1.10 Structure placement (random_spread) [V]
```
rx = floorDiv(chunkX, spacing); rz = floorDiv(chunkZ, spacing)
rng = java.util.Random(rx·341873128712 + rz·132897987541 + worldSeed + salt)     // 48-bit LCG
n = spacing − separation;  off = linear ? rng.nextInt(n) : (rng.nextInt(n) + rng.nextInt(n)) / 2   // x first, then z
candidate = (rx·spacing + offX, rz·spacing + offZ)   → then biome check, optional frequency (<1) reject, exclusion zones
```
| set | spacing | sep | salt | notes |
|---|---|---|---|---|
| villages | 34 | 8 | 10387312 | |
| desert pyramid / igloo / jungle temple / swamp hut | 32 | 8 | 14357617 / …618 / …619 / …620 | |
| pillager outpost | 32 | 8 | 165745296 | freq 0.2, ≥10 chunks from villages |
| ocean monument | 32 | 5 | 10387313 | triangular |
| woodland mansion | 80 | 20 | 10387319 | triangular |
| shipwreck / ocean ruins | 24 / 20 | 4 / 8 | 165745295 / 14357621 | |
| ruined portal | 40 | 15 | 34222645 | |
| ancient city / trail ruins / trial chambers | 24 / 34 / 34 | 8 / 8 / 12 | 20083232 / 83469867 / 94251327 | |
| mineshaft / buried treasure | 1 | 0 | 0 | freq 0.004 / 0.01 (legacy methods) |
| strongholds | concentric rings | | | distance 32, spread 3, count 128 |

---

## 2. No Man's Sky

### 2.1 What is actually documented
- **Sean Murray, "Building Worlds Using Math(s)", GDC 2017.** Its YouTube chapter list (surfaced by web search; the page itself could not be read) covers fBm, analytical derivatives, domain warping, sharpness, slope erosion, amplitude damping and "testing the untestable". At 22:56 he credits Parberry's *exponentially distributed noise* (§3.6). No slides or transcript were reachable, so the exact formulas are **[U]**.
- **Innes McKendrick, "Continuous World Generation in No Man's Sky", GDC 2017.** The pipeline is voxel generation → polygonization → texturing → population → simulation. His 2015 nucl.ai talk (secondhand write-up) adds:
  - voxel regions are **octrees on a cube projected onto a sphere**
  - voxels are stored in flat arrays
  - generators are modular
  - texturing is **triplanar**
- **Meshing** (secondhand notes on the 2017 talk): a custom **dual contouring with LOD**. Seams between LOD blocks are hidden by polygonizing slightly into neighbouring blocks at a *lower isolevel*. Official 5.0 "Worlds Part I" (2024) patch notes: terrain was rewritten to use **dual marching cubes** (fewer vertices, faster, less memory). Region and voxel sizes and LOD counts are **[U]**.

### 2.2 Uber noise
Parameter names come from NMS game data (`TkNoiseUberData`, reverse-engineered in MBINCompiler) **[V names]**:
`Octaves, Lacunarity, Gain, PerturbFeatures, SharpToRoundFeatures, AmplifyFeatures, AltitudeErosion, RidgeErosion, SlopeErosion` plus `DebugNoiseType ∈ {Plane, Check, Sine, Uber}`. Meanings, partly community-inferred **[U]**:

| param | meaning |
|---|---|
| Octaves / Lacunarity / Gain | fBm count / frequency ×/octave (~2) / amplitude ×/octave (~0.5) |
| PerturbFeatures | domain-warp strength (shipped files use about −0.1…0.21) |
| SharpToRoundFeatures | morph between ridged (sharp, `1−abs`) ↔ plain ↔ billow (rounded, `abs`); values −1/0/1 seen; sign convention unknown |
| AmplifyFeatures | boosts feature amplitude (0…0.5 seen) |
| SlopeErosion | damps later octaves where the accumulated analytic gradient is large (IQ-style 1/(1+‖∇‖²)) |
| AltitudeErosion | "amplitude damping" by current height: less detail low down, giving flat valley floors and mesas |
| RidgeErosion | damps detail along ridgelines; exact formula unknown |

Reconstruction pseudo-code. **This is not Hello Games code [U].** It combines IQ derivative erosion with de Carpentier's Swiss turbulence (§3.3):
```
uber(p): p += Perturb · warp(p)                       // e.g. IQ q-warp or derivative-warp
  sum=0; amp=1; freq=1; dsum=vec2(0)
  for i < Octaves:
    (n, dn) = noiseD(p·freq)                             // value + analytic gradient
    s = SharpToRound; billow = 2|n|−1; ridge = 1−2|n|    // d/dx|n| = sign(n)·dn
    f = s≥0 ? lerp(n, ridge, s) : lerp(n, billow, −s)    // same lerp on derivatives
    f *= 1 + Amplify·max(f,0)
    dsum += amp·freq·df
    sum  += amp·f / (1 + SlopeErosion·dot(dsum,dsum))
    freq *= Lacunarity
    amp  *= Gain · lerp(1, clamp(sum,0,1), AltitudeErosion) · lerp(1, 1−max(f,0), RidgeErosion)
  return sum
```

### 2.3 Planet voxel generator layers (game data) [V names, U semantics]
- **`TkVoxelGeneratorData`:**
  - `BaseSeed`, `SeaRatio`, `NoSeaBaseLevel`
  - `NoiseLayers[]` (uber height layers), `GridLayers[]` (3D primitives), `Features[]`
  - `CavesUnderground {Mouth, Tunnel}`, `MinimumCaveDepth`, `CaveRoofSmoothingDist`
  - building smoothing radii, `Regions.PlanetRadius`
- **Uber layer** (`TkNoiseUberLayerData`):
  - `Height`, `Width` (likely amplitude and scale)
  - `RegionRatio`, `RegionScale` (a mask choosing where the layer applies)
  - `HeightOffset` + `OffsetType ∈ {Zero, Base, All, SeaLevel}`
  - `Subtract`, `MaximumLOD` (detail layers skipped at far LODs)
  - `PlateauStratas`, `PlateauSharpness`, `PlateauRegionSize` (terracing)
  - `WaterFade ∈ {None, Above, Below}`, `SeedOffset`
  - `NoiseVoxelType ∈ {Base, Rock, Mountain, Sand, Cave, Substance_1..3, RandomRock, RandomRockOrSubstance}` (material)
- **Grid layers:** `Cube, Cone, Torus, Sphere, Cylinder, Capsule, Corridor, Pipe, Puck, SuperPrimitive, SuperFormula_01..08` with yaw/pitch/roll variation and a turbulence uber layer. The **superformula** is Gielis: `r(φ) = (|cos(mφ/4)|^n2 + |sin(mφ/4)|^n3)^(−1/n1)`, with fields `Form_m, n1, n2, n3`.
- **Features:** `Tube | Blob`, with width, height, octaves, region size and height variance. Caves are a Mouth feature plus a Tunnel feature.

### 2.4 Seeds and addresses
- Every planet has one seed that "defines everything" (Murray, PlayStation Blog 2014). The universe uses 64-bit seeds, giving 2^64 = 18,446,744,073,709,551,616 planets. Game data uses `GcSeed {long Seed}`. `GcSolarSystemData` holds a system Seed, Class, the planet count, and per-planet `GcPlanetGenerationInputData {Seed, StarType, PlanetClass, CommonSubstance, RareSubstance, PlanetSize, BiomeType}`. That implies a seed cascade from system to planets to content **[V names]**. The actual hash from address to seed is not public **[U]**.
- **Portal address** (12 hex glyphs = 48 bits per galaxy): `P SSS YY ZZZ XXX`.
  - P = planet index: 1–6 used
  - SSS = system index: the field allows 000–FFE; players report regions holding systems up to about 0x2FF
  - YY = signed 8-bit Y; ZZZ / XXX = signed 12-bit Z/X
  - The galaxy grid is 4096 × 256 × 4096 regions. In the signal-booster format `XXXX:YYYY:ZZZZ:SSSS`, X/Z are offset by 0x7FF and Y by 0x7F.
  - There are 256 galaxies **[U]**.

### 2.5 Creatures, flora, objects
- Artists hand-build "blueprints": template skeletons, rigs and parts based on real animal anatomy. The generator varies proportions and parts per seed, and animation is generated to fit the varied body (Game Informer 2014, pre-release). Colours follow the planet: blue minerals give bluish life.
- **Part selection (game data) [V names]:** `TkModelDescriptorList` → `TkResourceDescriptorList {TypeId, Descriptors[]}` → `TkResourceDescriptorData {Id, Name, ReferencePaths, Chance, Children[]}`. In practice: pick one descriptor per TypeId group, weighted by `Chance`, and recurse into Children. The result is a tree of interchangeable scene parts (heads, bodies, tails and so on).
- Flora, rocks and props are polygon meshes placed during the "population" stage. Since 5.0 they render on a GPU-based rendering system (patch notes).

---

## 3. General techniques

### 3.1 fBm (Inigo Quilez) [V]
- `fbm(x) = Σ G^i · noise(2^i·x)`, with `G = 2^(−H)`.
- **H = 1 (G = 0.5)** gives isotropic self-similarity and is the usual terrain choice. H = ½ (G ≈ 0.707) is Brownian.
- The power spectrum is f^(−(2H+1)), so H = 1 falls by −9 dB per octave.
- To avoid aligned artifacts, use a lacunarity of 1.99 or 2.01 instead of exactly 2, and **rotate each octave**. In 2D use GLSL `mat2(0.8, −0.6, 0.6, 0.8)` (column-major, a 36.87° rotation with scale 1); apply `p = 2·m·p` per octave.
- IQ's 3D derivative fBm uses f = 1.98 and gain 0.49. About 24 octaves span a planet down to roughly 2 m.

### 3.2 Domain warping (IQ) [V]
```
q = ( fbm(p + (0,0)),  fbm(p + (5.2,1.3)) )
r = ( fbm(p + 4q + (1.7,9.2)),  fbm(p + 4q + (8.3,2.8)) )
f = fbm(p + 4r)                     // the offsets are arbitrary decorrelators; 4.0 = warp strength
```
Colour by |q| and r.x to visualise the flow.

### 3.3 Derivative ("erosion") fBm [V]
- **IQ** (2D value noise with analytic derivatives and quintic fade, `u = 6x⁵−15x⁴+10x³`, `u' = 30x²(x−1)²`):
  `a=0, b=1, d=0; 15×: (n, dx, dy) = noised(p); d += (dx,dy); a += b·n/(1+dot(d,d)); b *= 0.5; p = 2·m·p` with m as in §3.1. Steep areas lose fine detail, which gives smooth slopes and rough flats.
- **de Carpentier, Swiss turbulence:** `n = noiseD((p + warp·dsum)·freq); sum += amp·(1−|n|); dsum += amp·(−n·∇n); freq *= lac; amp *= gain·clamp(sum,0,1)`. Defaults: lac 2, gain 0.5 (0.6 suggested), warp 0.15.
- **de Carpentier, Jordan turbulence** uses squared octaves `n²` with gradient-damped amplitude `amp·(1 − damp_scale/(1+‖ddamp‖²))` and a gradient warp. Defaults: lac 2, gain1 0.8, gain 0.5, warp0 0.4, warp 0.35, damp0 1.0, damp 0.8, damp_scale 1.0.

### 3.4 Ridged multifractal (Musgrave; libnoise `RidgedMulti`) [V]
```
w_i = lacunarity^(−i·H); weight = 1; value = 0
per octave: s = (offset − |noise(p)|)²; s *= weight; weight = clamp(s·gain, 0, 1); value += s·w_i; p *= lacunarity
libnoise output: value·1.25 − 1.  Defaults: H 1.0, offset 1.0, gain 2.0, lacunarity 2.0, octaves 6, frequency 1.0
```

### 3.5 Red Blob Games, "Making maps with noise" [V]
- **Octaves:** `e = (1·N(p) + 0.5·N(2p) + 0.25·N(4p)) / 1.75`, with N in [0,1] and p = (x/w − 0.5, y/h − 0.5)·freq.
- **Redistribution:** `e = pow(e·fudge, exponent)`, with fudge ≈ 1.2. Higher exponents give flatter valleys and sharper peaks.
- **Islands** (nx, ny in [−1,1]): `e = lerp(e, 1−d, mix)`, where d is either:
  - **square bump** `d = 1 − (1−nx²)(1−ny²)`
  - **Euclidean²** `d = min(1, (nx²+ny²)/√2)`
- **Terraces:** `e = round(e·n)/n`.
- **Ridged:** `ridge = 2(0.5 − |0.5 − N|)`. Octaves are weighted by the lower ones: `e1 = 0.5·ridge(2p)·e0`, `e2 = 0.25·ridge(4p)·(e0+e1)`.
- **Biomes from elevation e and moisture m** (Whittaker-style; tune per project):
  - e<0.1 ocean; e<0.12 beach
  - **e>0.8:** m<0.1 scorched, <0.2 bare, <0.5 tundra, else snow
  - **e>0.6:** m<0.33 temperate desert, <0.66 shrubland, else taiga
  - **e>0.3:** m<0.16 temperate desert, <0.5 grassland, <0.83 temperate deciduous forest, else temperate rain forest
  - **else:** m<0.16 subtropical desert, <0.33 grassland, <0.66 tropical seasonal forest, else tropical rain forest

### 3.6 Exponentially distributed noise (Parberry 2015, JCGT 4(2)) [V]
DEM statistics show terrain gradients are exponentially distributed at every scale. To match that, scale each Perlin lattice gradient by a magnitude from `m[i] = μ^i` (0 < μ ≤ 1, B = 256 entries), chosen by a second hash. The result is mostly gentle terrain with occasional cliffs. Keep μ^255 representable as a float. A concrete μ is in the paper's supplemental code **[U]**.

### 3.7 Hydraulic droplet erosion (Beyer 2015 thesis; Sebastian Lague) [V]
Per droplet: spawn at a random point with `dir=0`, `speed=v0`, `water=w0`, `sediment=0`. Then repeat until `maxLifetime` steps or the droplet leaves the map:
1. Bilinearly sample the height h and gradient g in the current cell (NW, NE, SW, SE with offsets u, v):
   `gx = (NE−NW)(1−v) + (SE−SW)v`, `gy = (SW−NW)(1−u) + (SE−NE)u`.
2. Update direction: `dir = dir·inertia − g·(1−inertia)`, then normalize. Beyer picks a random direction if the result is 0.
3. Move: `pos += dir` (always 1 cell, independent of speed). Stop if the droplet is still or out of bounds.
4. `Δh = h(new) − h(old)`.
   - Lague capacity: `c = max(−Δh·speed·water·Kc, cMin)`.
   - Beyer capacity: `c = max(−Δh, minSlope)·vel·water·Kc`.
5. **Deposit:** if `sediment > c` or `Δh > 0`, drop `Δh>0 ? min(Δh, sediment) : (sediment−c)·Kdep` at the *old* position, split bilinearly over 4 nodes.
   **Erode:** otherwise take `min((c−sediment)·Kero, −Δh)` spread over a radius brush with weights `max(0, r − dist)/Σ`.
6. `speed = sqrt(speed² + Δh·g)` and `water *= (1 − evap)`. Both sources write `+Δh·g` with Δh = new − old. Physically, downhill should *accelerate*, so many ports use `sqrt(max(0, speed² − Δh·g))`. Choose deliberately.

| param | Lague `Erosion.cs` default | Beyer benchmark set |
|---|---|---|
| inertia | 0.05 | 0.3 (figures: 0.025–0.4) |
| sedimentCapacityFactor Kc | 4 | 8 (2–32) |
| minSedimentCapacity / minSlope | 0.01 (capacity floor) | 0.01 (slope floor) |
| erodeSpeed Kero | 0.3 | 0.7 (0.01–0.9) |
| depositSpeed Kdep | 0.3 | 0.2 (0.01–1) |
| evaporateSpeed | 0.01 | 0.02 (0.0125–0.1) |
| gravity | 4 | 10 |
| maxDropletLifetime / maxPath | 30 | 64 |
| erosionRadius | 3 (range 2–8) | 4 (2–6) |
| initialWaterVolume / initialSpeed | 1 / 1 | not stated [U] |

Typical runs use about 50k–500k droplets for a 256²–512² map **[U]**. Beyer also suggests blurring: `map = b·blurred + (1−b)·map`.

### 3.8 Thermal erosion (talus) [V]
For each cell h and each neighbour i with height difference `dᵢ = h − hᵢ > T`, move `Δhᵢ = c·(d_max − T)·dᵢ/d_total` to that neighbour and remove the total from h. Here `d_max` is the largest such dᵢ and `d_total` is their sum. Olsen (2004) uses **T = 4/N** for an N×N map with heights in [0,1], and **c = 0.5**. Higher c oscillates; lower c converges slowly. Moore neighbourhood is the reference; von Neumann (or a rotated von Neumann) is about 2× cheaper. Run for tens to hundreds of iterations. The talus angle is `atan(T·heightScale/cellSize)`.

### 3.9 Simplex noise constants [V]
| implementation | 2D | 3D | 4D |
|---|---|---|---|
| Gustavson 2005 Java ("Simplex noise demystified") | r² 0.5, ×70 | r² **0.6**, ×32 | r² 0.6, ×27 |
| Gustavson C `simplexnoise1234` (different 2D gradients) | 0.5, ×40 | 0.5, ×72 | 0.5, ×62 |

The kernel is `(r² − |d|²)⁴ · dot(grad, d)`. r² = 0.6 is **discontinuous** at simplex borders; Gustavson's own annotation in the PDF says it should be 0.5. With the 12 edge gradients and r² 0.5 the 3D scale is ×72. Skew constants:
- F2 = (√3−1)/2, G2 = (3−√3)/6
- F3 = 1/3, G3 = 1/6
- F4 = (√5−1)/4, G4 = (5−√5)/20

---

## Sources

**Minecraft**
- Minecraft Wiki: https://minecraft.wiki/w/World_generation · https://minecraft.wiki/w/Noise_router · https://minecraft.wiki/w/Density_function · https://minecraft.wiki/w/Aquifer · https://minecraft.wiki/w/Ore_vein · https://minecraft.wiki/w/Noise
- Vanilla worldgen JSON (1.20.4): https://github.com/misode/mcmeta/tree/1.20.4-data/data/minecraft/worldgen (`noise_settings/overworld.json`, `density_function/overworld/*.json`, `noise/*.json`). Structure sets (1.21.1): https://github.com/misode/mcmeta/tree/1.21.1-data/data/minecraft/worldgen/structure_set
- deepslate (TypeScript reimplementation by misode), v0.21.0: https://github.com/misode/deepslate/tree/v0.21.0/src (ImprovedNoise, PerlinNoise, NormalNoise, BlendedNoise, CubicSpline, DensityFunction, Aquifer, SurfaceSystem, Climate, NoiseChunk). The ShiftNoise ×4 fix is in `main`.
- OverworldBiomeBuilder ports:
  - 1.18: https://github.com/Badel2/slime_seed_finder/blob/master/src/biome_info_118.rs
  - 1.21.10: https://github.com/PLANETA9091/c-crussty/blob/master/chunk-factory/src/vanilla_biomes.rs
- Decompiled 1.21.10 source, third-party mirror (OreVeinifier, SurfaceSystem, SurfaceRuleData, SurfaceRules, RandomSpreadStructurePlacement, WorldgenRandom, NoiseRouterData, TerrainProvider): https://github.com/HungLo2020/MattMC
- Henrik Kniberg:
  - "Minecraft terrain generation in a nutshell": https://www.youtube.com/watch?v=CSa5O6knuwI
  - "Reinventing Minecraft world generation" (Jfokus): https://www.youtube.com/watch?v=ob3VwY4JyzE
  - Crisp Day 2022 abstract: https://www.crisp.se/?p=14902

**No Man's Sky**
- GDC 2017 talks:
  - Murray: https://www.youtube.com/watch?v=C9RyEiEzMiU and https://www.gamedeveloper.com/design/video-building-the-worlds-of-i-no-man-s-sky-i-using-math-s-
  - McKendrick: https://www.youtube.com/watch?v=sCRzxEEcO2Y, https://www.gdcvault.com/play/1024265/Continuous_World_Generation_in__No_Man_s_Sky_ and https://www.gamedeveloper.com/programming/video-how-continuous-world-generation-works-in-i-no-man-s-sky-i-
- nucl.ai 2015 write-up: https://procedural-generation.isaackarth.com/2016/06/22/building-a-galaxy-procedural-generation-in-no.html
- Meshing notes: https://github.com/Zylann/godot_voxel/issues/24 · 5.0 patch notes: https://www.nomanssky.com/worlds-part-i-update/
- Game-data structs (MBINCompiler): https://github.com/emoose/MBINCompiler/tree/master/MBINCompiler/Models/Structs (TkNoiseUberData, TkNoiseUberLayerData, TkVoxelGeneratorData, TkNoiseGridData, TkNoiseFeatureData, TkResourceDescriptorData, GcSolarSystemData). Parameter commentary: https://github.com/gistya/NoMansTerrain
- Seeds, addresses and creatures:
  - PlayStation Blog 2014: https://blog.playstation.com/2014/08/26/no-mans-sky-a-whole-universe-to-explore/
  - Portal address: https://nomanssky.miraheze.org/wiki/Portal_address
  - Game Informer 2014: https://gameinformer.com/b/features/archive/2014/12/24/a-look-at-no-mans-skys-creature-features.aspx
  - Wikipedia: https://en.wikipedia.org/wiki/Development_of_No_Man%27s_Sky

**General**
- Inigo Quilez: https://iquilezles.org/articles/fbm/ · https://iquilezles.org/articles/warp/ · https://iquilezles.org/articles/morenoise/
- Giliam de Carpentier, Scape procedural extensions: https://www.decarpentier.nl/scape-procedural-extensions
- libnoise RidgedMulti: https://github.com/qknight/libnoise/blob/master/src/module/ridgedmulti.cpp
- Red Blob Games: https://www.redblobgames.com/maps/terrain-from-noise/
- Parberry: https://ianparberry.com/research/tobler · https://jcgt.org/published/0004/02/01/
- H. T. Beyer, *Implementation of a method for hydraulic erosion* (TUM 2015): https://www.firespark.de/resources/downloads/implementation%20of%20a%20methode%20for%20hydraulic%20erosion.pdf
- Sebastian Lague erosion: https://github.com/SebLague/Hydraulic-Erosion/blob/master/Assets/Scripts/Erosion.cs
- J. Olsen, *Realtime Procedural Terrain Generation* (2004): http://web.mit.edu/cesium/Public/terrain.pdf
- Stefan Gustavson simplex: https://github.com/stegu/perlin-noise (`simplexnoise.pdf`, `src/simplexnoise1234.c`)
