// GPU regression: playing a full recipe to a boundary must show the same
// physical paper side as loading that prefix alone. Test both viewing sides
// and both renderer paths, not just geometry/normals.
const assert = require('assert');
const path = require('path');
const puppeteer = require(process.env.PUPPETEER_PATH || '../../.tools/node_modules/puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true,
    args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page = await browser.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.goto(process.env.ORIGAMI_URL || 'file://' + path.resolve(__dirname, '../index.html'));
    const results = await page.evaluate(() => {
      const SF=StepFold, m=StepModels.get('glider');
      // Flat endpoints isolate visibility from legitimate 90-degree foreshortening.
      const steps=m.steps.map(s=>({op:Object.assign({},s.op,s.op.type==='fold'?{angle:180}:{})}));
      const full=SF.buildPoseModel(steps,m);
      const timed=steps.map((s,i)=>['fold','flip','rotate'].includes(s.op.type)?i:-1).filter(i=>i>=0);
      const canvas=document.createElement('canvas'); canvas.style.width='420px'; canvas.style.height='420px'; document.body.appendChild(canvas);
      const r=new PaperRenderer(canvas); r.set({front:'#10e020',back:'#e020e0',texture:false,pattern:0,showCreases:false,showBoundary:false,showGround:false,showShadow:false,projection:'orthographic'});
      function mesh(pm) {return {positions:pm.positions,uvs:new Float32Array(pm.n*2),indices:new Uint32Array(pm.mesh.tris.flat()),lineIdx:[],stack:pm.mesh.stack,ambient:1};}
      function pixels(pm, updateOnly) { if (updateOnly) r.updatePositions(pm.positions); else r.setMesh(mesh(pm)); r.render(); const gl=r.gl, a=new Uint8Array(canvas.width*canvas.height*4); gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,a); return a; }
      function cls(a,i){return a[i+1]>a[i]+60&&a[i+1]>a[i+2]+60?1:a[i]>a[i+1]+60&&a[i+2]>a[i+1]+60?2:0;}
      const checks=[];
      for(const flat of [true,false]) for(const view of ['top','bottom']) {
        r.flatShading=flat; r.setView(view,false); r.camGoal=null;
        const expected=timed.map(i=>pixels(SF.buildPoseModel(steps.slice(0,i+1),m)));
        full.setFoldPercent(0); r.setMesh(mesh(full));
        // Scrub forward AND backwards without rebuilding the full mesh.
        for(const k of timed.map((_,i)=>i).concat(timed.map((_,i)=>i).reverse())) {
          full.setFoldPercent((k+1)/timed.length);
          const a=expected[k], b=pixels(full,true); let bad=0,covered=0;
          for(let i=0;i<a.length;i+=4){ const ca=cls(a,i),cb=cls(b,i); if(ca&&cb){covered++; if(ca!==cb)bad++;} }
          checks.push({step:timed[k]+1,view,flat,bad,covered});
        }
      }
      r.destroy && r.destroy(); canvas.remove(); return checks;
    });
    results.forEach(r=>assert(r.covered>100 && r.bad/r.covered<0.003, JSON.stringify(r)));
    assert.deepStrictEqual(errors,[]);
    console.log('PASS '+results.length+' GPU prefix/full playback comparisons; worst mismatched pixels: '+Math.max(...results.map(r=>r.bad)));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
