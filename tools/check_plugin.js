// Runs the real photoshop/main.js in Node with Photoshop, the panel DOM, WebSocket and fetch faked.
// Checks the sync loop, the part that can't be seen from ComfyUI:
//   1. on connect, every source the workflow needs is uploaded
//   2. a new history state (a brush stroke) re-uploads the canvas
//   3. nothing changed -> nothing uploaded
// Usage: node tools/check_plugin.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const W = 64, H = 64;
let pixels = new Uint8Array(W * H * 4).fill(10);
const doc = {
  id: 1, name: "t.psd", width: W, height: H, activeHistoryState: { id: 1 }, historyStates: [1],
  layers: [{ id: 8, name: "Capa 0", kind: "pixel", bounds: { left: 0, top: 0, right: W, bottom: H } }],
  activeLayers: [],
  bitsPerChannel: "bitDepth8",
  async createLayerGroup({ name }) {
    const g = { id: 300 + doc.layers.length, name, kind: "group", layers: [], bounds: {} };
    doc.layers.push(g); return g;
  },
  async createPixelLayer({ name }) {
    const l = { id: 100 + doc.layers.length, name, kind: "pixel", bounds: { left: 0, top: 0, right: 0, bottom: 0 },
      move(target) { doc.layers = doc.layers.filter((x) => x !== l); target.layers.push(l); } };
    doc.layers.push(l); return l;
  },
};
const writes = [];
let groupReads = 0, resumed = [];
const hostControl = {
  suspendHistory: async () => 7,
  // the rollback itself moves the history state, like the real one may: must not cause a re-read loop
  resumeHistory: async (id, commit) => { resumed.push(commit); doc.activeHistoryState = { id: doc.activeHistoryState.id + 1000 }; },
};
const photoshop = {
  app: {
    activeDocument: null,                  // Photoshop starts with no document open
    _docs: null,                           // explicit list for the multi-document scenario
    get documents() { return this._docs || (this.activeDocument ? [this.activeDocument] : []); },
    set documents(v) { this._docs = v; },
  },
  core: { executeAsModal: async (f) => f({ hostControl }) },
  action: { addNotificationListener() {} },
  imaging: {
    getPixels: async (o) => { if (o.layerID === 60) throw new Error("getPixels on a group"); return ({ sourceBounds: { left: 0, top: 0 }, imageData: {
      width: W, height: H, components: 4, getData: async () => pixels.slice(), dispose() {} } }); },
    getSelection: async () => { throw new Error("no selection"); },
    createImageDataFromBuffer: async (buf, o) => ({ buf, ...o, dispose() {} }),
    putPixels: async (o) => { if (o.documentID === doc.id) { doc.activeHistoryState = { id: doc.activeHistoryState.id + 1 }; doc.historyStates = [...doc.historyStates, 0]; } writes.push({ doc: o.documentID, layerID: o.layerID, type: o.imageData.buf.constructor.name, at: o.targetBounds }); },
  },
};

function el() {
  const e = { style: {}, children: [], attrs: {}, textContent: "", value: "",
    appendChild(c) { this.children.push(c); if (c) c.parent = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    insertBefore(c, ref) { this.children.splice(this.children.indexOf(ref), 0, c); c.parent = this; return c; },
    getBoundingClientRect() { const i = this.parent ? this.parent.children.indexOf(this) : 0; return { top: i * 40, height: 40 }; },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; }, addEventListener(k, f) { (this.on ||= {})[k] = f; },
    querySelector() { return null; }, querySelectorAll() { return []; } };
  Object.defineProperty(e, "innerHTML", { set() { e.children = []; } });
  return e;
}
const els = {};
const docListeners = {};
const document = { addEventListener: (k, f) => { docListeners[k] = f; }, removeEventListener: (k) => { delete docListeners[k]; },
  getElementById: (id) => (els[id] ||= el()), createElement: (tag) => Object.assign(el(), { tag }),
  createTextNode: (t) => ({ t }), activeElement: null };

const puts = [];
let ws;
class FakeWS {
  constructor(url) { ws = this; this.url = url; this.readyState = 1; this.sent = []; setTimeout(() => this.onopen?.(), 5); }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() {}
}
const fetch = async (url, opts = {}) => {
  if (opts.method === "PUT") puts.push(new URL(url).searchParams.get("key"));
  return { ok: true, text: async () => "", arrayBuffer: async () => new ArrayBuffer(url.includes("fmt=jpg") ? 4 : 4 * 4 * 4) };
};

const ctx = vm.createContext({
  require: (m) => (m === "photoshop" ? photoshop : { host: { uiLocale: "es", version: "test" } }),
  document, WebSocket: FakeWS, fetch, URLSearchParams, setTimeout, clearTimeout, setInterval,
  console, btoa: (s) => Buffer.from(s, "binary").toString("base64"), Promise, Error, Math, JSON,
  localStorage: { getItem: () => null, setItem() {} },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "photoshop", "main.js"), "utf8"), ctx);

let S_last;
const byClassAll = (e, c) => (e?.className || "").split(" ").includes(c) ? [e] : (e?.children || []).flatMap((x) => byClassAll(x, c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

(async () => {
  await sleep(20);
  const manifest = { sources: [{ id: 1, kind: "canvas", title: "Canvas", key: "canvas", bindable: true },
    { id: 2, kind: "layer", title: "Layer", binding: "Capa 0 #8", key: "layer:Capa 0 #8", bindable: true }],
    params: [], outputs: [{ id: 3, title: "Out", target: "layer", layer: "R" }] };
  ws.onmessage({ data: JSON.stringify({ type: "status", tab: true, manifest }) });
  await sleep(600);                        // a sync runs and bails out: no document yet
  photoshop.app.activeDocument = doc;      // the user opens one
  await sleep(800);
  if (!puts.includes("canvas") || !puts.includes("layer:Capa 0 #8")) fail(`on connect expected both uploads, got ${puts}`);
  console.log("OK  connect uploads:", puts.join(", "));

  puts.length = 0;
  pixels = new Uint8Array(W * H * 4).fill(200);              // a "brush stroke"
  doc.activeHistoryState = { id: 2 }; doc.historyStates = [1, 2];
  await sleep(1000);
  if (!puts.includes("canvas")) fail(`stroke did not re-upload the canvas (puts: ${puts})`);
  console.log("OK  stroke re-uploads:", puts.join(", "));

  puts.length = 0;
  doc.activeHistoryState = { id: 3 }; doc.historyStates = [1, 2, 3];   // history moved, pixels same
  await sleep(1000);
  if (puts.length) fail(`unchanged pixels were re-uploaded: ${puts}`);
  console.log("OK  unchanged pixels: no upload");
  // 4. results by destination: "+ New layer" creates once and re-binds the node; reused after that
  const result = (dest, id, name = "Retrato {n}") => ws.onmessage({ data: JSON.stringify({
    type: "result", id, w: 4, h: 4, x: 2, y: 3, dest, name, node: "13", doc: 1 }) });
  const rebinds = () => ws.sent.filter((m) => m.type === "set" && m.widget === "destination");
  puts.length = 0;
  result("new:layer", "r1"); await sleep(150);
  const bound = rebinds().pop()?.value;
  const created = doc.layers.find((l) => l.name === "Retrato 1");
  if (!created || bound !== `Retrato 1 #${created.id}`) fail(`new layer not created/re-bound: ${bound}`);
  result(bound, "r2"); await sleep(150);
  if (doc.layers.filter((l) => /^Retrato/.test(l.name)).length !== 1 || writes[0].layerID !== writes[1].layerID) fail(`bound layer not reused: ${JSON.stringify(writes)}`);
  console.log("OK  + New layer -> created as 'Retrato 1', node re-bound to it, reused next run");
  doc.layers.push({ id: 50, name: "Render", kind: "group", layers: [], bounds: {} });
  result("Render/ #50", "r3"); await sleep(150);
  const grp = doc.layers.find((l) => l.id === 50);
  if (grp.layers.length !== 1 || grp.layers[0].name !== "Retrato 1" || writes[2].layerID !== grp.layers[0].id) fail("existing group did not get a named layer inside");
  console.log("OK  existing group -> new layer inside named from the template:", grp.layers[0].name);
  doc.bitsPerChannel = "bitDepth16";
  result(bound, "r4"); await sleep(150);
  if (writes[3].type !== "Uint16Array") fail(`16-bit doc got ${writes[3].type}`);
  console.log("OK  16-bit document gets Uint16 pixels");
  doc.bitsPerChannel = "bitDepth8";
  // (putPixels moved history itself, like Photoshop does)
  pixels = new Uint8Array(W * H * 4).fill(77);
  await sleep(450);
  if (puts.length) fail(`our own write triggered an upload: ${puts}`);
  console.log("OK  own writes don't trigger uploads");

  // 5. a bound GROUP: read via duplicate + merge inside a discarded history suspension, no loop
  doc.layers.push({ id: 60, name: "Personaje", kind: "group", bounds: { left: 0, top: 0, right: W, bottom: H },
    layers: [], async duplicate() { groupReads++; return { async merge() { return { id: 61, bounds: { left: 0, top: 0, right: W, bottom: H } }; } }; } });
  puts.length = 0;
  manifest.sources.push({ id: 4, kind: "layer", title: "Group", binding: "Personaje #60", key: "layer:Personaje #60", bindable: true });
  ws.onmessage({ data: JSON.stringify({ type: "manifest", manifest }) });
  await sleep(700);
  if (!puts.includes("layer:Personaje #60")) fail(`group not uploaded (puts: ${puts})`);
  if (!resumed.length || resumed.some((c) => c !== false)) fail(`history not rolled back: ${resumed}`);
  const readsAfterFirst = groupReads;
  await sleep(1500);                       // the rollback moved history; nothing else happened
  if (groupReads !== readsAfterFirst) fail(`group re-read in a loop: ${groupReads} reads`);
  console.log(`OK  group read via merged copy, history rolled back, no loop (${groupReads} read)`);

  // 6. "+ New group": group named from the template (minus {n}), a layer per run; Live replaces
  result("new:group", "g1", "Variaciones {n}"); await sleep(150);
  const gBound = rebinds().pop()?.value;
  const groups = doc.layers.filter((l) => l.name === "Variaciones" && l.kind === "group");
  if (groups.length !== 1 || gBound !== `Variaciones/ #${groups[0].id}`) fail(`new group not created/re-bound: ${gBound}`);
  result(gBound, "g2", "Variaciones {n}"); await sleep(150);
  const kids = groups[0].layers.map((l) => l.name);
  if (kids.join() !== "Variaciones 1,Variaciones 2") fail(`group kids: ${kids}`);
  vm.runInContext("S.live = true", ctx);
  result(gBound, "g3", "Variaciones {n}"); await sleep(150);
  if (groups[0].layers.length !== 2 || writes[writes.length - 1].layerID !== groups[0].layers[1].id) fail("live run added a layer instead of replacing the latest");
  vm.runInContext("S.live = false", ctx);
  console.log("OK  + New group -> 'Variaciones', node re-bound, a layer per run (", kids.join(", "), "), Live replaces the latest");

  // 7. bound by id: renamed group still used, written into ITS document while another is active
  const grp2 = groups[0]; grp2.name = "Var (renamed)";
  const other = { id: 2, name: "otro.psd", width: W, height: H, layers: [], activeHistoryState: { id: 1 }, historyStates: [1], bitsPerChannel: "bitDepth8" };
  photoshop.app.documents = [doc, other];
  photoshop.app.activeDocument = other;
  result(gBound, "b1", "Variaciones {n}"); await sleep(200);
  const last = writes[writes.length - 1];
  if (last.doc !== 1) fail(`result went to document ${last.doc}, not to its own (1)`);
  if (doc.layers.filter((l) => l.kind === "group" && /^Var/.test(l.name)).length !== 1 || grp2.layers.length !== 3) fail("bound group not reused after rename");
  console.log("OK  bound by id: renamed group reused, written to its own document while another is active");
  photoshop.app.documents = [other];                 // its document got closed
  const nWrites = writes.length;
  result("new:layer", "b2"); await sleep(200);
  if (writes.length !== nWrites) fail("wrote into another document after its own was closed");
  if (!ws.sent.some((m) => m.type === "log" && /cerr/.test(m.message))) fail("closed document not reported");
  console.log("OK  closed document: nothing written, user told");
  photoshop.app.documents = [doc, other]; photoshop.app.activeDocument = doc;

  // 8. panel destination line
  vm.runInContext("publishDoc()", ctx);       // the panel refreshes its document snapshot before painting
  const ow = vm.runInContext("outWhere", ctx);
  const lines = [ow({ dest: "panel" }), ow({ dest: "new:group", name: "Var {n}" }), ow({ dest: gBound }), ow({ dest: bound })];
  if (!/panel/.test(lines[0]) || !/Var/.test(lines[1]) || !/Var \(renamed\)\/ · capa nueva/.test(lines[2]) || !/Retrato 1 · se sustituye/.test(lines[3])) fail(`outWhere: ${lines.join(" | ")}`);
  console.log("OK  panel says where it lands:", lines.join(" | "));

  // 9. PS 27 with nothing selected: getSelection resolves without imageData instead of throwing
  photoshop.imaging.getSelection = async () => ({});
  const empty = await vm.runInContext("readSourceRaw", ctx)({ kind: "selection" });
  if (empty.w !== 0 || empty.data.length !== 0) fail(`no selection should read as empty, got ${JSON.stringify(empty)}`);
  console.log("OK  nothing selected (no imageData) reads as an empty selection");

  // 10. a selection is read as ITS box scaled, placed at its offset (never stretched over the document)
  let asked = null;
  doc.selection = { bounds: { left: 384, top: 100, right: 1184, bottom: 900 } };
  photoshop.imaging.getSelection = async (o) => { asked = o; const t = o.targetSize || { width: 800, height: 800 };
    return { sourceBounds: o.sourceBounds, imageData: { width: t.width, height: t.height, components: 1,
      getData: async () => new Uint8Array(t.width * t.height), dispose() {} } }; };
  vm.runInContext("S.maxSide = 1024; S.doc = { ...S.doc, w: 2048, h: 2048 }", ctx);   // scale 0.5
  const sel = await vm.runInContext("readSourceRaw", ctx)({ kind: "selection" });
  const k = vm.runInContext("scale()", ctx);
  const want = { w: Math.round(800 * k), x: Math.round(384 * k), y: Math.round(100 * k) };
  if (k >= 1 || !asked.targetSize || asked.targetSize.width !== want.w || sel.w !== want.w || sel.x !== want.x || sel.y !== want.y)
    fail(`selection read wrong: scale ${k}, asked ${JSON.stringify(asked)}, got w${sel.w} x${sel.x} y${sel.y}, want ${JSON.stringify(want)}`);
  doc.selection = { bounds: null };
  const none = await vm.runInContext("readSourceRaw", ctx)({ kind: "selection" });
  if (none.w !== 0) fail("selection.bounds null should read as empty");
  delete doc.selection;
  console.log(`OK  selection read as its own box at x${sel.x} y${sel.y} (${sel.w}px wide at scale ${k.toFixed(2)}), empty when bounds is null`);

  // 11. the DOM selection API throws (PS 27: "reading 'batchPlay'"): one native read finds the box
  const calls = [];
  Object.defineProperty(doc, "selection", { configurable: true, get() { return { get bounds() { throw new TypeError("Cannot read properties of undefined (reading 'batchPlay')"); } }; } });
  photoshop.imaging.getSelection = async (o) => { calls.push(o); const t = o.targetSize || { width: 800, height: 800 };
    return { sourceBounds: o.sourceBounds || { left: 384, top: 100, right: 1184, bottom: 900 }, imageData: { width: t.width, height: t.height,
      components: 1, getData: async () => new Uint8Array(t.width * t.height), dispose() {} } }; };
  const fb = await vm.runInContext("readSourceRaw", ctx)({ kind: "selection" });
  if (calls.length !== 2 || calls[1].targetSize?.width !== want.w || fb.w !== want.w || fb.x !== want.x || fb.y !== want.y)
    fail(`fallback read wrong: calls ${JSON.stringify(calls)}, got w${fb.w} x${fb.x} y${fb.y}`);
  console.log("OK  selection API throwing: found the box with one native read, placed it right");

  // 12. a real getSelection failure is reported, not passed off as "nothing selected"
  Object.defineProperty(doc, "selection", { configurable: true, value: { bounds: { left: 0, top: 0, right: 10, bottom: 10 } }, writable: true });
  photoshop.imaging.getSelection = async () => { throw new Error("boom"); };
  const nSent = ws.sent.length;
  await vm.runInContext("readSourceRaw", ctx)({ kind: "selection" });
  if (!ws.sent.slice(nSent).some((m) => m.type === "log" && /selection: boom/.test(m.message))) fail("getSelection error was swallowed");
  ws.sent.splice(nSent);                            // expected error, keep the final check clean
  delete doc.selection;
  console.log("OK  getSelection error reported, not shown as an empty selection");

  // 13. saved selections: alpha channels and paths are listed, read through a rolled-back selection
  const boxC = { left: 4, top: 6, right: 20, bottom: 30 }, boxP = { left: 30, top: 2, right: 60, bottom: 12 };
  let live = { left: 0, top: 0, right: 8, bottom: 8 };     // the user's own selection
  Object.defineProperty(doc, "selection", { configurable: true, get() { return { bounds: live, load: async () => { live = boxC; } }; } });
  doc.channels = [{ id: 20, name: "Rojo", kind: "component" }, { id: 21, name: "Cara", kind: "selectedAreaAlpha" }];
  doc.pathItems = [{ id: 30, name: "Silueta", makeSelection: async () => { live = boxP; } }];
  photoshop.imaging.getSelection = async (o) => { const b = o.sourceBounds, t = o.targetSize || { width: b.right - b.left, height: b.bottom - b.top };
    return { sourceBounds: b, imageData: { width: t.width, height: t.height, components: 1, getData: async () => new Uint8Array(t.width * t.height), dispose() {} } }; };
  vm.runInContext("publishDoc()", ctx);
  const masks = vm.runInContext("S.doc.masks", ctx).map((x) => x.binding);
  if (masks.join() !== "channel:Cara #21,path:Silueta #30") fail(`saved masks listed wrong: ${masks}`);
  const nRes = resumed.length;
  const ch = await vm.runInContext("readSourceRaw", ctx)({ kind: "selection", binding: "channel:Cara #21" });
  const pa = await vm.runInContext("readSourceRaw", ctx)({ kind: "selection", binding: "path:Silueta #30" });
  const gone = await vm.runInContext("readSourceRaw", ctx)({ kind: "selection", binding: "channel:Otra #99" });
  if (ch.x !== 4 || ch.y !== 6 || ch.w !== 16 || pa.x !== 30 || pa.w !== 30) fail(`saved mask read wrong: channel ${JSON.stringify([ch.x, ch.y, ch.w])} path ${JSON.stringify([pa.x, pa.w])}`);
  if (resumed.slice(nRes).join() !== "false,false") fail(`saved mask reads not rolled back: ${resumed.slice(nRes)}`);
  if (!gone.missing) fail("a deleted channel should read as missing");
  const opts = vm.runInContext("selectionOptions", ctx)("channel:Otra #99").map((o) => o.value);
  if (opts.join() !== "@selection,channel:Cara #21,path:Silueta #30,channel:Otra #99") fail(`selection dropdown offers ${opts}`);
  delete doc.selection; delete doc.channels; delete doc.pathItems;
  console.log("OK  saved channel and path listed, read in place and rolled back; a deleted one is missing; the dropdown offers them all");

  // 14. other documents: an Input bound to one reads it while another is active; an Output saves its own
  const big = { id: 5, name: "obj.psb", width: W * 2, height: H, layers: [{ id: 9, name: "Pinta", kind: "pixel", bounds: { left: 0, top: 0, right: W, bottom: H } }],
    activeHistoryState: { id: 1 }, historyStates: [1], bitsPerChannel: "bitDepth8", saved: 0,
    async save() { this.saved++; }, async createPixelLayer({ name }) { const l = { id: 77, name, kind: "pixel", bounds: {} }; this.layers.push(l); return l; } };
  photoshop.app.documents = [doc, big]; photoshop.app.activeDocument = doc;
  vm.runInContext("publishDoc()", ctx);
  const sentDocs = ws.sent.filter((m) => m.type === "doc").pop()?.doc?.docs?.map((x) => x.name);
  if (String(sentDocs) !== "t.psd,obj.psb") fail(`every open document should be published, got ${sentDocs}`);
  const read = [];
  const gp = photoshop.imaging.getPixels;
  photoshop.imaging.getPixels = async (o) => { read.push(o.documentID); return gp(o); };
  const r1 = await vm.runInContext("readSourceRaw", ctx)({ kind: "layer", binding: "Pinta #9", doc: "obj.psb #5" });
  const r2 = await vm.runInContext("readSourceRaw", ctx)({ kind: "canvas", doc: "obj.psb #999" });   // reopened: id changed, name still matches
  const r3 = await vm.runInContext("readSourceRaw", ctx)({ kind: "canvas", doc: "cerrado.psd #42" });
  photoshop.imaging.getPixels = gp;
  if (read.join() !== "5,5" || r1.dw !== W * 2 || r2.dw !== W * 2) fail(`bound document read wrong: docs ${read} sizes ${r1.dw},${r2.dw}`);
  if (!r3.missing) fail("a closed bound document should read as missing");
  const nW = writes.length;
  ws.onmessage({ data: JSON.stringify({ type: "result", id: "s2", w: 4, h: 4, x: 0, y: 0, node: 3, dest: "new:layer", name: "R", doc: 5, save: true }) });
  await sleep(200);
  if (writes.slice(nW).pop()?.doc !== 5 || big.saved !== 1) fail(`output to another document: wrote to ${writes.slice(nW).pop()?.doc}, saved ${big.saved}`);
  photoshop.app.documents = [doc];
  console.log("OK  other documents: all published, bound Input reads its own (id, then name), closed one missing, Output writes there and saves");

  // 16. {n} counts past what the siblings already use; Live results racing the re-bind reuse the new layer
  const nTop = () => doc.layers.filter((l) => /^Toma \d+$/.test(l.name)).map((l) => l.name);
  doc.layers.push({ id: 90, name: "Toma 4", kind: "pixel", bounds: {} });
  for (const id of ["n1", "n2"]) ws.onmessage({ data: JSON.stringify({ type: "result", id, w: 4, h: 4, x: 0, y: 0, dest: "new:layer", name: "Toma {n}", node: "77", doc: 1 }) });
  await sleep(300);
  if (String(nTop()) !== "Toma 4,Toma 5") fail(`two racing "new:layer" results should make one layer "Toma 5", got ${nTop()}`);
  S_last = vm.runInContext("S.lastResult", ctx);
  await vm.runInContext("writeResult", ctx)(S_last, true);
  if (String(nTop()) !== "Toma 4,Toma 5,Toma 6") fail(`Add as layer should number on, got ${nTop()}`);
  console.log("OK  {n} numbers on from the siblings (Toma 5, Toma 6); a Live result racing the re-bind reuses the new layer");

  // 17. live sampling frames: LIVE badge with the step, gone on the result, CANCELADO when stopped
  const badge = () => els.liveBadge.style.display === "none" ? "" : els.liveBadge.textContent;
  const frame = () => ws.onmessage({ data: new Uint8Array([0xff, 0xd8, 0xff, 0]).buffer });
  const st = (o) => ws.onmessage({ data: JSON.stringify({ type: "run_status", ...o }) });
  st({ state: "running" }); frame(); st({ state: "progress", value: 3, max: 8 });
  if (badge() !== "LIVE · 3/8") fail(`badge while sampling: "${badge()}"`);
  ws.onmessage({ data: JSON.stringify({ type: "result", id: "lv", w: 4, h: 4, x: 0, y: 0, dest: "panel", name: "x", node: "1", doc: 1 }) });
  await sleep(50); frame();
  if (badge() !== "" || !String(els.preview.src).startsWith("data:image/jpeg")) fail(`after the result: badge "${badge()}"`);
  st({ state: "idle" });
  st({ state: "running" }); frame(); st({ state: "idle", interrupted: true });
  if (badge() !== "CANCELADO") fail(`stopped mid-sampling: "${badge()}"`);
  st({ state: "idle", unchanged: true });
  if (!/No ha cambiado nada/.test(els.previewEmpty.textContent)) fail("an unchanged run should say so");
  console.log("OK  live frames: LIVE · 3/8 while sampling, hidden once the result lands, CANCELADO when stopped");

  // 18. drag a control by its grip: the new order goes to the tab
  ws.onmessage({ data: JSON.stringify({ type: "manifest", manifest: { sources: [], outputs: [], workflows: [], workflow: "",
    params: ["A", "B", "C"].map((name, i) => ({ id: 30 + i, kind: "number", name, value: 0, min: 0, max: 1, step: 0.1 })) } }) });
  await sleep(20);
  const grips = byClassAll(els.params, "grip");
  grips[2].on.mousedown({});                         // grab C
  docListeners.mousemove({ clientY: 5 });            // above A's middle
  docListeners.mouseup({});
  const order = ws.sent.filter((m) => m.type === "order").pop()?.ids;
  if (String(order) !== "32,30,31") fail(`drag C to the top should send 32,30,31, got ${order}`);
  console.log("OK  dragging a control by its grip reorders the panel and saves the order");

  // 15. workflow picker opens another workflow; Bridge Choice shows as a list, a boolean one as a checkbox
  const find = (e, tag) => e?.tag === tag ? [e] : (e?.children || []).flatMap((c) => find(c, tag));
  const byClass = (e, c) => (e?.className || "").split(" ").includes(c) ? [e] : (e?.children || []).flatMap((x) => byClass(x, c));
  const text = (e) => e.children.map((c) => c.t ?? "").join("");
  ws.onmessage({ data: JSON.stringify({ type: "manifest", manifest: { sources: [], outputs: [],
    workflows: ["workflows/Live SD.json", "workflows/sub/Inpaint.json", "workflows/sub/deep/Klein tools.json"], workflow: "workflows/Live SD.json",
    params: [{ id: 20, kind: "choice", name: "Sampler", value: "euler", options: ["euler", "dpmpp_2m"] },
      { id: 21, kind: "toggle", name: "Upscale", value: false }] } }) });
  await sleep(50);
  const [head] = byClass(els.wfBox, "wfHead");
  head.on.click();
  const shown = () => [...byClass(els.wfBox, "wfFolder"), ...byClass(els.wfBox, "wfItem")].map(text);
  if (String(shown()) !== "▸ sub/,Live SD") fail(`folders should start folded: ${shown()}`);
  byClass(els.wfBox, "wfFolder")[0].on.click();
  if (String(shown()) !== "▾ sub/,▸ deep/,Inpaint,Live SD") fail(`unfolded sub: ${shown()}`);
  find(els.wfBox, "sp-textfield")[0].on.input({ target: { value: "kl tool" } });
  if (String(byClass(els.wfBox, "wfItem").map(text)) !== "Klein tools   sub/deep/") fail(`fuzzy search: ${byClass(els.wfBox, "wfItem").map(text)}`);
  byClass(els.wfBox, "wfItem")[0].on.click();
  if (ws.sent.pop()?.path !== "workflows/sub/deep/Klein tools.json") fail("picking a workflow did not ask the tab to open it");
  const [choice] = find(els.params, "sp-picker"), [toggle] = find(els.params, "sp-checkbox");
  if (!choice || !toggle || find(choice, "sp-menu-item").length !== 2) fail("choice/toggle params not rendered");
  choice.on.change({ target: { value: "dpmpp_2m" } }); await sleep(200);
  toggle.on.change({ target: { checked: true } }); await sleep(200);
  const sets = ws.sent.filter((m) => m.type === "set" && (m.node === 20 || m.node === 21)).map((m) => `${m.node}=${m.value}`);
  if (String(sets) !== "20=dpmpp_2m,21=true") fail(`choice/toggle sent ${sets}`);
  console.log("OK  workflow picker opens the chosen workflow; Choice as a list, boolean Choice as a checkbox");

  await vm.runInContext("run", ctx)();
  const runMsg = ws.sent.filter((m) => m.type === "run").pop();
  if (!Array.isArray(runMsg?.sources)) fail(`a run should carry the uploaded hashes: ${JSON.stringify(runMsg)}`);
  console.log("OK  a run carries what was uploaded; an unchanged run is reported, not re-generated");

  const errors = ws.sent.filter((m) => m.type === "log" && !/connected|cerr/.test(m.message));
  if (errors.length) fail(`plugin reported errors: ${JSON.stringify(errors)}`);
  console.log("OK  no errors reported");
  process.exit(0);
})();
