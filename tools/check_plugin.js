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
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; }, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; } };
  Object.defineProperty(e, "innerHTML", { set() { e.children = []; } });
  return e;
}
const els = {};
const document = { getElementById: (id) => (els[id] ||= el()), createElement: el,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

(async () => {
  await sleep(20);
  const manifest = { sources: [{ id: 1, kind: "canvas", title: "Canvas", key: "canvas" },
    { id: 2, kind: "layer", title: "Layer", binding: "Capa 0 #8", key: "layer:Capa 0 #8" }],
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
  manifest.sources.push({ id: 4, kind: "layer", title: "Group", binding: "Personaje #60", key: "layer:Personaje #60" });
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

  const errors = ws.sent.filter((m) => m.type === "log" && !/connected|cerr/.test(m.message));
  if (errors.length) fail(`plugin reported errors: ${JSON.stringify(errors)}`);
  console.log("OK  no errors reported");
  process.exit(0);
})();
