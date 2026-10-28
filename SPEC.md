# 折纸仿真平台 (Origami Studio) — shared engineering spec

Pure static HTML/CSS/JS. **No build step, no ES modules, no external libraries/CDN** — every file is a classic
`<script src>` that attaches one global namespace (IIFE `(function(global){...})(typeof window!=='undefined'?window:globalThis)`)
so `index.html` works from `file://`. Code must also load in Node for unit tests (no DOM access at load time in
pure-logic modules). Node binary: `/Users/dw.zheng/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`.
Headless Chrome via `puppeteer-core` in `/Users/dw.zheng/Documents/work/dsh/games/.tools/node_modules` (Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`). UI language: Simplified Chinese.

## Files & owners

| file | global | owner |
|------|--------|-------|
| `js/geom.js` | `OG` (2D/3D vector helpers, `OG.M4`, `OG.V3`, `OG.triangulate`, `OG.segIntersect`, ...) | lead (done) |
| `js/cp.js` | `CP` crease-pattern model: normalize/planarize, faces, triangulate, validate, FOLD/SVG import-export | lead |
| `js/solver.js` | `OrigamiSolver` bar-and-hinge dynamic solver | lead |
| `js/renderer.js` | `PaperRenderer` WebGL renderer + orbit camera | lead |
| `js/patterns.js` | `CPPatterns` crease-pattern preset library | teammate `patterns` |
| `js/cpeditor.js` | `CPEditor` 2D canvas crease-pattern editor | teammate `cpeditor` |
| `js/stepfold.js` | `StepFold` flat-folding engine (pure logic) | teammate `stepfold` |
| `js/stepview.js` | `StepView` 2D canvas view/interaction for step folding | teammate `stepfold` |
| `js/stepmodels.js` | `StepModels` step-by-step model presets | teammate `stepfold` |
| `js/app.js`, `index.html`, `css/app.css` | app shell | lead |
| `tests/*.js` | node unit tests per module (`tests/test-<module>.js`) | each owner |

## Coordinate conventions (IMPORTANT)

* **Paper / CP coordinates** are 2D `[x, y]` with **y pointing DOWN** (SVG/screen convention). Default square
  sheet occupies `[0,1]×[0,1]`. Rectangular sheets: `[0,w]×[0,h]` with max(w,h)=1.
* The CP drawing shows the **front side** of the paper. Mountain/valley are as seen in the CP drawing.
* **3D mapping** of a flat sheet: `X = x - cx`, `Y = -(y - cy)`, `Z = 0` (cx,cy = sheet centre). Front side faces **+Z**
  (towards the default camera). A **valley** fold brings front faces together (flap rotates towards +Z);
  a **mountain** fold rotates the flap towards −Z.
* Signed fold angle (FOLD spec `edges_foldAngle`, degrees): valley **positive**, mountain **negative**, flat 0,
  range [-180, 180].

## Line / edge types
`'B'` boundary, `'M'` mountain, `'V'` valley, `'F'` flat (facet, stays flat), `'U'` unassigned (free hinge),
`'C'` cut. Colours (editor + renderer): M `#e5484d` (red), V `#3e7bfa` (blue), B `#1f2328`, F `#b6b6b6`,
U `#e0a526` (amber), C `#2fb36d` (green).

## CP line model (editable form, used by editor / patterns / app)
```js
// a crease pattern document
{
  name: '名称', description: '...',
  width: 1, height: 1,            // sheet size, paper coordinates
  lines: [ { a:[x,y], b:[x,y], type:'M', angle: 180 } ],   // angle = |target fold angle| in degrees, optional (default 180 for M/V)
}
```
`CP.normalize(lines, opts)` (lead) splits all lines at mutual intersections, merges coincident vertices (tolerance
1e-7·scale), removes zero-length and duplicate/overlapping segments (later lines win), and returns a new line array
where every line is a single planar-graph edge. Editors should call it after each modification.
`CP.validate(doc)` returns `{ vertices:[{p:[x,y], ok:bool, maekawa:bool, kawasaki:bool, kawasakiError:rad, mv:[m,v]}],
ok:bool, summary:'...' }` for interior vertices.

## Renderer mesh format (`PaperRenderer.setMesh(mesh)`)
```js
{
  positions: Float32Array(n*3),  // 3D
  uvs:       Float32Array(n*2),  // original paper coords normalised to [0,1] by sheet size (u = x/w, v = y/h)
  indices:   Uint32Array(3*t),   // triangles; winding so that (b-a)×(c-a) points OUT OF THE FRONT side
  colors:    Float32Array(n*3) | null,   // optional per-vertex override colour (e.g. strain heat map)
  lines:     Float32Array(m*6) | null,   // 3D line segments [x0,y0,z0,x1,y1,z1,...]
  lineTypes: Array(m) of type letters    // per segment, for colouring
}
```
`renderer.updatePositions(Float32Array)` fast path when topology is unchanged; `renderer.updateLines(Float32Array)`.
