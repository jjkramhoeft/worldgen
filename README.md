# Worldgen

Experiments in procedural world generation, inspired by Minecraft and No Man's Sky.

**Try it live: https://jjkramhoeft.github.io/worldgen/** (needs a browser with WebGL2).

## What's here

| Path | Contents |
|---|---|
| [`worldgen-lab/`](worldgen-lab/) | **Worldgen Lab**, an interactive sandbox with four world types: an infinite Minecraft-style terrain, an editable voxel world with caves, No Man's Sky-style planets, and a live erosion simulation. The in-app help (**H**) explains the mathematics and algorithms. See its [README](worldgen-lab/README.md) for controls, how it works and how to run it locally. |
| [`minecraft-vs-no-mans-sky-worldgen.md`](minecraft-vs-no-mans-sky-worldgen.md) | Notes on how Minecraft and No Man's Sky generate their worlds. |
| [`worldgen-lab/docs/RESEARCH.md`](worldgen-lab/docs/RESEARCH.md) | Detailed research notes behind the algorithms, with sources. |

## Running locally

You need Node 20 or newer.

```bash
cd worldgen-lab
npm install
npm run dev
```

Then open http://localhost:5199.

## Deployment

Every push to `main` runs the tests, builds `worldgen-lab` and publishes it to GitHub Pages (see [`.github/workflows/pages.yml`](.github/workflows/pages.yml)).
