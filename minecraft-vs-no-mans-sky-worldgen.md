# How Minecraft and No Man's Sky Generate Their Worlds

Both games use **procedural generation**: they don't store a world. They store a **seed** (a number) and a set of deterministic rules, and the same seed always produces the same world. Content is generated only when a player gets close to it, and only the player's changes are saved.

---

## Minecraft

### The seed and chunks
- Every world starts from a 64-bit **seed**.
- The world is divided into **chunks** (16×16 blocks, from Y = -64 to 320). A chunk is generated the first time a player comes near it. Once generated, it's saved to disk.

### Terrain: noise and density
- Since version 1.18, terrain comes from a **3D density function**. If the density at a point is positive, it's solid. If it's negative, it's air (or water below sea level).
- The density is built from layered **Perlin noise** (several octaves added together) and a set of large-scale parameters:
  - **Continentalness**: ocean, coast, or inland
  - **Erosion**: flat or mountainous
  - **Peaks & valleys / weirdness**: local ridges and dips
- **Splines** turn these noise values into terrain height and shape. That's how you get shapes noise alone wouldn't give you, like sharp cliffs and plateaus.

### Biomes
- Biomes use a **multi-noise** system. Each block position gets values for temperature, humidity, continentalness, erosion, weirdness and depth.
- The game picks the biome whose target point is **closest** to those values. Similar climates end up next to each other, so deserts rarely border snowy tundra.

### Generation stages
Each chunk goes through a pipeline of steps:
1. **Structure starts**: decide where villages, temples, strongholds and other structures begin, using a spacing grid seeded from the world seed
2. **Biomes**: assign biomes
3. **Noise**: fill the base shape in stone, water and air
4. **Surface**: replace the top layers with grass, sand, snow and so on, depending on the biome
5. **Carvers**: cut out classic caves and ravines
6. **Features**: place trees, ores, flowers, lakes and structure pieces
7. **Light and spawning**: calculate lighting and spawn the first mobs

Caves also come from noise. "Cheese," "spaghetti" and "noodle" caves are regions where the density function leaves open space, and **aquifers** fill them with water or lava at different levels.

### Data-driven
Most world generation (noise settings, biomes, features, structures) is defined in **JSON data packs**. Players can change how worlds generate without code mods.

---

## No Man's Sky

### A whole universe from one seed
- The universe has about **18 quintillion (2⁶⁴) planets**, and none of them are stored anywhere.
- Generation goes top-down: **galaxy → region → star system → planet → terrain, flora and fauna**. Each level gets its seed from the level above it. A planet's properties (size, biome type, weather, sentinel level, resources, colors) can therefore be worked out right away from its coordinates.

### Planet terrain
- Planets are **spheres**, not flat maps, and the terrain is **voxel-based**. Caves, overhangs and arches all fit in this model, and players can dig into it.
- Terrain shape comes from an advanced noise function that Hello Games calls "**Uber Noise**". It combines several techniques:
  - Layered fractal noise
  - **Domain warping**, which distorts the noise coordinates to make organic, swirly shapes
  - **Noise derivatives**, which smooth slopes and imitate erosion, so valleys and ridges look worn instead of random
- Terrain is generated in **levels of detail** as you approach. From orbit a planet is a coarse sphere. On the surface it becomes fine voxel chunks, which are turned into meshes on background threads.

### Creatures, plants and objects
- Flora, fauna, ships and buildings are built from **artist-made parts** combined by rules: body plans, swappable heads and limbs, color palettes and scale ranges.
- The planet's biome and climate limit what can appear, which keeps results plausible (mostly).

### Player changes
- Only **deltas** are stored: terrain edits, bases and discoveries. In multiplayer they're shared, so other players see your changes on top of the same generated planet.
- Later updates (for example *Worlds Part I & II*, 2024) reworked the generation pipeline and added more varied terrain, deeper oceans and new planet types. Updates like these can change existing planets, because the world is regenerated from rules rather than loaded from saved data.

---

## Side-by-side

| | Minecraft | No Man's Sky |
|---|---|---|
| **World shape** | Effectively infinite flat plane, finite height | Galaxies of spherical planets |
| **Unit of generation** | 16×16 chunk | Galaxy → system → planet → voxel region |
| **Core technique** | 3D density from Perlin noise + splines | Voxel density from "Uber Noise" (fractal noise, domain warping, derivatives) |
| **Biomes** | Nearest match in multi-noise climate space | One main biome/planet type per planet, with local variation |
| **Life and objects** | Hand-designed mobs and structures, placed by rules | Assembled from modular parts per planet |
| **Saved data** | Every generated chunk | Only player changes (deltas) |
| **Moddability** | JSON data packs | Not officially exposed |

## Shared principle

Both games treat the world as a **pure function of (seed, position)**. Because the result is deterministic, the world can be huge or nearly endless, generated only when needed, and identical for every player. The difference is scale: Minecraft makes one detailed, editable landscape, while No Man's Sky applies the same idea at the level of a universe.
