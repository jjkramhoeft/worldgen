/**
 * "How it works": the mathematics and algorithms behind every generator,
 * appended below the quick help. Loaded lazily (together with KaTeX) the first
 * time the help opens.
 *
 * Chapters are HTML with TeX between \( … \) (inline) and \[ … \] (display),
 * written with String.raw so backslashes need no escaping. <figure data-fig>
 * and <div data-table> placeholders are filled from helpFigures.ts.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { FIGURES, TABLES } from './helpFigures';

const tex = String.raw;

interface Chapter {
  id: string;
  title: string;
  html: string;
}

const MACROS: Record<string, string> = {
  '\\smoothstep': '\\operatorname{smoothstep}',
  '\\clamp': '\\operatorname{clamp}',
  '\\lerp': '\\operatorname{lerp}',
  '\\fract': '\\operatorname{fract}',
  '\\hash': '\\operatorname{hash}',
  '\\normalize': '\\operatorname{normalize}',
  '\\derive': '\\operatorname{derive}',
  '\\mixf': '\\operatorname{mix}',
};

const INTRO = tex`
<h3>How it works: the mathematics and algorithms</h3>
<p class="lede">Nothing in these worlds is stored. Every height, colour, cave and planet is computed on demand by pure functions of <b>(seed, position, settings)</b>. That one rule shapes the whole design: tiles can be generated in any order, on any worker thread, at any level of detail, and recomputed identically whenever they are needed again. Only your voxel edits are stored.</p>
<div class="doc-flow"><span>seed</span><i>→</i><span>hashes</span><i>→</i><span>noise</span><i>→</i><span>fractals</span><i>→</i><span>climate</span><i>→</i><span>splines</span><i>→</i><span>height</span><i>→</i><span>biome &amp; colour</span><i>→</i><span>mesh &amp; LOD</span><i>→</i><span>GPU</span></div>
<p class="lede">The chapters follow the data through this pipeline. Formulas use the names from the source files (shown like <code>terrain.ts</code>). The figures are not screenshots: they are computed live, as you scroll to them, by the same functions the generator uses, with the default settings and seed. Conventions: noise values lie in [−1, 1], heights are in metres (one voxel block is 1 m), \(\mathbf p\) is a sample position and \(s\) a seed.</p>
`;

const CHAPTERS: Chapter[] = [
  {
    id: 'doc-toolbox',
    title: 'Toolbox functions',
    html: tex`
<p>A handful of tiny functions do most of the blending, masking and interpolation in the code. Their shapes appear everywhere, so they are worth knowing first.</p>
<h5>Interpolation and clamping</h5>
\[ \lerp(a,b,t) = a + (b-a)\,t, \qquad \clamp(x,a,b) = \min\big(\max(x,a),\,b\big). \]
<h5>Smoothstep</h5>
<p>Most soft masks (coasts, snow, rock on cliffs, the island falloff, river banks) use the cubic Hermite step</p>
\[ t = \clamp\!\Big(\frac{x-e_0}{e_1-e_0},\,0,\,1\Big), \qquad \smoothstep(e_0,e_1,x) = t^2\,(3-2t). \]
<p>Its slope is zero at both ends, so a mask switches on and off without a visible kink. Swapping the edges (\(e_0 > e_1\)) gives a falling step: <code>smoothstep(0.86, 0.70, n_y)</code> turns flat ground (\(n_y\) near 1) into rock as the surface tilts.</p>
<h5>Quintic fade</h5>
<p>Lattice noise interpolates between grid points with Ken Perlin's 2002 fade curve</p>
\[ \phi(t) = 6t^5 - 15t^4 + 10t^3, \qquad \phi'(t) = 30\,t^2(t-1)^2 . \]
<p>Both \(\phi'\) and \(\phi''\) vanish at \(t = 0\) and \(t = 1\). Shading depends on the first derivative (through the surface normal), so a fade that is smooth up to the second derivative avoids the faint grid of creases a cubic fade leaves in lit terrain.</p>
<figure data-fig="toolbox"><figcaption>The three ramps on [0, 1]. Smoothstep and the quintic fade both start and end flat; the quintic is flatter at the ends and steeper in the middle.</figcaption></figure>
<h5>Bilinear and trilinear interpolation</h5>
<p>Inside a grid cell with fractional offsets \(u, v \in [0, 1]\):</p>
\[ f(u,v) = f_{00}\,(1-u)(1-v) + f_{10}\,u\,(1-v) + f_{01}\,(1-u)\,v + f_{11}\,u\,v . \]
<p>Erosion droplets use it to read height and slope between grid nodes. The voxel generator uses the 3D version (eight corners) to fill blocks from a coarse density lattice.</p>
<h5>sRGB and linear light</h5>
<p>Colours are written in sRGB, but lighting has to be computed in <i>linear</i> light, where adding two lights adds their energy. Vertex colours are converted with the sRGB transfer function</p>
\[ c_{\text{lin}} = \begin{cases} c / 12.92 & c \le 0.04045 \\ \big((c + 0.055)/1.055\big)^{2.4} & \text{otherwise,} \end{cases} \]
<p>and the renderer encodes the final image back to sRGB after tone mapping.</p>
`,
  },
  {
    id: 'doc-hash',
    title: 'Seeds and hashing',
    html: tex`
<p>Generation never calls <code>Math.random()</code>. All randomness is an integer hash of the seed and a position, so the same input gives the same output on every machine and in every order (<code>rng.ts</code>).</p>
<h5>From seed text to a number</h5>
<p>Numeric seeds are used as numbers; 64-bit values are folded to 32 bits with \(n \oplus (n \gg 32)\). Any other text is hashed with Java's <code>String.hashCode</code>, as in Minecraft:</p>
\[ h_0 = 0, \qquad h_{i+1} = (31\,h_i + c_i) \bmod 2^{32}. \]
<h5>The integer finalizer</h5>
<p><code>mix32</code> is Chris Wellons' <i>lowbias32</i>, found by a computer search for well-mixing integer hashes:</p>
<pre class="doc-code">x ^= x >>> 16;  x = x * 0x7feb352d;
x ^= x >>> 15;  x = x * 0x846ca68b;
x ^= x >>> 16;</pre>
<p>Multiplying by an odd constant and xor-ing with a right shift are both invertible modulo \(2^{32}\), so the whole function is a permutation of the 32-bit integers: no two inputs collide. Each step spreads bits across the word, so flipping one input bit flips each output bit with probability close to ½ (the <i>avalanche</i> property). That is what gives neighbouring lattice points unrelated random values.</p>
<h5>Hashing lattice points</h5>
<p>The noise functions hash integer coordinates the way FastNoiseLite does: each axis is multiplied by a large prime, the products are xor-ed with the seed, and the result is scrambled once more:</p>
\[ h = \big(s \oplus 501125321\,i \oplus 1136930381\,j \oplus 1720413743\,k\big)\cdot \texttt{0x27d4eb2d}, \qquad g = \big(h \oplus (h \gg 15)\big) \bmod 16 . \]
<p>\(g\) picks one of 16 gradient directions. Classic Perlin noise looks gradients up in a shuffled 256-entry table instead. That table makes the pattern repeat every 256 units and must be reshuffled for every seed; the hash never repeats and takes the seed directly.</p>
<h5>Deriving independent seeds</h5>
<p>Every layer, octave and object gets its own seed by hashing its parent's seed with small integers:</p>
\[ \derive(s;\, p_1, \ldots, p_k):\qquad h \leftarrow s, \qquad h \leftarrow \mixf\big(h \oplus \mixf(p_i + \texttt{0x9e3779b9})\big) \text{ for each } p_i . \]
<p><code>0x9e3779b9</code> is \(\lfloor 2^{32}/\varphi \rfloor\) (\(\varphi\) is the golden ratio); adding it keeps small inputs such as 0, 1 and 2 far apart before mixing. Continentalness uses \(\derive(s; 1)\), erosion \(\derive(s; 2)\) and so on: a new seed changes every layer at once, yet the layers stay independent of each other. Planets chain the same function: galaxy → region → system → planet.</p>
<h5>Uniform numbers and sequences</h5>
<p>A hash becomes a uniform number with \(u = h / 2^{32} \in [0, 1)\). When a generator needs many numbers in a row (a planet's parameters, a tree's shape), it seeds <i>mulberry32</i>, a tiny generator whose 32-bit state advances by the constant <code>0x6d2b79f5</code> each step and is then scrambled.</p>
<h5>Jittered grids</h5>
<p>Trees and plants are placed with one candidate per grid cell of size \(L\), jittered inside its cell (Worley noise places its feature points, and so the planets' craters, the same way):</p>
\[ \mathbf x_{ij} = \big(i + u_1,\; j + u_2\big)\,L, \qquad u_k = \hash(i,\, j,\, s + k) / 2^{32}. \]
<p>Further hashes decide whether the candidate is kept, which species it is, its size and rotation. Points never crowd closer than the grid allows yet look irregular, a cheap stand-in for blue-noise sampling. Because every decision depends only on its own cell, a tile can place exactly the objects that touch it, and its neighbours agree at the border.</p>
`,
  },
  {
    id: 'doc-noise',
    title: 'Noise',
    html: tex`
<p>Noise is randomness that is smooth: nearby points get similar values, distant points unrelated ones. Every noise in <code>noise.ts</code> stores random data on an integer lattice and interpolates between the lattice points. They differ in what they store and how they interpolate.</p>
<figure data-fig="noise"><figcaption>The five base noises over six lattice units, from the same seed (black = −1, white = +1). Simplex noise uses more of the range than gradient noise (standard deviation about 0.54 against 0.32), so it looks more contrasted.</figcaption></figure>
<h5>Value noise</h5>
<p>Each lattice point gets a random value \(r_{ij} \in [-1, 1]\). With \(f_x, f_y\) the fractional position inside the cell, \(u = \phi(f_x)\) and \(v = \phi(f_y)\):</p>
\[ n = r_{00} + (r_{10} - r_{00})\,u + (r_{01} - r_{00})\,v + k_3\,uv, \qquad k_3 = r_{00} - r_{10} - r_{01} + r_{11}, \]
\[ \frac{\partial n}{\partial x} = \phi'(f_x)\,\big(r_{10} - r_{00} + k_3\,v\big), \qquad \frac{\partial n}{\partial y} = \phi'(f_y)\,\big(r_{01} - r_{00} + k_3\,u\big). \]
<p>It is cheap but blocky: the extremes sit on the lattice points, so the grid shows through.</p>
<h5>Gradient (Perlin) noise</h5>
<p>Each lattice point stores a random unit gradient \(\mathbf g_{ij}\) instead. The value blends the four planes \(n_{ij} = \mathbf g_{ij}\cdot(\mathbf p - \mathbf c_{ij})\) through the corners \(\mathbf c_{ij}\):</p>
\[ n = n_{00} + k_1 u + k_2 v + k_3 uv, \qquad k_1 = n_{10} - n_{00},\quad k_2 = n_{01} - n_{00},\quad k_3 = n_{00} - n_{10} - n_{01} + n_{11}. \]
<p>The noise is zero at every lattice point, and its hills and valleys fall between them, which hides the grid much better. Differentiating the same expression with the product rule gives the exact gradient:</p>
\[ \nabla n = \mathbf g_{00} + u\,(\mathbf g_{10} - \mathbf g_{00}) + v\,(\mathbf g_{01} - \mathbf g_{00}) + uv\,(\mathbf g_{00} - \mathbf g_{10} - \mathbf g_{01} + \mathbf g_{11}) + \begin{pmatrix} \phi'(f_x)\,(k_1 + k_3 v) \\ \phi'(f_y)\,(k_2 + k_3 u) \end{pmatrix}. \]
<p>The 2D gradients are 16 unit vectors at angles \((k + \tfrac12)\cdot 22.5^\circ\). None points along an axis, which avoids axis-aligned streaks. In 3D they are Perlin's 12 cube-edge directions, padded to 16.</p>
<h5>Simplex noise (the default)</h5>
<p>Simplex noise replaces the square grid with triangles (tetrahedra in 3D). Skewing the input by \(F_2 = \tfrac{\sqrt3 - 1}{2}\) maps the triangle grid onto a square grid, where <code>floor</code> finds the cell; unskewing by \(G_2 = \tfrac{3 - \sqrt3}{6}\) gives the offsets \(\mathbf d_k\) from the three corners. Each corner adds a radial bump times its gradient plane:</p>
\[ n(\mathbf p) = \sum_{k=0}^{2} \big(r^2 - \lVert\mathbf d_k\rVert^2\big)_+^{4}\,\big(\mathbf g_k\cdot\mathbf d_k\big), \qquad r^2 = \tfrac12 , \]
\[ \nabla n = \sum_{k} \Big[-8\,\big(r^2 - \lVert\mathbf d_k\rVert^2\big)^{3}\,(\mathbf g_k\cdot\mathbf d_k)\,\mathbf d_k + \big(r^2 - \lVert\mathbf d_k\rVert^2\big)^{4}\,\mathbf g_k\Big]. \]
<p>Only 3 corners are visited instead of 4 (4 instead of 8 in 3D), there are no direction-dependent artifacts from a square lattice, and the derivative is exact and cheap. With \(r^2 = \tfrac12\) each bump reaches zero exactly at the far side of its simplex, so the field is continuous. (Gustavson's widely copied 3D code uses 0.6, which leaves faint seams.)</p>
<p>The raw sums are multiplied by calibration constants (×99.2 for 2D simplex, ×75.2 for 3D and so on) so every noise spans roughly [−1, 1]. The unit tests check the ranges, and that every analytic derivative matches a finite difference to three decimals. One measurement is used later: the mean gradient length is about 3.3 per lattice unit for 2D simplex noise and 2.8 for 3D.</p>
<h5>Cellular (Worley) noise</h5>
<p>Each lattice cell holds one feature point, jittered randomly inside it. For a sample point the code scans the 3×3 (3×3×3) surrounding cells and keeps the distances to the nearest and second-nearest feature points, \(F_1 \le F_2\):</p>
\[ \text{worley} = \max(-1,\; 1 - 1.8\,F_1), \qquad \text{cells} = 1 - 2\sqrt{\min\!\big((F_2 - F_1)/1.25,\; 1\big)} . \]
<p><i>worley</i> makes round bumps (or, inverted, pits); <i>cells</i> is high along the borders between cells, where \(F_1 = F_2\), and its square root evens out a lopsided distribution. Neither has a cheap analytic derivative, so the fractal code uses central differences (\(\varepsilon = 0.01\)) when it needs one. On planets, the 3D version also returns a hash of the nearest feature point, which turns every cell into an individual crater.</p>
`,
  },
  {
    id: 'doc-fractal',
    title: 'Fractal noise',
    html: tex`
<p>A single noise has one feature size. Real terrain has detail at every scale: continents, ranges, ridges, boulders. Fractal noise (<code>fractal.ts</code>) sums copies of a noise at increasing frequencies, called <i>octaves</i>, each fainter than the last.</p>
<h5>Fractional Brownian motion (fBm)</h5>
\[ F(\mathbf p) = \frac{1}{\sum_o a_o} \sum_{o=0}^{N-1} a_o\; n_o\big(f_o\, R_o\, \mathbf p\big), \qquad f_o = \frac{\lambda^{o}}{\text{scale}}, \quad a_o = g^{\,o}. \]
<ul>
<li><b>Scale</b> is the wavelength of the first octave in world units. The <b>lacunarity</b> \(\lambda\) (usually 2) multiplies the frequency per octave, and the <b>gain</b> \(g\) (usually ½) multiplies the amplitude.</li>
<li>Dividing by \(\sum a_o\) keeps \(F\) in [−1, 1] whatever the number of octaves, so adding octaves adds detail without changing the overall height.</li>
<li>Each octave has its own seed and is rotated by \(R_o\), a rotation by \(o \times 36.87^\circ\) (the angle of the 3-4-5 triangle). Otherwise the lattice directions of all octaves line up and faint horizontal and vertical streaks appear. 3D layers apply Inigo Quilez's orthonormal 3×3 matrix once more per octave.</li>
</ul>
<figure data-fig="octaves"><figcaption>A 1D slice through four octaves of simplex noise and their normalised sum. Each octave doubles the frequency and halves the amplitude; the sum keeps the large shapes of the first octave and the roughness of the last.</figcaption></figure>
<p>Because each octave doubles the frequency and halves the amplitude, amplitude is proportional to wavelength. In general the amplitude falls as \(f^{-H}\), with the <i>Hurst exponent</i></p>
\[ H = -\frac{\ln g}{\ln \lambda}, \qquad D = 3 - H , \]
<p>where \(D\) is the fractal dimension of the surface. The default \(g = \tfrac12\), \(\lambda = 2\) gives \(H = 1\) and \(D = 2\): smooth, self-similar terrain. A gain of 0.6 gives \(H \approx 0.74\) and \(D \approx 2.26\), which looks visibly rougher. Measurements of real elevation data mostly land between \(D \approx 2.1\) and 2.5, depending on the method and the range of scales.</p>
<h5>Billow</h5>
\[ F_{\text{billow}} = \frac{1}{\sum a_o} \sum_o a_o\,\big(2\,|n_o| - 1\big). \]
<p>Folding each octave at zero turns smooth waves into rounded humps separated by sharp creases: hills, dunes, cumulus clouds.</p>
<h5>Ridged multifractal (Musgrave)</h5>
\[ s_o = \big(1 - |n_o|\big)^2\, w_o, \qquad w_0 = 1, \quad w_{o+1} = \clamp(2\,s_o,\, 0,\, 1), \qquad F = 2\,\frac{\sum_o a_o\, s_o}{\sum_o a_o} - 1 . \]
<p>\(1 - |n|\) turns the zero lines of the noise into sharp crests, and squaring narrows them. The weight \(w\) feeds each octave into the next, so fine detail only grows on existing ridges while valleys stay smooth. Because roughness varies from place to place, this is a <i>multi</i>fractal, and a classic for mountain chains.</p>
<h5>Derivative "erosion" fBm (Inigo Quilez)</h5>
<p>This variant sums the gradients of the octaves so far and uses the total to damp later octaves:</p>
\[ \mathbf d \leftarrow \mathbf d + R_o^{\mathsf T}\,\nabla n_o, \qquad F \mathrel{+}= \frac{a_o\, n_o}{1 + k\,\lVert\mathbf d\rVert^2}. \]
<p>Where the large shapes are steep, \(\lVert\mathbf d\rVert\) is large and the fine octaves are suppressed: slopes stay smooth and flats stay rough, a cheap imitation of hillsides worn down by water. As in Quilez's original, each gradient is measured in its octave's own units (not multiplied by the frequency), and \(R_o^{\mathsf T}\) rotates it back to world axes. \(k\) is the <b>slope erosion</b> slider.</p>
<h5>Uber noise (No Man's Sky style)</h5>
<p>Hello Games' terrain noise exposes six parameters (in its game data, <code>TkNoiseUberData</code>). Its formulas are not public, so <code>fractal.ts</code> rebuilds them from the techniques above. For each octave, with \(n\) its raw value and \(\mathbf d\) the summed gradient:</p>
<ol>
<li><b>Sharpness</b> \(\sigma \in [-1, 1]\) morphs the octave towards ridged (\(1 - 2|n|\)) or billowed (\(2|n| - 1\)):
\[ v = \begin{cases} n + \sigma\,\big(1 - 2|n| - n\big) & \sigma > 0, \\ n + |\sigma|\,\big(2|n| - 1 - n\big) & \sigma < 0. \end{cases} \]</li>
<li><b>Slope erosion</b>: \(\delta_{\text{slope}} = 1/\big(1 + k_s \lVert\mathbf d\rVert^2\big)\), as in the IQ variant, using the raw (continuous) gradient.</li>
<li><b>Altitude erosion</b>: with \(\bar h\) the normalised sum so far, \(\delta_{\text{alt}} = 1 - k_a \cdot \tfrac12\big(1 - \clamp(\bar h, -1, 1)\big)\). Low ground loses fine detail, giving flat valley floors under rough peaks.</li>
<li><b>Ridge erosion</b>: \(\bar c\), the amplitude-weighted mean of \(1 - |n|\) so far, is close to 1 on crests. \(\delta_{\text{ridge}} = 1 - k_r\,\smoothstep(0.55,\, 0.95,\, \bar c)\) softens the detail on ridgelines.</li>
<li><b>Accumulate</b>: \(F \mathrel{+}= a_o\, v\; \delta_{\text{slope}}\, \delta_{\text{alt}}\, \delta_{\text{ridge}}\).</li>
<li><b>Feature amplification</b>: \(a_{o+1} = a_o\, g\, \max(0,\; 1 + k_f\, v)\). Where this octave is high, the next one is stronger, so features breed features.</li>
<li><b>Perturb</b>: \(\mathbf p \leftarrow \mathbf p + \nabla n \cdot \dfrac{0.25\, k_p}{f_o\,(o + 1)}\). Shifting the domain along the gradient by a fraction of the wavelength bends later octaves around earlier ones, which gives swirled, organic shapes.</li>
</ol>
<p>The result is divided by the sum of all the octave amplitudes, including any skipped for level of detail (see the next chapter).</p>
<figure data-fig="sharpness"><figcaption>The sharpness morph applied to one octave value. Positive σ folds the octave into a ridge (peak at n = 0); negative σ into a billow (crease at n = 0).</figcaption></figure>
<figure data-fig="fractals"><figcaption>The five fractal types on the same seed, hill-shaded, with the detail settings of the default terrain (7 octaves, sharpness 0.35, slope erosion 0.6, altitude erosion 0.3, ridge erosion 0.15, perturb 0.2, amplification 0.15). Each tile is stretched to its own height range. Slope erosion damps the fine octaves so strongly that the last two vary much less: their standard deviation is about a third (IQ erosion) and a fifth (uber) of plain fBm's.</figcaption></figure>
<h5>Domain warping</h5>
<p>Domain warping (also from Quilez) samples a noise at a position displaced by other noises:</p>
\[ \mathbf q = \big(F_a(\mathbf p),\; F_b(\mathbf p + \mathbf o_1)\big), \qquad \mathbf r = \big(F_c(\mathbf p + k\mathbf q + \mathbf o_2),\; F_d(\mathbf p + k\mathbf q + \mathbf o_3)\big), \qquad \mathbf p' = \mathbf p + k\,\mathbf r . \]
<p>With one iteration the result is simply \(\mathbf p + k\mathbf q\). The offsets \(\mathbf o_1 = (5.2, 1.3)\), \(\mathbf o_2 = (1.7, 9.2)\) and \(\mathbf o_3 = (8.3, 2.8)\), times the warp scale, only decorrelate the components. \(k\) is the warp <b>strength</b> in metres (260 m by default). The terrain warps the input of <i>all</i> climate noises, so coastlines, mountain ranges and biome borders bend together.</p>
<figure data-fig="warp"><figcaption>The same fBm without warping, warped once and warped twice. Each pass moves every sample point by the values of two other noises, so the pattern flows and folds into marbled shapes.</figcaption></figure>
`,
  },
  {
    id: 'doc-aliasing',
    title: 'Level of detail for noise',
    html: tex`
<p>A mesh or an image samples the noise on a grid. By the Nyquist–Shannon sampling theorem, a grid with spacing \(\Delta\) can only represent frequencies below</p>
\[ f_{\max} = \frac{1}{2\Delta}. \]
<p>Finer octaves do not simply disappear when sampled too coarsely: they <i>alias</i> into random-looking spikes that change whenever the grid moves. On distant tiles this shows up as glittering, crawling mountain tops.</p>
<p>Every sampler therefore accepts the caller's \(f_{\max}\) and weights octave \(o\) by</p>
\[ w(f_o) = \begin{cases} 1 & f_o \le f_{\max}/2, \\ 2 - 2 f_o / f_{\max} & f_{\max}/2 < f_o < f_{\max}, \\ 0 \;\text{(not computed)} & f_o \ge f_{\max}. \end{cases} \]
<p>The linear fade avoids a visible pop when a tile's detail level changes. The normaliser \(\sum a_o\) still counts every octave, so dropping fine octaves removes detail but never moves or rescales the large shapes: a distant tile has exactly the same continents as a near one, only smoother. Skipping octaves also makes coarse tiles cheaper, since each LOD level halves \(f_{\max}\) and drops another octave.</p>
<figure data-fig="octaveFade"><figcaption>The octave weight as a function of its frequency, relative to the Nyquist limit of the sampling grid.</figcaption></figure>
<p>The same limit is used wherever noise is sampled on a grid: terrain tiles (\(\Delta\) is the vertex spacing; in noise units \(f_{\max}\) is the horizontal scale divided by \(2\Delta\)), the minimap and world map (\(\Delta\) is the size of a pixel in metres), the heightmap export, and planet tiles (\(\Delta\) is measured on the unit sphere). The water shader does the same for its waves by fading their normals with distance.</p>
<div class="doc-note try"><b>Try it.</b> Set <i>Color by → LOD level</i> and fly low. Each colour band is one tile size, and each band carries roughly one octave less than the band inside it.</div>
`,
  },
  {
    id: 'doc-terrain',
    title: 'Terrain height',
    html: tex`
<p><code>terrain.ts</code> turns a position \((x, z)\) into a height in metres. It follows the structure of Minecraft's 1.18 <i>noise router</i>: a few large climate noises describe <i>what kind of place</i> a point is, and splines turn that description into height. A No Man's Sky-style detail layer adds the small-scale shape.</p>
<h5>1. Climate noises</h5>
<p>Coordinates are divided by the horizontal scale \(s_h\) and, by default, domain-warped. Then five fBm fields are sampled:</p>
\[ v = \clamp\big(A \cdot F(\mathbf p) + b,\; -1,\; 1\big). \]
<div data-table="climate"></div>
<p>Averaging octaves narrows the distribution (the central limit theorem at work): the raw fBm has a standard deviation of only about 0.33. The contrast \(A\) stretches it, to about 0.52 for continentalness and erosion and 0.44 for the others, so that thresholds near ±0.5 are actually reached; only 3–4 % of continentalness and erosion samples are clipped at ±1. The offset \(b\) shifts a whole layer: more land, a warmer world, and so on. Continentalness and erosion use Minecraft's 2048-block wavelength.</p>
<h5>2. Island mask (optional)</h5>
<p>With \((\hat x, \hat z) = (x, z) / \text{radius}\), the distance \(d\) is Euclidean \(\sqrt{\hat x^2 + \hat z^2}\), Chebyshev \(\max(|\hat x|, |\hat z|)\) or the "square bump" \(\sqrt{1 - (1 - \hat x^2)(1 - \hat z^2)}\). Continentalness is pulled towards −1 (deep ocean) outside the island:</p>
\[ m = 1 - \smoothstep(1 - \text{falloff},\; 1,\; d), \qquad C \leftarrow -1 + (C + 1)\, m . \]
<h5>3. Peaks and valleys</h5>
<p>Minecraft folds the weirdness \(W\) into <i>peaks and valleys</i>:</p>
\[ \text{PV} = 1 - \big|\, 3\,|W| - 2 \,\big| . \]
<p>\(W = 0\) gives −1 (valley floors, where the rivers run), \(|W| = \tfrac23\) gives +1 (peaks) and \(|W| = 1\) gives 0. One smooth noise thus produces two interleaved sets of features: lines of valleys and lines of peaks. The code uses a soft absolute value \(|v|_\varepsilon = \sqrt{v^2 + \varepsilon^2} - \varepsilon\) with \(\varepsilon = 0.08\), so the folds are sharp but not infinitely so. A true \(|\cdot|\) has unlimited frequency content and aliases into saw-tooth crests.</p>
<p>Because \(|v|_\varepsilon \approx |v| - \varepsilon\) away from zero, the soft fold is also slightly shifted: the peaks move out from \(|W| = \tfrac23\) to about 0.74, valley floors bottom out at −0.92 instead of −1, and \(|W| = 1\) maps to about 0.31 instead of 0. The biome thresholds still work, since the valley level starts at −0.85.</p>
<figure data-fig="pv"><figcaption>The peaks-and-valleys fold. The rounded version (solid) is what the generator uses.</figcaption></figure>
<h5>4. Splines</h5>
<p>Three editable curves (<kbd>K</kbd>) turn the climate values into shape:</p>
<ul>
<li>\(S_C\): continentalness → base height in metres (deep ocean −32 m, the coast near 0, far inland +60 m).</li>
<li>\(S_E\): erosion → mountain factor in [0, 1] (low erosion means mountainous).</li>
<li>\(S_{PV}\): peaks and valleys → peak multiplier (negative in valleys).</li>
</ul>
<p>They are monotone cubic Hermite splines (Fritsch–Carlson). On the interval \([x_i, x_{i+1}]\) of width \(h\), with \(t = (x - x_i)/h\) and tangents \(m_i\):</p>
\[ S(x) = h_{00}(t)\, y_i + h_{10}(t)\, h\, m_i + h_{01}(t)\, y_{i+1} + h_{11}(t)\, h\, m_{i+1}, \]
\[ h_{00} = 2t^3 - 3t^2 + 1, \quad h_{10} = t^3 - 2t^2 + t, \quad h_{01} = -2t^3 + 3t^2, \quad h_{11} = t^3 - t^2 . \]
<p>The tangents start as the mean of the neighbouring secant slopes \(\delta_i = (y_{i+1} - y_i)/(x_{i+1} - x_i)\). They are set to 0 at local extrema (where the secants change sign) and on flat segments. Then, if \(\alpha = m_i/\delta_i\) and \(\beta = m_{i+1}/\delta_i\) satisfy \(\alpha^2 + \beta^2 > 9\), both are scaled by \(\tau = 3/\sqrt{\alpha^2 + \beta^2}\). That condition guarantees each piece is monotone, so the curve never overshoots between control points, and dragging one point in the editor never creates a bump somewhere else. Beyond the first and last points the curve stays constant. (Minecraft's splines are cubic Hermite too, with hand-set derivatives and splines nested inside splines.)</p>
<figure data-fig="splines"><figcaption>The default splines with their control points. The dashed lines in the first plot are Minecraft's continentalness zones: deep ocean, ocean, coast, near-, mid- and far-inland.</figcaption></figure>
<h5>5. Combining into height</h5>
\[ h = S_C(C) \;+\; \underbrace{\smoothstep(-0.15,\; 0.3,\; C)}_{\text{inland}} \cdot \clamp\big(S_E(E),\, 0,\, 1\big) \cdot H_m \cdot \Big((1 - \rho) + \rho\, S_{PV}(\text{PV})\Big). \]
<p>\(H_m\) is the mountain height (200 m) and \(\rho\) the ridge share (0.55). Continentalness sets the base level, the inland ramp keeps coasts gentle, low erosion raises a broad massif, and peaks and valleys carve it: \(S_{PV} = 1\) on peaks keeps the full massif, and its negative values in valleys cut below it.</p>
<p class="doc-ex"><b>Worked example.</b> At a mid-inland point (\(C = 0.3\)) with strong mountains (\(E = -0.78\)) on a line of peaks (\(\text{PV} = 0.7\)), the splines give \(S_C = 22\) m, \(S_E = 0.92\) and \(S_{PV} = 0.75\), and the inland ramp is 1:</p>
\[ h = 22 + 1 \cdot 0.92 \cdot 200 \cdot (0.45 + 0.55 \cdot 0.75) \approx 22 + 158.7 \approx 181\ \text{m}. \]
<h5>6. Detail, redistribution and terraces</h5>
<p>The detail layer (uber noise by default: 7 octaves from a 420 m wavelength) is added, weighted towards mountains by the mountain bias \(\beta\):</p>
\[ h \mathrel{+}= U(\mathbf p)\; A_d\, \big(1 - \beta + \beta M\big), \qquad A_d = 38\ \text{m}, \quad \beta = 0.75, \quad M = \clamp\big(S_E(E), 0, 1\big). \]
<p><b>Redistribution</b> (from Red Blob Games) reshapes land with a power curve, where \(h_s\) is the sea level and \(R = H_m + 80\) m:</p>
\[ h' = h_s + R \left(\frac{h - h_s}{R}\right)^{\gamma}. \]
<p>For \(\gamma > 1\), heights below \(R\) shrink more than high ones: flatter lowlands, sharper peaks.</p>
<p><b>Terraces</b> quantise height into steps of \(\Delta = (H_m + 60)/n\) with soft risers:</p>
\[ k = \frac{h - h_s}{\Delta}, \qquad h_t = h_s + \Big(\lfloor k \rfloor + \smoothstep\big(\tfrac12 - \sigma,\; \tfrac12 + \sigma,\; k - \lfloor k \rfloor\big)\Big)\Delta, \qquad h \leftarrow \lerp(h,\, h_t,\, \text{strength}). \]
<p>A small smoothness \(\sigma\) gives crisp mesas; at \(\sigma = \tfrac12\) the steps almost disappear.</p>
<h5>7. Rivers</h5>
<p>Rivers follow \(W \approx 0\), the valley floors of peaks and valleys, as in Minecraft:</p>
\[ r = \Big(1 - \smoothstep\big(w,\; w + b,\; |W|\big)\Big) \cdot \smoothstep(-0.26,\; -0.12,\; C), \qquad h \leftarrow h + (h_{\text{bed}} - h)\, r \quad \text{if } h > h_{\text{bed}} . \]
<p>\(w = 0.03\) is the river half-width and \(b = 0.09\) the bank width, both in noise units, and the bed lies 5 m below sea level. The second factor fades the rivers out towards the ocean. The zero set of a smooth 2D noise consists of continuous curves that never simply stop, so rivers form long, connected networks. They are level sets, though, not flow: they do not know which way is downhill. For real water flow, see the Erosion chapter.</p>
<h5>8. Scale and statistics</h5>
<p>Finally \(h \leftarrow s_v h\) (vertical scale). With the default settings and seed, about 54 % of the surface is land. The median height is about 5 m, the 90th percentile 91 m and the 99th percentile 186 m; the highest of 40 000 random samples over a 60 km square was 257 m.</p>
<figure data-fig="climate"><figcaption>An 8 × 8 km square around the origin of the default world, rendered by the world map's own code: the climate inputs (blue = −1, red = +1), the biomes they select and the shaded relief they produce.</figcaption></figure>
`,
  },
  {
    id: 'doc-biomes',
    title: 'Biomes and colour',
    html: tex`
<p>Every column gets a biome from its climate sample (<code>biomes.ts</code>). Three classifiers are available under <i>Biomes</i>.</p>
<h5>Minecraft-style multi-noise</h5>
<p>Each climate value is first quantised into a <i>level</i> with Minecraft's thresholds from <code>OverworldBiomeBuilder</code>:</p>
<div data-table="levels"></div>
<p>The classifier then applies rules in order, and the first match wins:</p>
<ol>
<li><b>Under water</b> (\(h < h_s\)): a river if \(r > 0.5\) and \(C > -0.19\); otherwise an ocean chosen by temperature level (frozen, cold, normal, lukewarm, warm), deep if it is more than 28 m down or \(C < -0.455\).</li>
<li><b>River banks</b>: \(r > 0.6\) and less than 2 m above the sea.</li>
<li><b>Mushroom fields</b>: \(C < -0.9\), islands far out at sea.</li>
<li><b>Shores</b> below the beach height (3 m) where \(C < 0\): stony shore on rugged coasts (erosion level ≤ 2 and PV level ≥ 2), otherwise snowy beach, desert or beach by temperature.</li>
<li><b>Peaks</b>: PV level 4 with erosion level ≤ 1, or anything above the peak height (170 m). Jagged or frozen peaks when cold, stony peaks when warm, badlands when hot.</li>
<li><b>Slopes and plateaus</b>: PV level ≥ 3 with erosion level ≤ 2. Snowy slopes, grove, meadow, savanna plateau or badlands by temperature.</li>
<li><b>Special terrain</b>: hot, raised ground with little erosion becomes badlands; windswept, eroded high ground far inland (erosion level 5) becomes windswept hills or savanna; the flattest land near the sea (erosion level 6) becomes swamp or mangrove swamp.</li>
<li><b>Everything else</b> is a <i>middle biome</i>, looked up by temperature and humidity level. Where \(W > 0\) a variant replaces some entries (ice spikes, sunflower plains and so on), just as Minecraft uses the sign of weirdness.</li>
</ol>
<div data-table="middle"></div>
<h5>Whittaker</h5>
<p>The Whittaker classifier uses a temperature–moisture diagram like the one ecologists draw for real biomes. Temperature first drops with altitude (one unit per 180 m), and humidity is cut into five equal bins:</p>
\[ T' = T - \frac{\max(0,\; h - h_s)}{180}, \qquad \text{column} = \big\lfloor 2.5\,(H + 1) \big\rfloor . \]
<div data-table="whittaker"></div>
<p><b>Height bands</b> simply slice the height: deep ocean below −25 m, then ocean, beach, plains (up to 45 m), forest (100 m), taiga (150 m), stony peaks and finally snowy slopes above the peak height.</p>
<h5>Natural colouring</h5>
<p><code>shading.ts</code> paints each vertex from its biome and geometry. Slope enters as \(n_y = \cos\theta\), the vertical part of the unit surface normal:</p>
<ul>
<li><b>Rock</b> blends in with \(\smoothstep(0.86,\, 0.70,\, n_y)\): it starts at 31° and is complete at 46°. In badlands the threshold is lower (14° to 35°), and the rock colour comes from hashing \(\lfloor h/4 \rfloor\) into a palette, which gives horizontal 4 m strata.</li>
<li><b>Snow</b> lies above a snow line that depends on temperature, \(h_{\text{snow}} = (L + 120\,T)\, s_v\) with \(L = 150\) m, and only where the ground is flat enough to hold it:
\[ \text{snow} = \smoothstep\big(h_{\text{snow}},\; h_{\text{snow}} + 35,\; h - h_s\big) \cdot \smoothstep(0.62,\; 0.82,\; n_y). \]
Snow thins out on slopes between 35° and 52°.</li>
<li><b>Wet sand</b>: within 0.9 m above the sea the colour darkens by up to 18 %.</li>
<li><b>Under water</b> the ground is mixed towards a blue-green by \(0.65 \cdot \smoothstep(0, 30\ \text{m}, \text{depth})\).</li>
<li><b>Variation</b>: two octaves of value noise modulate brightness, \(k = 1 + 0.07\, V(\mathbf x/23) + 0.035\, V(\mathbf x/4.7)\), so large areas are not one flat colour.</li>
</ul>
<p><b>Hue shift</b> (for alien palettes) rotates every colour about the grey axis \((1, 1, 1)/\sqrt3\) of RGB space, using Rodrigues' rotation formula. With \(c = \cos\theta\), \(k = (1 - c)/3\) and \(q = \sin\theta / \sqrt3\):</p>
\[ M_\theta = \begin{pmatrix} c + k & k - q & k + q \\ k + q & c + k & k - q \\ k - q & k + q & c + k \end{pmatrix}. \]
<p>Greys stay grey and \(r + g + b\) is preserved, so brightness barely changes while the hue turns. <b>Saturation</b> scales each colour's distance from its luminance, \(\mathbf c' = Y + s\,(\mathbf c - Y)\), with \(Y = 0.2126\, r + 0.7152\, g + 0.0722\, b\) (the Rec. 709 weights).</p>
<p><b>Water</b> colour and opacity follow the depth \(d\) below the sea surface: the colour moves from shallow to deep with \(\smoothstep(0, 22\ \text{m}, d)\), and the opacity rises from 0.3 at the shoreline to its full value at a depth of 7 m.</p>
`,
  },
  {
    id: 'doc-lod',
    title: 'Meshes, LOD and streaming',
    html: tex`
<h5>Tiles</h5>
<p>The terrain is drawn as square tiles of \(N \times N\) quads (\(N = 64\)), that is \((N + 1)^2\) vertices with spacing \(\Delta = \text{size}/N\). Each tile samples an \((N + 3)^2\) grid, one sample wider on every side, so the normals along its edges use the same neighbours as the adjacent tile and the lighting has no seams. Normals come from central differences (<code>terrainMesh.ts</code>):</p>
\[ \mathbf n \propto \big(h_{i-1,j} - h_{i+1,j},\;\; 2\Delta,\;\; h_{i,j-1} - h_{i,j+1}\big), \]
<p>the cross product of the two tangent vectors \((2\Delta,\; h_{i+1,j} - h_{i-1,j},\; 0)\) and \((0,\; h_{i,j+1} - h_{i,j-1},\; 2\Delta)\).</p>
<p>Where a fine tile meets a coarse one, the fine tile's extra edge vertices do not lie on the coarse tile's straight edge, which would open small cracks. Instead of stitching the meshes together, every tile has a <b>skirt</b>: its border vertices are duplicated and pushed down by \(3\Delta + 1\) m, forming a curtain that fills any crack. All tiles of the same resolution share one index buffer.</p>
<h5>The quadtree</h5>
<p>Tiles form a quadtree: each node can split into four children of half its size (<code>QuadtreeLod.ts</code>). The smallest tile is \(N \cdot \Delta_{\min} = 64\) m across, and for view distance \(R\) the root level is \(L_r = \clamp\big(\lceil \log_2(R/64) \rceil - 1,\, 1,\, 12\big)\), so the default 4 km view uses 2048 m roots (level 5). Every frame the tree is walked from the roots, and a node splits when</p>
\[ \text{level} > 0 \quad\text{and}\quad d\big(\text{camera},\, \text{node box}\big) < \lambda\, s , \]
<p>where \(s\) is the node size, \(\lambda\) the LOD factor (2), and the box spans the tile's square and its height range (known from the last mesh generated for it).</p>
<p><b>Why this gives constant detail on screen.</b> A node of size \(s\) is drawn only if it does not split (\(d \ge \lambda s\)) and its parent did (\(d < 2\lambda s\)). A triangle edge of length \(s/N\) at that distance covers an angle between</p>
\[ \frac{s/N}{2\lambda s} = \frac{1}{2\lambda N} \qquad\text{and}\qquad \frac{1}{\lambda N} \;\text{radians}, \]
<p>whatever \(s\) is. At 1080p with a 60° field of view (about 935 pixels per radian), that is 3.7 to 7.3 pixels per triangle edge, near or far. Doubling \(\lambda\) halves the triangles on screen and quadruples their number.</p>
<figure data-fig="quadtree"><figcaption>The tiles the default settings choose for a camera 120 m up, over ground that rises to 60 m (white dot), coloured like <i>Color by → LOD level</i>. The dashed circle is the 4 km view distance.</figcaption></figure>
<h5>Streaming without holes</h5>
<ul>
<li>Leaves without a mesh are requested from the worker pool. While any child of a split node is missing, the parent's cached mesh is drawn instead, so the ground never has holes.</li>
<li>When a setting changes, every node keeps its old mesh until the new version arrives. Results carry the settings version, and an older result that arrives late is discarded.</li>
<li>The pool runs \(\clamp(\text{cores} - 1,\, 2,\, 8)\) workers. A job's priority is \(d/s\), plus 4 if the node already shows an older mesh, and it is <i>re-evaluated</i> each time a worker becomes free, so the queue follows the moving camera. Jobs whose node is no longer wanted are dropped before they start. Results come back as typed arrays, transferred without copying.</li>
<li>Up to 600 nodes are cached. Beyond that, the least recently used invisible nodes are freed until 80 % remain.</li>
</ul>
<h5>Vegetation</h5>
<p>Tiles of 256 m or smaller also place plants on a 6 m jittered grid. A candidate is kept if \(u < \rho_b \cdot 0.36 \cdot \rho\), where \(\rho_b\) is the biome's number of plants per 100 m² (a cell is 36 m²) and \(\rho\) the density slider. The species is a weighted choice from the biome's list. Plants are rejected within 0.4 m of the sea, above the snow line plus 10 m, and on slopes steeper than 36.9° (\(n_y < 0.8\); boulders up to 53.1°). Each gets a random scale between 0.7 and 1.4 and a random rotation. They are drawn as instanced meshes, one draw call per species, rebuilt when the set of visible tiles changes or the camera has moved 8 % of the vegetation distance.</p>
`,
  },
  {
    id: 'doc-watershed',
    title: 'Watershed worlds: rivers first',
    html: tex`
<p>Terrain mode makes heights first and lets rivers be wherever a noise is near zero, so its rivers never fork, join or reach the sea. The Watershed mode works the other way round, after Génevaux et al. (2013) and Derzapf et al. (2011): each continent first gets its river mouths, then a drainage network grows inland from them, the rivers get heights from the mouth upward, and only then is the ground shaped around them (<code>watershed/*.ts</code>). Every river therefore runs downhill, tributaries join, and every drop of water reaches the sea.</p>
<h5>One continent per region</h5>
<p>A river depends on its whole basin, so it cannot be computed point by point. The plane is split into regions: one jittered site per \(R \times R\) lattice cell (\(R = 64\) km), and a point belongs to the site nearest its domain-warped position \(\mathbf p'\). With \(b\) the exact distance to the Voronoi border (the nearest bisector),</p>
\[ b(\mathbf p) = \min_{k} \frac{|\mathbf p' - \mathbf s_k|^2 - |\mathbf p' - \mathbf s_1|^2}{2\,|\mathbf s_k - \mathbf s_1|}, \qquad L(\mathbf p) = f\,b - m - \sigma\, n(\mathbf p') , \]
<p>the coast function \(L\) is positive on land. The margin \(m\) (4 km), the bay setback \(\sigma\) (14 km) with coast noise \(n \in [0,1]\), and a size factor \(f\) per region keep each continent strictly inside its region. Ocean regions use \(-b\) instead of \(f b\), so \(L\) is continuous across every border. A region's network depends only on (seed, settings, region), so every worker builds identical copies on demand and caches the last four.</p>
<h5>Growing the drainage network</h5>
<p>Network nodes sit on a 256 m lattice. Land nodes next to the sea are <b>outlets</b>. A shortest-path forest grows inland from all of them at once (Dijkstra): the cost of the step from node \(a\) to its neighbour \(b\) is</p>
\[ c(a \to b) = |ab| \cdot U(b) \cdot \big(1 + j\,(2\xi_b - 1)\big), \]
<p>with uplift \(U\), jitter \(j = 0.45\) and a hashed \(\xi_b \in [0,1)\). Each node remembers the neighbour it was reached from as its <i>receiver</i>, so every node has exactly one way to the sea, and basins spread fastest through low uplift: rivers run in the structural lows. A diagonal step is refused if the other diagonal of the same grid cell is already a river edge, so rivers never cross. Outlets start with a hashed extra cost (the <i>mouth bias</i>): outlets that start late lose their land to their neighbours, which gives fewer, larger rivers.</p>
<h5>Area, discharge and stream order</h5>
<p>Visiting the nodes children first, each node adds its rain-weighted cell area to its receiver: \(A_n = g^2 r_n + \sum_{\text{children}} A_c\) (km²). A node is a river once \(A \ge 3\) km². Discharge is \(Q = A \times\) runoff (350 mm/yr, Hack's Potomac rule of about 0.011 m³/s per km²). Strahler order: sources are 1; if two inflows share the highest order the river's order goes up by one, otherwise it keeps the highest.</p>
<h5>Heights, from the sea upward</h5>
<p>In steady state, the stream power law \(\partial h/\partial t = u - k A^m S^n\) gives slopes \(S \propto A^{-m/n}\) with \(m/n \approx 0.5\) (Cordonnier et al. 2016). So heights are integrated from the outlets upward:</p>
\[ h_n = h_{\text{receiver}} + |n - \text{receiver}| \cdot \clamp\!\big(k\, U_n\, A_n^{-\theta},\; S_{\min},\; S_{\max}\big), \qquad k = 0.045,\; \theta = 0.5 . \]
<p>Big rivers get gentle slopes and small streams steep ones: river profiles come out concave, valleys cut deep, and the land between rivers rises into ridges where neighbouring basins meet. Every node is higher than its receiver, so the coarse surface has no pits at all. The uplift \(U = 0.3 + 1.5\,(1 - |v|)^3\) turns the zero lines of a noise \(v\) into mountain belts, halved near the coast.</p>
<figure data-fig="watershed"><figcaption>One region of the default world, computed live: the drainage basins (one colour per river mouth) with the river network on top, and the shaded relief with its biomes.</figcaption></figure>
<figure data-fig="riverProfile"><figcaption>Left: the long profile of the region's largest river, from its mouth to its source: flat lowlands, steep headwaters. Right: the slope–area law the heights follow, for low, middle and high uplift (dots: the nodes of that river).</figcaption></figure>
<h5>Lakes</h5>
<p>Some flat river nodes become a <i>sill</i>: the lake level is the sill height plus a hashed dam of 3–12 m, and the lake floods the sill's upstream subtree below that level. Filling only the subtree keeps the lake inside one basin. Any other neighbour lower than the lake is raised 1 m above it (and its upstream heights are lifted to keep draining), and the sill's downstream nodes may neither flood nor be raised, so a lake can only spill over its sill.</p>
<h5>From network to ground</h5>
<p>River reaches (chains between junctions) become smooth curves: centripetal Catmull–Rom splines through the jittered nodes, with sine-generated meanders of wavelength \(\lambda \approx 11W\) and amplitude up to \(2.7\,W^{1.1}\) (Leopold & Wolman 1960) that wander along the river. Width and depth follow downstream hydraulic geometry (Leopold & Maddock 1953): \(W = 22\,(A/100)^{0.5}\) m and \(D = 2.2\,(A/100)^{0.4}\) m. The base ground interpolates the node heights (Catmull–Rom, plus detail noise that fades out near rivers). Each river within reach then shapes it, with \(d\) the distance to its centreline, \(d_c\) to its meandering channel, \(F\) the floodplain half-width and \(s\) a valley-wall slope:</p>
\[ v = w + \beta + s \max(0, d - F), \qquad \ell = w + \beta - s \max(0, d - F), \qquad c = w + \beta - (D + \beta)\Big(1 - \big(\tfrac{2 d_c}{W}\big)^2\Big), \]
\[ h = \min\!\big(\max(\min(g_0, v),\; \ell),\; c\big) . \]
<p>The valley term \(v\) cuts a valley with a flat floodplain at the water level \(w\) plus the bank \(\beta\); the levee \(\ell\) raises the banks wherever the base was lower than the water, so a river can never spill; and \(c\) is the parabolic channel. Beyond the floodplain, \(v\) and \(\ell\) hand over to \(g_0\) smoothly. Every term is a minimum or maximum of continuous functions, so the surface stays continuous through confluences and coastlines.</p>
<h5>Water and level of detail</h5>
<p>Each sample carries its own water level: the river's \(w\) across its floodplain, the lake level in a lake, the sea level below the sea, or none. The water mesh follows it, so rivers slope downhill and lakes sit above sea level; the water under the banks stays hidden by the ground. River vertices also carry their downstream direction, and the water shader carries its ripples along it. Far tiles cannot resolve narrow channels: there, a channel is widened up to \(2.5\Delta\) (at most 80 m and six times its width) or, if still unresolved, not cut at all, and meanders fade out once \(\Delta > \lambda/16\).</p>
`,
  },
  {
    id: 'doc-voxel',
    title: 'Voxel worlds',
    html: tex`
<p>The voxel world (<code>voxelGen.ts</code>) reuses the terrain's climate and height, then decides block by block what is solid. Chunks are 32 × 32 columns spanning y = −64 to 319, Minecraft's 1.18 world height.</p>
<h5>Density</h5>
<p>A point is solid where the <i>density</i> is positive:</p>
\[ D(x, y, z) = \underbrace{S(x, z) - y}_{\text{depth below the surface}} \;+\; O(x,\; 1.2y,\; z) \cdot k_o \cdot J(x, z). \]
<p>\(S = 63 + 0.85\,h\) is the surface height in blocks (sea level 63, height scale 0.85), \(O\) a 3D fBm (wavelength 56 blocks, 3 octaves), \(k_o = 14\) blocks the overhang strength, and \(J = 0.3 + 0.7\,M\) makes mountains more jagged than plains. Where \(O\) pushes the density above zero over the surface you get overhangs and ledges; where it pushes it below zero underneath, notches and arches. \(O\) is only evaluated within \(1.25\, k_o\) of the surface; further away it could not turn rock into air or air into rock.</p>
<h5>Sampling on a lattice</h5>
<p>Evaluating several 3D noises for every block would be slow. Like Minecraft (whose cells are 4 × 8 × 4 blocks), the generator evaluates the density only every 4 blocks and fills in the blocks by trilinear interpolation. A chunk with its 4-block margin is 40 × 40 × \(H\) blocks but needs only \(11 \times 11 \times (H/4 + 1)\) density samples, about 1/52 of the work, and the interpolation also smooths the shapes. The price is the sampling theorem again: features thinner than the lattice spacing can fall between lattice points and vanish, unless they are handled per block (see noodle caves below).</p>
<h5>Caves</h5>
<p>Caves are carved by taking the minimum of the terrain density and several cave fields, which is the union of the empty spaces in the language of constructive solid geometry:</p>
\[ D \leftarrow \min\big(D,\; D_{\text{cheese}},\; D_{\text{spaghetti}},\; D_{\text{noodle}}\big) \qquad \text{wherever } D > 0. \]
<p>Two protection terms keep the caves from breaking the world. With the depth \(\delta = S - y\):</p>
\[ P = 4 \max(0,\; 8 - \delta) \quad \text{(a closed crust 8 blocks thick)}, \qquad B = 8 \max(0,\; 9 - \delta) \;\; \text{if } S < 66 \quad \text{(no holes in the sea floor)}. \]
<ul>
<li><b>Cheese caves</b> are large caverns where a 3D fBm exceeds the threshold \(\theta = 0.42\):
\[ D_{\text{cheese}} = 64\,\big(\theta - F(x,\; 1.8y,\; z)\big) + P + B . \]
Stretching \(y\) by 1.8 makes the caverns wider than they are tall. This fBm has a measured standard deviation of 0.285, so about 7 % of the underground volume exceeds the threshold.</li>
<li><b>Spaghetti and noodle caves</b> use a neat trick. For one noise \(a\), the set \(|a| < r\) is a thin <i>sheet</i> around the surface \(a = 0\). Two independent noises give two crossing sheets, and their intersection
\[ \max\big(|a|,\, |b|\big) < r \]
is a thin <i>tube</i> around the curve where both are zero: a winding tunnel.
\[ D_{\text{spaghetti}} = 160\,\big(\max(|a|, |b|) - 0.075\big), \qquad D_{\text{noodle}} = 220\,\big(\max(|a|, |b|) - 0.035\big) + P + B . \]
The spaghetti noises have a 110-block wavelength (with \(y\) squashed by 1.6); the noodle noises 40 blocks, starting 6 blocks down. With <i>entrances</i> on, spaghetti ignores the crust term, so tunnels can break through to the surface.</li>
</ul>
<p>How wide is a tube? Across a sheet \(|a| < r\), \(a\) changes at the rate of its gradient, so the sheet is about \(2r/\lVert\nabla a\rVert\) noise units thick. With the measured mean \(\lVert\nabla a\rVert \approx 2.8\), spaghetti is about \(2 \cdot 0.075/2.8 \times 110 \approx 6\) blocks wide (3.7 blocks tall after the squash) and noodles about 1 block. Evaluated per block, spaghetti fills 3.6 % of the volume and noodles 0.9 %.</p>
<div class="doc-note"><b>Thin tubes and the lattice.</b> Noodles are thinner than the 4-block lattice. Applying \(|\cdot|\) and \(\max\) at the lattice points and interpolating the result loses every tube that passes between lattice points: done that way, only 10–18 % of the noodle volume survived. So, like Minecraft, the generator stores the two raw noodle noises on the lattice, interpolates <i>them</i> (they are smooth, so this is accurate), and applies \(|\cdot|\) and \(\max\) per block. That keeps 97–98 % of the exact volume, with tubes shifted by a fraction of a block. Spaghetti, about 6 blocks wide, stays on the lattice as in Minecraft and keeps about 70 %.</div>
<p>Per-block noodles would cost a lot if every underground block interpolated two more noises. But an interpolated value never leaves the range of its cell's corner values, so a tube can only pass through a cell where the corner values of both noises reach into \([-r, r]\). Cells are tested once, and only blocks in candidate cells do the work, which keeps the extra cost to about 4 % of the chunk's generation time.</p>
<p>The factors 64, 160 and 220 convert noise units into roughly "blocks of distance", so the fields have comparable slopes when <code>min()</code> combines them and the interpolation stays well-behaved.</p>
<h5>Surface rules</h5>
<p>Each column is scanned from the top down:</p>
<ul>
<li>The first solid block below air gets the biome's top block (grass, sand, snow and so on), and the next 3 to 6 blocks get its filler (dirt, sandstone and so on), as long as that block is within 6 blocks of the column's surface height. Cave ceilings deep underground stay stone.</li>
<li>Under water, grass and snow become dirt and red sand becomes sand. On steep ground (a height change of more than 3.2 blocks over two blocks, i.e. steeper than 58°), soil becomes stone, sand becomes sandstone and snowy biomes get snow. Badlands get terracotta strata chosen by hashing \(\lfloor y/2 \rfloor\).</li>
<li><b>Bedrock</b> fills y = −64 and appears with probability \((-59 - y)/5\) just above it. <b>Deepslate</b> replaces stone below y = −8, and with probability \((8 - y)/16\) between −8 and 8: the same kind of dithered boundary Minecraft uses.</li>
<li>Air at or below sea level that is open to the sky becomes <b>water</b> (with ice on top in snowy biomes). Air below y = −54 with rock above it, which means a cave, becomes <b>lava</b>.</li>
</ul>
<h5>Ores</h5>
<p>Ores are placed in cells of 2 × 2 × 2 blocks. Each cell draws \(u \in [0, 8)\), and each ore owns a slice of that range proportional to its frequency (times the abundance slider), so most cells get nothing; about 0.58 % of cells get an ore. In a chosen cell, every stone block inside the ore's height range becomes ore with probability 0.6, which gives blobs of about 5 blocks.</p>
<div data-table="ores"></div>
<h5>Trees</h5>
<p>Trees use a 5-block jittered grid, kept with probability \(\rho_b \cdot 25/100 \cdot \rho\). The ground decides what may grow (cacti need sand, trees need soil). The shapes come from hashed random numbers: trunk height, leaf discs with randomly trimmed corners, the leaning trunk of an acacia, the cone of a spruce. Every chunk is generated with a 4-block margin and builds its neighbours' trees too, so canopies cross chunk borders seamlessly.</p>
<h5>Meshing and ambient occlusion</h5>
<p>A block face is emitted only if the neighbouring block does not hide it; water faces only face air (<code>mesher.ts</code>). Each face vertex gets an ambient-occlusion value from the three blocks around that corner, in the layer in front of the face: two side neighbours \(s_1, s_2\) and the diagonal \(c\). This is the 0fps technique by Mikola Lysenko:</p>
\[ \text{ao} = \begin{cases} 0 & s_1 \wedge s_2, \\ 3 - (s_1 + s_2 + c) & \text{otherwise}, \end{cases} \qquad \text{brightness} \in \big\{\,1 - 0.58k,\;\; 1 - 0.38k,\;\; 1 - 0.18k,\;\; 1\,\big\}. \]
<p>When both sides are solid the corner is fully occluded, whatever the diagonal is. \(k\) is the AO strength slider. A quad is split into two triangles along its darker diagonal (if \(\text{ao}_0 + \text{ao}_2 \le \text{ao}_1 + \text{ao}_3\), split 0–2, otherwise 1–3). The GPU interpolates linearly within each triangle, and the wrong diagonal makes the shading visibly lopsided. Water surfaces sit at 7/8 of a block (Minecraft uses about 8/9). Opaque, water and glowing blocks go into three separate meshes.</p>
<h5>Picking, edits and walking</h5>
<p>The block under the crosshair is found with the Amanatides–Woo voxel traversal. Starting in the camera's block, it keeps, for each axis \(a\), the ray distance \(t_{\max,a}\) to the next cell boundary, and always steps along the axis whose boundary is nearest:</p>
\[ t_{\Delta,a} = \frac{1}{|d_a|}, \qquad a^\ast = \arg\min_a\, t_{\max,a}, \qquad t_{\max,a^\ast} \mathrel{+}= t_{\Delta,a^\ast}. \]
<p>Every block the ray touches is visited exactly once, up to 8 blocks away, and the last axis stepped gives the face normal for placing a block.</p>
<p>Edits are stored as a map from block position to block id and re-applied after a chunk is generated, so you can change generation settings and your buildings stay. No Man's Sky stores player changes the same way: as deltas on top of generated terrain.</p>
<p>Walking uses a 0.6 × 1.8 × 0.6 block box with the eye at 1.62. Gravity is 26 blocks/s² and a jump starts at 8.4 blocks/s, so the apex is \(v^2/2g \approx 1.36\) blocks, enough to climb one block. Motion is split into sub-steps of at most 0.4 blocks and resolved one axis at a time (y, then x, then z), so you slide along walls instead of sticking to them. Horizontal velocity eases towards the input,</p>
\[ v \leftarrow v + (v^\ast - v)\big(1 - e^{-k\,\Delta t}\big), \qquad k = 12 \text{ on the ground},\; 3 \text{ in the air}, \]
<p>which behaves the same at any frame rate.</p>
`,
  },
  {
    id: 'doc-planet',
    title: 'Planets',
    html: tex`
<h5>A universe from one seed</h5>
<p>Planets are addressed as in No Man's Sky: galaxy seed → region \((x, y, z)\) → star system → planet. The planet's seed is a hash of the whole address,</p>
\[ s_{\text{planet}} = \derive\big(s_{\text{galaxy}};\; \texttt{0x5eed},\; x,\; y,\; z,\; \text{system},\; \text{planet}\big), \]
<p>and everything about the planet is drawn, in a fixed order, from a generator seeded with it: its type, size, sea level, noise parameters, palette, atmosphere, clouds, rings, moons and name (<code>universe.ts</code>). Nothing is stored; the same address always produces the same planet. Each system has 2 to 6 planets, also derived from its address.</p>
<div data-table="planetTypes"></div>
<p>Within a type, parameters are drawn from ranges: radius 750–1300 units, relief 1.8–3.4 % of the radius, continent size, warp strength, mountain height and coverage, the uber-noise sharpness and erosion settings, and more. Palettes are rotated in hue by up to ±22° (with the matrix from the Biomes chapter), so two lush planets are never quite the same green. Rings appear with probability 22 % (10 % on barren worlds), and the number of moons is 0 to 3 with weights 3 : 4 : 2 : 1. Names are 2 or 3 random syllables plus an optional suffix.</p>
<figure data-fig="planets"><figcaption>Four planets of the default galaxy (one per type, forced), as equirectangular maps from the surface-map export code.</figcaption></figure>
<h5>A sphere made of six quadtrees</h5>
<p>A sphere has no natural square grid, but a cube does. Each of the cube's six faces is a quadtree, just like the flat terrain, and face coordinates \((a, b) \in [-1, 1]^2\) are mapped to the cube point \(\mathbf c = \mathbf n + a\,\mathbf u + b\,\mathbf v\) and then onto the unit sphere (<code>planetMesh.ts</code>). Simply normalising, \(\mathbf c / \lVert\mathbf c\rVert\), crowds the vertices towards the cube's corners: cell areas vary by a factor of \(3\sqrt3 \approx 5.2\) across a face. The code uses the "spherified cube" mapping instead:</p>
\[ x' = x\sqrt{1 - \frac{y^2}{2} - \frac{z^2}{2} + \frac{y^2 z^2}{3}}, \qquad y' = y\sqrt{1 - \frac{z^2}{2} - \frac{x^2}{2} + \frac{z^2 x^2}{3}}, \qquad z' = z\sqrt{1 - \frac{x^2}{2} - \frac{y^2}{2} + \frac{x^2 y^2}{3}} . \]
<p>It lands exactly on the unit sphere, and its cell areas vary by only 1.33× (largest in the middle of the cube's edges, smallest at its corners).</p>
<figure data-fig="cubeSphere"><figcaption>One cube face cut into 12 × 12 cells and seen from outside, coloured by cell area (blue = smaller, red = larger than average). The ratios printed are for these 12 × 12 cells; for very small cells they approach 5.2× and 1.33×.</figcaption></figure>
<h5>Elevation</h5>
<p>The surface is a function of the unit direction \(\mathbf u\) (<code>planetGen.ts</code>). Elevation \(e = 0\) is sea level, and the surface radius is \(r = R\,(1 + e\, k_h)\), with \(k_h\) the relief (height scale).</p>
<ol>
<li><b>Warp</b>: \(\mathbf p = \mathbf u + w\,\big(F_1(\mathbf u),\; F_2(\mathbf u + 3.1\,\hat{\mathbf x}),\; F_3(\mathbf u + 7.7\,\hat{\mathbf y})\big)\).</li>
<li><b>Continents</b>: \(c = F_C(\mathbf p)\) and \(e_0 = 2.2\,c - \text{sea level}\). Land is flattened, ocean floors are steepened and clamped:
\[ e = \begin{cases} 0.55\, e_0 & e_0 \ge 0, \\ \max(-1.3,\; 1.1\, e_0) & e_0 < 0. \end{cases} \]</li>
<li><b>Mountains</b> only rise inland. With the mask \(m = \smoothstep(\kappa,\; \kappa + 0.35,\; e_0)\) for coverage \(\kappa\):
\[ e \mathrel{+}= \Big(\tfrac12\big(F_{\text{ridged}}(\mathbf p) + 1\big)\Big)^2 A_m\, m . \]
Squaring keeps the foothills low and the ridges sharp.</li>
<li><b>Detail</b>: uber noise weighted by \(0.35 + 0.65\, m\), so mountains are rougher than lowlands.</li>
<li><b>Craters</b> and <b>terraces</b>, when enabled (see below).</li>
</ol>
<p>On a sphere, slope erosion has to ignore part of the noise gradient. The 3D gradient \(\nabla n\) has a radial component (how the noise changes as you move <i>up</i>), which says nothing about how steep the surface is. The uber noise removes it using the surface normal \(\mathbf u\):</p>
\[ \nabla_{\!t}\, n = \nabla n - (\nabla n \cdot \mathbf u)\,\mathbf u . \]
<h5>Craters</h5>
<p>Craters come from three layers of 3D Worley noise at frequencies \((3.2/\text{size})(1 + 1.9k)\) for \(k = 0, 1, 2\). The hash of a cell's feature point decides whether the cell holds a crater (probability \(\min(0.95,\; 0.35 \cdot \text{density} \cdot (1 + 0.5k))\)) and sets its radius \(\rho = 0.16 + 0.26 \cdot \fract(7.31\, \text{id})\) in cell units. With \(t = F_1/\rho\), the profile is a parabolic bowl plus a Gaussian rim:</p>
\[ c(t) = (t^2 - 1)\,[\,t < 1\,] + 0.32\, e^{-(t - 1)^2/0.05}, \qquad c(t) = 0 \text{ for } t > 1.8, \]
<p>scaled by \(\rho \cdot 4.5/(1 + 1.2k)\). Depth is proportional to radius, as for real simple craters, whose depth is about a fifth of their diameter (Pike, 1977). The smaller layers are shallower.</p>
<figure data-fig="crater"><figcaption>The crater profile c(t).</figcaption></figure>
<h5>Climate and colour</h5>
\[ T = 0.85 - 1.5\,|u_y|\,(0.35 + 0.65\, c_p) - 0.3 \max(0, e) + 0.35\, F_T(\mathbf u) + T_0, \qquad H = 1.6\, F_H(\mathbf u) + H_0 . \]
<p>\(u_y\) is the sine of the latitude, so the poles are cold (more so with larger polar caps \(c_p\)), and so is high ground. The colour moves from deep to shallow water with depth, from dry to wet lowland with humidity, towards the highland colour with height, to beach just above the sea, to rock where the slope \(\mathbf n \cdot \mathbf u\) drops below 0.95 (and on very high ground), and to snow where \(T < -0.25\) (fully at −0.6) or \(e > 1.3\).</p>
<h5>Level of detail on a sphere</h5>
<p>A node at level \(L\) is about \(s_L = 1.6R/2^L\) across (a cube face spans roughly \(\pi/2 \approx 1.6\) radians of arc). It splits while the camera is closer than \(\lambda s_L\) (\(\lambda = 2.2\)) to the node's centre, placed at its mean elevation, down to level 12. Noise detail is limited by the vertex spacing on the unit sphere, \(1.6 \cdot 2^{-L}/N\).</p>
<ul>
<li>Vertex positions are stored relative to each tile's centre, and the tile object sits at that centre. Small coordinates spend the 24 bits of float precision on detail instead of on the planet's radius.</li>
<li>Skirts are pulled towards the planet's centre instead of straight down.</li>
<li>The camera's near and far planes follow the altitude: near \(= \clamp(0.05\,\text{alt},\; 0.03,\; 0.05R)\), far \(=\) distance \(+ 8R\). Depth-buffer precision depends mostly on the near plane, so this keeps the ground free of flickering (z-fighting) from orbit down to the surface.</li>
</ul>
<h5>Atmosphere</h5>
<p>The atmosphere is a shell of radius \(R_a = R\,(1 + \text{thickness})\), drawn on the inside of a sphere. For each pixel, the shader intersects the view ray \(\mathbf o + t\,\mathbf d\) (with \(\mathbf o\) relative to the planet's centre) with the shell:</p>
\[ t_{0,1} = -b \mp \sqrt{b^2 - c}, \qquad b = \mathbf o \cdot \mathbf d, \qquad c = \lVert\mathbf o\rVert^2 - R_a^2 , \]
<p>and cuts the ray short where it hits the planet. The length of air the ray crosses, relative to the longest chord through the shell that misses the planet, \(2\sqrt{R_a^2 - R^2}\) (a ray grazing the surface), stands in for the optical depth \(\tau\). Opacity then follows the Beer–Lambert law:</p>
\[ \alpha = 1 - e^{-k\, \tau\, I}, \qquad k = 3.2 \text{ for rays passing the planet}, \quad k = 1.6 \text{ for rays hitting it}. \]
<p>The colour is lit by \(\smoothstep(-0.25,\; 0.35,\; \hat{\mathbf s} \cdot \hat{\mathbf m})\) at the chord's midpoint \(\mathbf m\), with an orange tint near the day–night line. This is not a full Rayleigh scattering model, but it reproduces the most recognisable effect: the bright rim where rays skim through the most air. As you descend, a sky dome and fog fade in, so the sky turns from black to blue.</p>
<h5>Clouds, rings, moons and stars</h5>
<ul>
<li><b>Clouds</b> are a sphere just above the mountains, coloured in the shader by domain-warped 3D fBm of value noise that drifts over time. That fBm has a mean near 0.5 and a standard deviation near 0.12, so coverage \(c\) maps to a threshold \(t_0 = 0.74 - 0.4\,c\) and \(\alpha = \smoothstep(t_0,\; t_0 + 0.12,\; n)\).</li>
<li><b>Rings</b> get their bands from two octaves of 1D value noise along the radius (60 and 210 cycles). A ring point \(\mathbf P\) is in the planet's shadow if the ray towards the sun \(\hat{\mathbf s}\) hits the sphere: \(b = \mathbf P \cdot \hat{\mathbf s} < 0\) and \(b^2 - \big(\lVert\mathbf P\rVert^2 - R^2\big) > 0\).</li>
<li><b>Moons</b> are icospheres displaced by simplex bumps and Worley craters, on orbits of 2.6 to 5.5 planet radii with up to ±0.35 inclination; one in five orbits backwards.</li>
<li>The 7000 background <b>stars</b> are spread uniformly over the sky by choosing their height \(y\) uniformly in [−1, 1] and their angle uniformly in \([0, 2\pi)\). By Archimedes' hat-box theorem, slices of a sphere of equal height have equal area, so this is exactly uniform.</li>
</ul>
<h5>Flying</h5>
<p>Flight speed is proportional to altitude, \(v = \clamp(0.9\,a,\; 2,\; 1.5R)\) at the default fly speed. Diving straight down therefore follows \(\dot a = -0.9\,a\), so \(a(t) = a_0\, e^{-0.9t}\): from 2000 units up to 1 unit takes about \(\ln(2000)/0.9 \approx 8.4\) s, slowing smoothly as you approach. The orbit wheel multiplies the altitude by 0.88 per notch for the same reason. Near the ground the ship levels itself. With \(\ell = 1 - \smoothstep(0.05R,\; 0.3R,\; a)\), the roll error \(\theta\) (the signed angle about the forward axis between the camera's up and the local vertical) shrinks by a fraction \(\min(1,\; 2.5\, \ell\, \Delta t)\) every frame.</p>
`,
  },
  {
    id: 'doc-erosion',
    title: 'Erosion',
    html: tex`
<p>Noise can imitate erosion, but it cannot make water run downhill. The Erosion mode simulates it on a finite map: a 256 × 256 grid sampled from the terrain generator over 2048 m, so 8 m cells (<code>erosion.ts</code>). Heights are normalised to [0, 1] for the simulation, so the classic parameter values behave as published.</p>
<h5>Hydraulic erosion with droplets</h5>
<p>The method, from Hans Theobald Beyer's 2015 thesis and popularised by Sebastian Lague, simulates many independent raindrops. Each droplet starts at a random point with no direction, speed 1, water 1 and no sediment, and repeats these steps at most 30 times:</p>
<ol>
<li><b>Sample</b> the height and gradient by bilinear interpolation of the four surrounding nodes, with \((x, y)\) the offset inside the cell:
\[ g_x = (h_{NE} - h_{NW})(1 - y) + (h_{SE} - h_{SW})\,y, \qquad g_y = (h_{SW} - h_{NW})(1 - x) + (h_{SE} - h_{NE})\,x . \]</li>
<li><b>Turn</b> downhill, with inertia \(\iota\): \(\mathbf d \leftarrow \normalize\big(\iota\, \mathbf d - (1 - \iota)\, \mathbf g\big)\). Inertia lets droplets overshoot bends, which smooths the channels.</li>
<li><b>Move</b> one cell along \(\mathbf d\), stopping at the map edge or on perfectly flat ground, and compute the height change \(\Delta h = h_{\text{new}} - h_{\text{old}}\).</li>
<li><b>Capacity</b>, the sediment the water can carry, grows with slope, speed and water:
\[ c = \max\big(-\Delta h \cdot v \cdot w \cdot K_c,\;\; c_{\min}\big). \]</li>
<li><b>Deposit or erode.</b> If the droplet carries more than \(c\), or moved uphill (\(\Delta h > 0\)), it drops sediment at its old position, split bilinearly over the four nodes: \(\min(\Delta h, s)\) after an uphill step, just enough to fill the pit it is climbing out of, and otherwise \((s - c)\,K_d\). If it carries less than \(c\), it erodes
\[ \min\big((c - s)\, K_e,\;\; -\Delta h\big) \]
from the nodes within radius \(r\), weighted by \(\max(0,\, 1 - d_i/r)\) and normalised. Taking no more than \(-\Delta h\) avoids digging pits deeper than the drop, and the brush avoids one-cell holes.</li>
<li><b>Speed</b> follows from energy conservation: \(\tfrac12 v^2 + g\,h\) stays constant, so
\[ v' = \sqrt{\max\big(0,\;\; v^2 - \Delta h\, g\big)} . \]
Going down (\(\Delta h < 0\)) accelerates the droplet. Beyer's text and Lague's code write \(+\Delta h\, g\), which slows droplets going downhill; this app uses the physical sign.</li>
<li><b>Evaporate</b>: \(w \leftarrow w\,(1 - e)\). Droplets that reach the sea also lose 30 % of their water per step, so they drop their load and build deltas. A droplet dies when \(w < 0.01\).</li>
</ol>
<p>The feedback creates the landforms: channels gather more droplets, which carry more water, erode more and deepen the channel. Where the slope eases, capacity falls below the load and sediment fans out.</p>
<div data-table="erosion"></div>
<h5>Thermal erosion</h5>
<p>Loose material cannot rest on slopes steeper than its <i>angle of repose</i>, the talus angle \(\theta\). After every batch of droplets, one sweep compares each cell with its four neighbours. In normalised units the largest stable step between neighbours is</p>
\[ T = \frac{\tan\theta \cdot \text{cell size}}{\text{height range}} . \]
<p>If the lowest neighbour is lower by \(\Delta > T\), the cell moves</p>
\[ m = \sigma\, \frac{\Delta - T}{2} \]
<p>to it. Moving half the excess would bring the pair exactly to the talus slope, since the gap shrinks by \(2m\). The strength \(\sigma = 0.35\) moves less than that for stability (Olsen, 2004, uses 0.5). The default 38° over 8 m cells allows steps of up to 6.25 m. Cells are updated in place, so a change ripples through the grid within a single sweep, like a Gauss–Seidel iteration.</p>
<h5>Running it and reading the colours</h5>
<p>The simulation runs in its own worker, in 40 ms slices of 3000 droplets plus one thermal sweep, streaming a snapshot about every 140 ms until 300 000 droplets have fallen (4.6 per cell). Every droplet step adds the droplet's water to its cell's flow counter. Flow spans orders of magnitude (river cells collect thousands of visits, ridges almost none), so the <i>water flow</i> view uses a logarithmic scale relative to the mean flow \(\bar F\):</p>
\[ \text{shade} = \frac{\ln\big(1 + F/\bar F\big)}{\ln\big(1 + F_{\max}/\bar F\big)} . \]
<figure data-fig="erosion"><figcaption>The Erosion mode's own simulation with its default settings, run live in a background worker over the region the mode picks on its first visit. The second tile updates as the droplets fall.</figcaption></figure>
`,
  },
  {
    id: 'doc-render',
    title: 'Light, sky and water',
    html: tex`
<h5>The sun's path</h5>
<p>The time of day \(t\) (in hours) moves the sun along a tilted circle (<code>Environment.ts</code>):</p>
\[ \alpha = \frac{\pi\,(t - 6)}{12}, \qquad \hat{\mathbf s} = \normalize\big(\cos\alpha,\;\; 0.86 \sin\alpha,\;\; 0.5 \sin\alpha\big), \]
<p>then rotated about the vertical by the sun azimuth. It rises at 6:00, sets at 18:00 and reaches about 60° at noon. Sky and light colours are blended from day, sunset and night palettes by smoothsteps of the sun's height.</p>
<h5>The sky</h5>
<p>The sky dome blends the horizon colour into the zenith colour with \(\max(0,\, \hat{\mathbf d} \cdot \hat{\mathbf u})^{0.45}\); the exponent widens the bright band near the horizon. Below the horizon it fades to a ground colour. The sun is a sum of three power lobes,</p>
\[ 30\,(\hat{\mathbf d} \cdot \hat{\mathbf s})^{1400} + 0.35\,(\hat{\mathbf d} \cdot \hat{\mathbf s})^{18} + 0.18\,(\hat{\mathbf d} \cdot \hat{\mathbf s})^{4}\,\big(1 - |\hat{\mathbf s} \cdot \hat{\mathbf u}|\big). \]
<p>For small angles \(\cos^n\theta \approx e^{-n\theta^2/2}\), so a lobe with exponent \(n\) falls to half at \(\theta \approx \sqrt{2 \ln 2 / n}\): about 1.8° for the disc, 16° for the glow and 34° for the haze. At night stars appear: the view direction, scaled by 260, is cut into cells, and a cell holds a star when its hash exceeds 0.996 (0.4 % of the cells), at a jittered position and with a hashed brightness.</p>
<h5>Light</h5>
<ul>
<li>A directional sun with intensity \(2.6 \cdot \smoothstep(-0.03,\; 0.12,\; s_y)\). At night a weak bluish "moonlight" shines from the opposite direction.</li>
<li>A hemisphere light (sky colour from above, ground colour from below) provides the ambient part. three.js uses physically based shading, where a matte surface reflects \(\tfrac{\text{albedo}}{\pi}\, E \cos\theta\), so the ambient intensities are scaled up by about \(\pi\) to match.</li>
<li><b>Shadows</b> come from a 2048² shadow map whose orthographic camera covers \(\pm r\) around the focus point (260 m for terrain, 90 m for voxels). The focus is snapped to whole shadow-map texels (\(2r/2048\), about 25 cm for terrain). Moving the shadow camera by whole texels makes the rasterised shadow repeat exactly, so shadow edges do not shimmer while you move.</li>
</ul>
<h5>Fog</h5>
<p>Linear fog runs from \(\text{near} = \text{far} \cdot \clamp(0.8 - 0.25 f,\; 0.05,\; 0.75)\) to \(\text{far} = R / \max(0.35, f)\), for view distance \(R\) and fog slider \(f\), in the horizon colour, so the edge of the generated world dissolves into the sky.</p>
<h5>Water</h5>
<p>The water surface itself is flat; the waves exist only in its normals (<code>shaders.ts</code>). Five directional sine waves are summed into a gradient, their phases jittered by value noise so the pattern does not visibly repeat:</p>
\[ \nabla w = \sum_{i=1}^{5} \hat{\mathbf d}_i\; 6\, a_i k_i \cos\!\big(k_i\, \hat{\mathbf d}_i \cdot \mathbf p + \omega_i t + \varphi(\mathbf p)\big), \qquad k_{i+1} = 1.7\, k_i, \quad a_{i+1} = 0.6\, a_i . \]
<p>The normal is \(\mathbf N = \normalize(\hat{\mathbf u} - \nabla w_{\parallel})\), with the gradient scaled by \(1/(1 + 0.012\, d)\) at distance \(d\): far away the waves are smaller than a pixel and would only cause moiré, the same aliasing problem as before. The reflection uses Schlick's approximation of the Fresnel equations,</p>
\[ F = F_0 + (1 - F_0)\,(1 - \mathbf N \cdot \mathbf V)^5, \qquad F_0 = 0.03 , \]
<p>close to water's physical value \(F_0 = \big((n - 1)/(n + 1)\big)^2 \approx 0.02\) for a refractive index of 1.333. Looking straight down you mostly see the water's own depth colour; at grazing angles almost only the reflected sky. A sun glint \((\mathbf R \cdot \hat{\mathbf s})^{140}\) is added, and the opacity grows with \(F\).</p>
<h5>Colour pipeline</h5>
<p>Vertex colours are linear, and lighting is computed in linear light. The result is tone-mapped with Khronos PBR Neutral, which keeps the hue and saturation of base colours close to their authored values (filmic curves desaturate and shift them), and finally encoded to sRGB. The exposure slider scales the light before the tone curve.</p>
`,
  },
  {
    id: 'doc-share',
    title: 'Map, settings and sharing',
    html: tex`
<h5>The map</h5>
<p>The world map (<kbd>M</kbd>), the minimap and the heightmap export call the same generator as the 3D view (<code>map.ts</code>). Images are rendered as horizontal strips spread over the worker pool, and every pixel passes its size in metres as the sampling spacing, so the map is anti-aliased at every zoom level. The shaded relief is a hillshade lit from the north-west with 2× vertical exaggeration:</p>
\[ \text{shade} = \clamp\!\left(0.78 + \frac{1.1\,(\partial_x h + \partial_z h)}{\sqrt{1 + 4\,\lVert\nabla h\rVert^2}},\;\; 0.25,\;\; 1.35\right). \]
<p>While rendering, the map also counts histograms (48 bins) of continentalness, erosion and peaks and valleys. The spline editor draws them behind its curves, which shows which part of each curve the visible world actually uses.</p>
<h5>Settings, sharing and saving</h5>
<ul>
<li>The panel edits one plain settings object. A change that affects generation bumps a version number and sends a copy of the settings to the workers, 20 ms after the change or 140 ms while a slider is still being dragged.</li>
<li><b>Share</b> stores only what differs from the defaults. The difference is serialised to JSON, compressed with raw DEFLATE (the browser's <code>CompressionStream</code>) and base64url-encoded into the link's fragment (<code>#s=…</code>). The part after <code>#</code> is never sent to a server.</li>
<li>Loading merges the stored values onto the current defaults and ignores unknown keys and values of the wrong type, so old links and settings files keep working as settings are added.</li>
</ul>
`,
  },
  {
    id: 'doc-sources',
    title: 'Sources and further reading',
    html: tex`
<p>The full research notes, with every number checked against vanilla data or flagged as a reconstruction, are in <code>docs/RESEARCH.md</code> in the repository. The most useful starting points:</p>
<ul class="doc-refs">
<li><b>Minecraft.</b> Minecraft Wiki: <a href="https://minecraft.wiki/w/World_generation" target="_blank" rel="noopener noreferrer">World generation</a>, <a href="https://minecraft.wiki/w/Noise_router" target="_blank" rel="noopener noreferrer">Noise router</a>, <a href="https://minecraft.wiki/w/Density_function" target="_blank" rel="noopener noreferrer">Density function</a>. Misode's <a href="https://github.com/misode/deepslate" target="_blank" rel="noopener noreferrer">deepslate</a> (a TypeScript reimplementation) and Henrik Kniberg's talk <a href="https://www.youtube.com/watch?v=ob3VwY4JyzE" target="_blank" rel="noopener noreferrer">Reinventing Minecraft world generation</a>.</li>
<li><b>No Man's Sky.</b> Sean Murray, <a href="https://www.youtube.com/watch?v=C9RyEiEzMiU" target="_blank" rel="noopener noreferrer">Building Worlds Using Math(s)</a>, and Innes McKendrick, <a href="https://www.youtube.com/watch?v=sCRzxEEcO2Y" target="_blank" rel="noopener noreferrer">Continuous World Generation in No Man's Sky</a> (both GDC 2017).</li>
<li><b>Noise.</b> Ken Perlin, <i>Improving Noise</i> (SIGGRAPH 2002). Stefan Gustavson, <a href="https://github.com/stegu/perlin-noise" target="_blank" rel="noopener noreferrer">Simplex noise demystified</a> (2005). Steven Worley, <i>A Cellular Texture Basis Function</i> (SIGGRAPH 1996). Chris Wellons, <a href="https://nullprogram.com/blog/2018/07/31/" target="_blank" rel="noopener noreferrer">Prospecting for Hash Functions</a> (2018).</li>
<li><b>Fractals.</b> Inigo Quilez: <a href="https://iquilezles.org/articles/fbm/" target="_blank" rel="noopener noreferrer">fBm</a>, <a href="https://iquilezles.org/articles/warp/" target="_blank" rel="noopener noreferrer">domain warping</a>, <a href="https://iquilezles.org/articles/morenoise/" target="_blank" rel="noopener noreferrer">noise derivatives</a>. F. Kenton Musgrave's ridged multifractal, in Ebert et al., <i>Texturing &amp; Modeling: A Procedural Approach</i>. Red Blob Games, <a href="https://www.redblobgames.com/maps/terrain-from-noise/" target="_blank" rel="noopener noreferrer">Making maps with noise functions</a>.</li>
<li><b>Splines.</b> F. N. Fritsch and R. E. Carlson, <i>Monotone Piecewise Cubic Interpolation</i>, SIAM Journal on Numerical Analysis 17(2), 1980.</li>
<li><b>Meshes and voxels.</b> John Amanatides and Andrew Woo, <i>A Fast Voxel Traversal Algorithm for Ray Tracing</i> (Eurographics 1987). Mikola Lysenko, <i>Ambient occlusion for Minecraft-like worlds</i> (0fps, 2013). Catlike Coding, <a href="https://catlikecoding.com/unity/tutorials/cube-sphere/" target="_blank" rel="noopener noreferrer">Cube Sphere</a> (the spherified cube).</li>
<li><b>Erosion.</b> Hans Theobald Beyer, <a href="https://www.firespark.de/resources/downloads/implementation%20of%20a%20methode%20for%20hydraulic%20erosion.pdf" target="_blank" rel="noopener noreferrer">Implementation of a method for hydraulic erosion</a> (2015). Sebastian Lague, <a href="https://github.com/SebLague/Hydraulic-Erosion" target="_blank" rel="noopener noreferrer">Hydraulic Erosion</a>. Jacob Olsen, <a href="http://web.mit.edu/cesium/Public/terrain.pdf" target="_blank" rel="noopener noreferrer">Realtime Procedural Terrain Generation</a> (2004).</li>
<li><b>Nature.</b> R. J. Pike, <a href="https://ntrs.nasa.gov/citations/19780057837" target="_blank" rel="noopener noreferrer">fresh lunar crater depth and diameter</a> (1977). <a href="https://cartogis.org/docs/proceedings/archive/auto-carto-8/pdf/measuring-the-dimension-of-surfaces-a-review-and-appraisal-of-different-methods.pdf" target="_blank" rel="noopener noreferrer">Measuring the dimension of surfaces: a review and appraisal of different methods</a> (Auto-Carto 8), on the fractal dimension of real relief.</li>
<li><b>Rendering.</b> Christophe Schlick, <i>An Inexpensive BRDF Model for Physically-based Rendering</i> (1994).</li>
</ul>
`,
  },
];

function typeset(html: string): string {
  return html
    .replace(/<div data-table="(\w+)"><\/div>/g, (_m, name: string) => TABLES[name]?.() ?? '')
    .replace(/\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g, (_m, display: string | undefined, inline: string | undefined) =>
      katex.renderToString(display ?? inline ?? '', { displayMode: display !== undefined, throwOnError: false, macros: MACROS }),
    );
}

/**
 * Appends the docs to the help body. `scroller` is the element that scrolls
 * (used for the table of contents, the chapter highlight and lazy figures).
 */
export function mountHelpDocs(container: HTMLElement, scroller: HTMLElement): HTMLElement {
  const section = document.createElement('section');
  section.className = 'wide help-doc';
  section.id = 'help-docs';
  const toc = CHAPTERS.map((c, i) => `<button type="button" data-target="${c.id}"><span class="n">${i + 1}</span><span>${c.title}</span></button>`).join('');
  const chapters = CHAPTERS.map(
    (c, i) => `<article class="doc-ch" id="${c.id}"><h4><span class="n">${i + 1}</span>${c.title}</h4>${typeset(c.html)}</article>`,
  ).join('');
  section.innerHTML =
    `<div class="doc-head">${typeset(INTRO)}</div>` +
    `<div class="doc-layout"><nav class="doc-toc" aria-label="How it works: contents">${toc}<button type="button" class="top">↑ Back to the top</button></nav>` +
    `<div class="doc-body">${chapters}</div></div>`;
  container.append(section);

  const buttons = [...section.querySelectorAll<HTMLButtonElement>('.doc-toc button[data-target]')];
  for (const b of buttons) {
    b.addEventListener('click', () => document.getElementById(b.dataset.target ?? '')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  section.querySelector('.doc-toc .top')?.addEventListener('click', () => scroller.scrollTo({ top: 0, behavior: 'smooth' }));

  // Highlight the chapter that is being read (the one crossing the top quarter of the view).
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) for (const b of buttons) b.classList.toggle('active', b.dataset.target === e.target.id);
      }
    },
    { root: scroller, rootMargin: '0px 0px -75% 0px' },
  );
  section.querySelectorAll('.doc-ch').forEach((ch) => spy.observe(ch));

  // Figures lay out at once; their expensive part runs when they come near the view.
  const pending = new Map<Element, () => Promise<void>>();
  const lazy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        lazy.unobserve(e.target);
        const run = pending.get(e.target);
        pending.delete(e.target);
        run?.().catch((err) => console.error('[help figure]', err));
      }
    },
    { root: scroller, rootMargin: '400px 0px' },
  );
  section.querySelectorAll<HTMLElement>('figure[data-fig]').forEach((fig) => {
    fig.classList.add('doc-fig');
    const slot = document.createElement('div');
    slot.className = 'fig-slot';
    fig.prepend(slot);
    try {
      const run = FIGURES[fig.dataset.fig ?? '']?.(slot);
      if (run) {
        pending.set(fig, run);
        lazy.observe(fig);
      }
    } catch (err) {
      console.error('[help figure]', err);
      slot.textContent = 'This figure could not be drawn.';
    }
  });
  return section;
}
