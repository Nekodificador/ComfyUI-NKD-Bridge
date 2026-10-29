// NKD Comfy Bridge — Photoshop side (UXP).
// Watches the layers the open ComfyUI workflow asks for, uploads them only when their pixels
// change, asks the ComfyUI browser tab to run, and writes results back into named layers.
// Protocol reference: tools/fake_host.py in the node pack.
const { app, core, action, imaging } = require("photoshop");
const uxp = require("uxp");

const VERSION = "0.3.0";
const $ = (id) => document.getElementById(id);

// ── i18n ────────────────────────────────────────────────────────────────────────────────────
const T = {
  en: {
    off: "Not connected, retrying…", noTab: "Connected · open ComfyUI in your browser",
    ok: "Connected to ComfyUI", run: "Generate", cancel: "Stop", live: "Live",
    addLayer: "Add preview as layer", server: "ComfyUI address", res: "Send resolution (longest side)",
    resFull: "Full document", resHint: "Lower = faster. 512–768 is plenty for live SD1.5 + LCM.",
    connect: "Save & reconnect", params: "Controls", sources: "Inputs", outputs: "Outputs",
    empty: "Open a workflow in ComfyUI that uses 😺NKD Bridge nodes (Canvas, Layer, Selection, Output). They will show up here.",
    noPreview: "Results and live previews appear here.", noDoc: "Open a document in Photoshop.",
    unbound: "not bound, pick a layer", missing: "layer not found", useActive: "Use active",
    canvas: "Whole document", selection: "Current selection", toLayer: "→ layer", toPanel: "→ panel",
    runThis: "Run only this", noTabRun: "Open ComfyUI in your browser first (any tab works).",
    running: "Generating…", group: "group",
    tabGen: "Generate", tabIo: "Inputs & outputs", tLayer: "Layer", tGroup: "Group", tPanel: "Panel only",
    intoGroup: "→ into", willCreateGroup: "→ will create the group", willCreate: "→ will create the layer",
    perRun: "a new layer each run", replaced: "replaced each run", recreate: "will be created again",
    nameLabel: "Name for new layers", insertVar: "Add to the name",
    docClosed: "The document this result belongs to was closed", layerName: "Layer or group name",
  },
  es: {
    off: "Sin conexión, reintentando…", noTab: "Conectado · abre ComfyUI en el navegador",
    ok: "Conectado a ComfyUI", run: "Generar", cancel: "Parar", live: "Live",
    addLayer: "Añadir preview como capa", server: "Dirección de ComfyUI", res: "Resolución de envío (lado largo)",
    resFull: "Documento completo", resHint: "Menos = más rápido. Para live con SD1.5 + LCM bastan 512–768.",
    connect: "Guardar y reconectar", params: "Controles", sources: "Entradas", outputs: "Salidas",
    empty: "Abre en ComfyUI un workflow con nodos 😺NKD Bridge (Canvas, Layer, Selection, Output). Aparecerán aquí.",
    noPreview: "Aquí verás los resultados y la preview en vivo.", noDoc: "Abre un documento en Photoshop.",
    unbound: "sin vincular, elige una capa", missing: "no encuentro la capa", useActive: "Usar activa",
    canvas: "Documento entero", selection: "Selección actual", toLayer: "→ capa", toPanel: "→ panel",
    runThis: "Ejecutar solo esta", noTabRun: "Abre antes ComfyUI en el navegador (cualquier pestaña).",
    running: "Generando…", group: "grupo",
    tabGen: "Generar", tabIo: "Entradas y salidas", tLayer: "Capa", tGroup: "Grupo", tPanel: "Solo panel",
    intoGroup: "→ dentro de", willCreateGroup: "→ creará el grupo", willCreate: "→ creará la capa",
    perRun: "capa nueva cada vez", replaced: "se sustituye", recreate: "se volverá a crear",
    nameLabel: "Nombre de las capas nuevas", insertVar: "Añadir al nombre",
    docClosed: "Se cerró el documento al que pertenece este resultado", layerName: "Nombre de capa o grupo",
  },
};
const L = T[String(uxp.host?.uiLocale || "en").slice(0, 2)] || T.en;

// ── state ───────────────────────────────────────────────────────────────────────────────────
const store = {
  get: (k, d) => { try { const v = localStorage.getItem("nkd." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("nkd." + k, JSON.stringify(v)); } catch {} },
};
const S = {
  url: store.get("url", "http://127.0.0.1:8188"),
  maxSide: store.get("maxSide", 1024),
  ws: null, connected: false, tab: false, manifest: null,
  doc: null, docJson: "",
  sent: {},            // key -> hash last uploaded (only re-send on change)
  srcState: {},        // key -> "ok" | "busy" | "bad"
  syncing: null, resync: false,
  busy: false, pending: false, live: false,
  ownWriteUntil: 0,    // ignore Photoshop events caused by our own layer writes
  lastResult: null,
  runStart: 0, runAvg: 0,
};

// ── utils ───────────────────────────────────────────────────────────────────────────────────
function fnv(bytes) {                       // fast content hash; collisions just cost one re-upload
  let h = 0x811c9dc5;
  const n = bytes.length, words = (bytes.byteOffset % 4 === 0) ? n >> 2 : 0;
  if (words) {
    const u = new Uint32Array(bytes.buffer, bytes.byteOffset, words);
    for (let i = 0; i < words; i++) h = Math.imul(h ^ u[i], 16777619);
  }
  for (let i = words << 2; i < n; i++) h = Math.imul(h ^ bytes[i], 16777619);
  return (h >>> 0).toString(16) + ":" + n;
}

function b64(buf) {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A Photoshop or network call that never settles would freeze syncing forever; fail loudly instead. */
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const send = (msg) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); };

/** Errors go to the panel AND the ComfyUI console, where they can actually be read. */
function report(where, e) {
  const text = `${where}: ${(e && (e.message || e.toString())) || e}`;
  console.error("[NKD Bridge]", text, e);
  send({ type: "log", message: text });
  flash(text);
}

// ── document ────────────────────────────────────────────────────────────────────────────────
function flatLayers(layers, prefix = "", out = []) {
  for (const l of layers || []) {
    const path = prefix ? prefix + "/" + l.name : l.name;
    const group = String(l.kind).toLowerCase() === "group";
    out.push({ id: l.id, name: l.name, path, kind: group ? "group" : "layer", ref: l });
    if (group) flatLayers(l.layers, path, out);
  }
  return out;
}

function readDoc() {
  const d = app.activeDocument;
  if (!d) return null;
  const layers = flatLayers(d.layers);
  return { id: d.id, name: d.name, w: Math.round(d.width), h: Math.round(d.height), layers };
}

function publishDoc() {
  try { S.doc = readDoc(); } catch (e) { report("document", e); return; }
  const wire = S.doc && { ...S.doc, layers: S.doc.layers.map(({ ref, ...l }) => l) };
  const json = JSON.stringify(wire);
  if (json !== S.docJson) { S.docJson = json; send({ type: "doc", doc: wire }); renderLists(); }
}

/** "Group/Sub/Name #id" -> the layer, by id first (survives renames), then by path. */
function findBinding(layers, binding) {
  if (!binding) return null;
  const m = /#(\d+)\s*$/.exec(binding);
  const path = binding.replace(/\s*#\d+\s*$/, "").replace(/\/$/, "");
  return (m && layers.find((l) => l.id === +m[1])) || layers.find((l) => l.path === path)
    || layers.find((l) => l.name === path) || null;    // plain names typed by hand still work
}
const bindingName = (b) => String(b || "").replace(/\s*#\d+\s*$/, "").replace(/\/$/, "").split("/").pop() || "NKD Result";

function resolveBinding(binding) {
  return S.doc ? findBinding(S.doc.layers, binding) : null;
}

const scale = () => {
  if (!S.doc || !S.maxSide) return 1;
  return Math.min(1, S.maxSide / Math.max(S.doc.w, S.doc.h));
};

// ── reading pixels ──────────────────────────────────────────────────────────────────────────
let readsNeedModal = false;   // learnt once: some Photoshop builds only allow imaging reads inside a modal
async function readSource(src) {
  if (readsNeedModal) {
    let out;
    await core.executeAsModal(async (ctx) => {
      modalCtx = ctx;                        // a group read inside must reuse it: modals don't nest
      try { out = await readSourceRaw(src); } finally { modalCtx = null; }
    }, { commandName: "NKD Bridge read" });
    return out;
  }
  try { return await readSourceRaw(src); }
  catch (e) {
    if (!/modal/i.test(String(e && e.message))) throw e;
    readsNeedModal = true;
    return readSource(src);
  }
}

async function readSourceRaw(src) {
  const d = app.activeDocument, s = scale();
  const dw = Math.max(1, Math.round(S.doc.w * s)), dh = Math.max(1, Math.round(S.doc.h * s));
  const base = { dw, dh };
  let res;
  try {
    if (src.kind === "selection") {
      res = await withTimeout(imaging.getSelection({ documentID: d.id, ...(s < 1 && { targetSize: { width: dw, height: dh } }) }), 8000, "getSelection");
    } else if (src.kind === "canvas") {
      res = await withTimeout(imaging.getPixels({ documentID: d.id, componentSize: 8, applyAlpha: false,
        ...(s < 1 && { targetSize: { width: dw, height: dh } }) }), 8000, "getPixels(canvas)");
    } else {
      const layer = resolveBinding(src.binding);
      if (!layer) return { missing: true };
      const b = layer.ref.bounds;
      const bw = b.right - b.left, bh = b.bottom - b.top;
      if (bw <= 0 || bh <= 0) return { ...base, w: 0, h: 0, c: 4, x: 0, y: 0, data: new Uint8Array(0) };
      if (layer.kind === "group") return await readGroup(layer.ref, s, base);
      res = await withTimeout(imaging.getPixels({ documentID: d.id, layerID: layer.id, componentSize: 8, applyAlpha: false,
        ...(s < 1 && { targetSize: { width: Math.max(1, Math.round(bw * s)), height: Math.max(1, Math.round(bh * s)) } }) }), 8000, "getPixels(layer)");
    }
  } catch (e) {
    // only "nothing selected" is a normal error; anything else must surface, not turn into black
    if (src.kind === "selection" && !/modal/i.test(String(e && e.message))) return { ...base, w: 0, h: 0, c: 1, x: 0, y: 0, data: new Uint8Array(0) };
    throw e;
  }
  return pixelsOf(res, s, base);
}

async function pixelsOf(res, s, base) {
  const img = res.imageData;
  try {
    const data = await withTimeout(img.getData({ chunky: true }), 8000, "getData");
    const sb = res.sourceBounds || { left: 0, top: 0 };
    return { ...base, w: img.width, h: img.height, c: img.components,
      x: Math.round(sb.left * s), y: Math.round(sb.top * s), data };
  } finally { img.dispose(); }
}

/** A group has no pixels of its own (getPixels fails on it). Duplicate it, merge the copy (Photoshop
 *  applies the children's visibility, opacity and blend modes), read it, then roll the document back:
 *  the history suspension is resumed WITHOUT committing, so nothing shows in the user's history. */
let modalCtx = null;
async function readGroup(group, s, base) {
  const d = app.activeDocument;
  const work = async (ctx) => {
    const hc = ctx.hostControl;
    const sid = await hc.suspendHistory({ documentID: d.id, name: "NKD Bridge read" });
    try {
      const copy = await group.duplicate();
      const merged = (await copy.merge()) || copy;
      const b = merged.bounds;
      const bw = b.right - b.left, bh = b.bottom - b.top;
      if (bw <= 0 || bh <= 0) return { ...base, w: 0, h: 0, c: 4, x: 0, y: 0, data: new Uint8Array(0) };
      const res = await imaging.getPixels({ documentID: d.id, layerID: merged.id, componentSize: 8, applyAlpha: false,
        ...(s < 1 && { targetSize: { width: Math.max(1, Math.round(bw * s)), height: Math.max(1, Math.round(bh * s)) } }) });
      return await pixelsOf(res, s, base);
    } finally {
      await hc.resumeHistory(sid, false);   // discard: the duplicate and the merge never happened
      ownStateKey = historyKey();           // if the rollback still moved history, the poll ignores it
    }
  };
  if (modalCtx) return work(modalCtx);
  let out;
  await withTimeout(core.executeAsModal(async (ctx) => { out = await work(ctx); }, { commandName: "NKD Bridge read group" }),
    10000, "read group");
  return out;
}

async function upload(key, r, hash) {
  const q = new URLSearchParams({ key, w: r.w, h: r.h, c: r.c, x: r.x, y: r.y, dw: r.dw, dh: r.dh, hash });
  const d = r.data;   // UXP fetch wants an ArrayBuffer, not a typed-array view
  const body = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d.buffer : d.slice().buffer;
  const res = await withTimeout(fetch(`${S.url}/nkd_bridge/source?${q}`, { method: "PUT", body }), 15000, "upload");
  if (!res.ok) throw new Error(await res.text());
}

/** Upload every source the workflow needs whose pixels changed. Resolves true if any did. */
function syncSources(force = []) {
  if (S.syncing) { S.resync = true; return S.syncing; }
  S.syncing = (async () => {
    // Yield first: if the body finished synchronously, `finally` would clear S.syncing BEFORE this
    // promise is assigned to it, and every later sync would think one is still running. (It did.)
    await null;
    let changed = false;
    try { do {
      S.resync = false;
      if (!S.connected || !S.manifest) break;
      if (!app.activeDocument) { flash(L.noDoc); break; }
      publishDoc();
      for (const src of S.manifest.sources || []) {
        try {
          const r = await readSource(src);
          if (r.missing) {
            if (S.srcState[src.key] !== "bad") report(src.title, new Error(`${L.missing}: ${src.binding}`));
            S.srcState[src.key] = "bad"; continue;
          }
          const h = fnv(r.data) + `@${r.x},${r.y},${r.dw}x${r.dh}`;
          if (S.sent[src.key] !== h || force.includes(src.key)) {
            S.srcState[src.key] = "busy"; renderLists();
            await upload(src.key, r, h);
            S.sent[src.key] = h; changed = true;
          }
          S.srcState[src.key] = "ok";
        } catch (e) {
          report(`${src.title} (${src.kind})`, e);
          S.srcState[src.key] = "bad";
        }
      }
      force = [];
      renderLists();
    } while (S.resync); }
    catch (e) { report("sync", e); }
    finally { S.syncing = null; }   // a failed sync must never block the next one
    return changed;
  })();
  return S.syncing;
}

// ── running ─────────────────────────────────────────────────────────────────────────────────
async function run(outputs) {
  if (!S.tab) { flash(L.noTabRun); return; }
  S.busy = true; S.pending = false; renderRun();
  await syncSources();
  S.runStart = Date.now();
  send({ type: "run", outputs: outputs || null });
}

function requestRun() {                    // live: never more than one job in flight
  if (S.busy) S.pending = true;
  else run();
}

function onIdle() {
  if (S.runStart) {
    const dt = Date.now() - S.runStart;
    S.runAvg = S.runAvg ? S.runAvg * 0.7 + dt * 0.3 : dt;
    S.runStart = 0;
  }
  S.busy = false; setProgress(0); renderRun();
  if (S.live && S.pending) run();
}

// ── results ─────────────────────────────────────────────────────────────────────────────────
function showImage(buf, mime) {
  $("preview").src = `data:${mime};base64,${b64(buf)}`;
  show("previewEmpty", !(true));
}

async function onResult(msg) {
  S.lastResult = msg;
  const jpg = await (await fetch(`${S.url}/nkd_bridge/result/${msg.id}?fmt=jpg`)).arrayBuffer();
  showImage(jpg, "image/jpeg");
  $("btnAddLayer").disabled = false;
  if (msg.dest && msg.dest !== "panel") await writeResult(msg);
}

/** The result goes back to the document its pixels came from, even if another one is active now. */
function resultDoc(msg) {
  if (msg.doc == null) return app.activeDocument;
  const d = (app.documents || []).find((x) => x.id === msg.doc);
  if (!d) throw new Error(L.docClosed);
  return d;
}

/** Results arrive as 8-bit; Photoshop wants pixels in the document's own depth
 *  (16-bit is 0..32768 in UXP, 32-bit is float). */
function toDocDepth(raw, d) {
  const bits = String(d.bitsPerChannel ?? "8");
  if (/32/.test(bits)) return Float32Array.from(raw, (v) => v / 255);
  if (/16/.test(bits)) return Uint16Array.from(raw, (v) => Math.round(v * 32768 / 255));
  return raw;
}

/** Where a result goes, from the Output node's single "destination". Runs inside the write modal.
 *  a layer:  replaced on every run.
 *  a group:  a new layer inside per run, so variations pile up. While Live is on the latest one is
 *            replaced instead, or every stroke would add a layer.
 *  new:layer / new:group: created now, and the node is re-bound to what got created.
 *  Layers it creates are named from the node's name template; {n} is filled in here. */
const lastInGroup = {};
const fillN = (tpl, n) => String(tpl || "NKD {n}").replace(/\{\s*n\s*\}/g, String(n)).trim();
const groupName = (tpl) => String(tpl || "").replace(/\{\s*n\s*\}/g, "").replace(/[\s·_-]+$/, "").trim() || "NKD";

async function newLayerIn(d, group, tpl) {
  const kids = flatLayers(group.layers || []).filter((l) => l.kind !== "group");
  const layer = await d.createPixelLayer({ name: fillN(tpl, kids.length + 1) });
  await layer.move(group, "placeInside");
  lastInGroup[group.id] = layer.id;
  return layer;
}

async function targetLayer(d, msg, forceNew) {
  const all = flatLayers(d.layers);
  const dest = msg.dest || "new:layer";
  if (forceNew) return d.createPixelLayer({ name: fillN(msg.name, 1) });
  const rebind = (l, group) => send({ type: "set", node: msg.node, widget: "destination",
    value: `${l.name}${group ? "/" : ""} #${l.id}` });
  if (dest === "new:layer") {
    const layer = await d.createPixelLayer({ name: fillN(msg.name, 1) });
    rebind(layer, false);
    return layer;
  }
  if (dest === "new:group") {
    const g = await d.createLayerGroup({ name: groupName(msg.name) });
    rebind(g, true);
    return newLayerIn(d, g, msg.name);
  }
  const hit = findBinding(all, dest);
  if (hit && hit.kind === "group") {
    const prev = S.live && flatLayers(hit.ref.layers || []).find((l) => l.id === lastInGroup[hit.id]);
    return prev ? prev.ref : newLayerIn(d, hit.ref, msg.name);
  }
  if (hit) return hit.ref;
  // bound to something that no longer exists (other document, deleted): recreate it and re-bind
  if (/\/\s*#\d+\s*$|\/$/.test(dest)) {
    const g = await d.createLayerGroup({ name: bindingName(dest) });
    rebind(g, true);
    return newLayerIn(d, g, msg.name);
  }
  const layer = await d.createPixelLayer({ name: bindingName(dest) });
  rebind(layer, false);
  return layer;
}

async function writeResult(msg, forceNew) {
  const raw = new Uint8Array(await (await fetch(`${S.url}/nkd_bridge/result/${msg.id}`)).arrayBuffer());
  S.ownWriteUntil = Date.now() + 1500;
  const d = forceNew ? app.activeDocument : resultDoc(msg);
  await core.executeAsModal(async () => {
    const layer = await targetLayer(d, msg, forceNew);
    const img = await imaging.createImageDataFromBuffer(toDocDepth(raw, d), {
      width: msg.w, height: msg.h, components: 4, colorSpace: "RGB" });
    try {
      await imaging.putPixels({ documentID: d.id, layerID: layer.id, imageData: img, replace: true,
        targetBounds: { left: msg.x, top: msg.y }, commandName: "NKD Bridge result" });
    } finally { img.dispose(); }
  }, { commandName: "NKD Bridge: write result" });
  ownStateKey = historyKey();         // the state our write left is not an edit (no upload loop)
  S.ownWriteUntil = Date.now() + 600;
}

// ── connection ──────────────────────────────────────────────────────────────────────────────
let retry = null;
function connect() {
  clearTimeout(retry);
  try { S.ws?.close(); } catch {}
  const ws = new WebSocket(S.url.replace(/^http/, "ws").replace(/\/$/, "") + "/nkd_bridge/ws?host=photoshop&v=" + VERSION);
  ws.binaryType = "arraybuffer";
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true; S.docJson = ""; S.sent = {};
    send({ type: "log", message: `plugin ${VERSION} connected (Photoshop ${uxp.host?.version})` });
    publishDoc(); renderStatus();
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.connected = false; S.tab = false; S.busy = false; renderStatus(); renderRun();
    retry = setTimeout(connect, 2000);
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") { showImage(e.data, "image/jpeg"); return; }   // live latent preview
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "status":
        S.tab = !!msg.tab; setManifest(msg.manifest); renderStatus(); break;
      case "manifest": setManifest(msg.manifest); break;
      case "need": syncSources(msg.keys || []); break;
      case "result": onResult(msg).catch((err) => report("result", err)); break;
      case "run_status":
        if (msg.state === "progress") setProgress(msg.value / msg.max);
        else if (msg.state === "running") { S.busy = true; renderRun(); }
        else { if (msg.state === "error") flash(msg.message || "Error"); onIdle(); }
        break;
      case "error":
        if (msg.code === "no_tab") { S.tab = false; renderStatus(); onIdle(); }
        flash(msg.message);
        break;
    }
  };
}

function setManifest(m) {
  const before = JSON.stringify(S.manifest?.sources);
  S.manifest = m || null;
  renderLists();
  if (JSON.stringify(S.manifest?.sources) !== before) syncSources();
}

// ── Photoshop events → sync (+ live run) ─────────────────────────────────────────────────────
const onPsChange = debounce(async () => {
  if (Date.now() < S.ownWriteUntil) return;
  const changed = await syncSources();
  if (S.live && changed) requestRun();
}, 200);

action.addNotificationListener(
  ["historyStateChanged", "select", "make", "delete", "set", "move", "open", "close", "paste"],
  (event) => { if (event === "select" || event === "make" || event === "delete" || event === "open" || event === "close") publishDoc(); onPsChange(); });

// Notifications don't fire for brush strokes in PS 27 (measured). Every edit, stroke or undo moves
// the active history state, so watch that one id. ponytail: 300 ms poll of a single property;
// only a change triggers the pixel read.
function historyKey() {
  try {
    const d = app.activeDocument;
    return d ? `${d.id}:${d.activeHistoryState?.id}:${d.historyStates?.length}` : "";
  } catch { return lastState; }   // document closing mid-read
}
var lastState = "", ownStateKey = "";
setInterval(() => {
  const st = historyKey();
  if (st === lastState) return;
  lastState = st;
  if (st !== ownStateKey) onPsChange();   // the state our own group read left behind is not an edit
}, 300);

// ── UI ──────────────────────────────────────────────────────────────────────────────────────
// UXP's DOM is a subset: no replaceChildren / multi-arg append. Stick to the basics.
function setKids(parent, kids) {
  parent.innerHTML = "";                      // UXP's firstChild isn't reliable; innerHTML is
  for (const c of Array.from(parent.children || [])) parent.removeChild(c);
  for (const k of kids) if (k) parent.appendChild(k);
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids) if (k != null) e.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

function renderStatus() {
  const st = !S.connected ? "off" : S.tab ? "ok" : "warn";
  $("status").className = "status " + st;
  $("statusText").textContent = L[{ off: "off", warn: "noTab", ok: "ok" }[st]];
  $("status").title = S.url;
  renderRun();
}

function renderRun() {
  $("btnRun").disabled = !S.connected || !S.manifest?.outputs?.length;
  $("btnRun").textContent = S.busy ? L.running : L.run;
  $("btnCancel").disabled = !S.busy;
}

function setProgress(f) { $("progressFill").style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + "%"; }

let flashT = null;
function flash(text) {
  show("previewEmpty", !(false));
  $("previewEmpty").textContent = text;
  clearTimeout(flashT);
  flashT = setTimeout(() => { if ($("preview").src) show("previewEmpty", !(true)); else $("previewEmpty").textContent = L.noPreview; }, 6000);
}

const sendParam = debounce((node, widget, value) => {
  send({ type: "set", node, widget, value });
  if (S.live) setTimeout(requestRun, 50);
}, 120);

let listsKey = "", outputsKey = "";
const outWhereEl = {};
const BUILTIN_VARS = ["n", "seed", "date", "time", "doc"];
/** One line telling where this output will land in the active document, and how. */
function outWhere(o) {
  const dest = o.dest || "new:layer";
  if (dest === "panel") return L.toPanel;
  if (dest === "new:layer") return `${L.willCreate} “${fillN(o.name, 1)}”`;
  if (dest === "new:group") return `${L.willCreateGroup} “${groupName(o.name)}”`;
  const hit = resolveBinding(dest);
  if (!hit) return `${L.missing}: ${bindingName(dest)} · ${L.recreate}`;
  return hit.kind === "group" ? `${L.intoGroup} ${hit.path}/ · ${L.perRun}` : `${L.toLayer} ${hit.path} · ${L.replaced}`;
}
// UXP doesn't reliably reflect the `hidden` property: drive display directly.
function show(id, on) { $(id).style.display = on ? "" : "none"; }
function isShown(id) { return $(id).style.display !== "none" && !$(id).hasAttribute("hidden"); }

function setTab(t) {
  show("pageGen", t === "gen"); show("pageIo", t === "io");
  for (const [id, name] of [["tabGen", "gen"], ["tabIo", "io"]]) {
    if (name === t) $(id).setAttribute("selected", ""); else $(id).removeAttribute?.("selected");
    $(id).className = "tab" + (name === t ? " on" : "");
  }
  store.set("tab", t);
}

function renderLists() {
  try { renderListsRaw(); } catch (e) { report("panel", e); }   // a UI glitch must not stop syncing
}

function renderListsRaw() {
  const m = S.manifest;
  const has = m && (m.sources?.length || m.params?.length || m.outputs?.length);
  for (const id of ["empty", "emptyIo"]) {
    show(id, !has);
    $(id).textContent = !app.activeDocument ? L.noDoc : L.empty;
  }
  for (const s of ["secParams", "secSources", "secOutputs"]) show(s, false);
  if (!has) { listsKey = ""; outputsKey = ""; $("tabIo").textContent = L.tabIo; return; }

  // params: rebuild only when the set of controls changes, so dragging a slider is never interrupted
  const key = JSON.stringify(m.params.map((p) => [p.id, p.kind, p.name, p.min, p.max, p.step]));
  if (key !== listsKey) {
    listsKey = key;
    setKids($("params"), m.params.map((p) => {
      if (p.kind === "text") {
        const ta = el("sp-textarea", { value: p.value ?? "", "data-id": p.id,
          oninput: (e) => sendParam(p.id, "text", e.target.value) });
        return el("div", { class: "param" }, el("sp-detail", {}, p.name), ta);
      }
      const val = el("span", { class: "val" }, fmt(p.value, p.step));
      const sl = el("sp-slider", { min: p.min, max: p.max, step: p.step || 0.01, value: p.value, "data-id": p.id,
        oninput: (e) => { val.textContent = fmt(e.target.value, p.step); sendParam(p.id, "value", Number(e.target.value)); } });
      return el("div", { class: "param" }, el("div", { class: "paramHead" }, el("sp-detail", {}, p.name), val), sl);
    }));
  } else {                                   // just refresh values the user isn't touching
    for (const p of m.params) {
      const c = $("params").querySelector(`[data-id="${p.id}"]`);
      if (c && document.activeElement !== c && c.value != p.value) c.value = p.value;
    }
  }
  show("secParams", !(!m.params.length));

  setKids($("sources"), m.sources.map((s) => {
    const layer = s.kind === "layer" ? resolveBinding(s.binding) : null;
    const sub = s.kind === "canvas" ? L.canvas : s.kind === "selection" ? L.selection
      : !s.binding ? L.unbound : layer ? layer.path + (layer.kind === "group" ? ` (${L.group})` : "") : L.missing;
    const bad = s.kind === "layer" && !layer;
    const st = bad ? "bad" : S.srcState[s.key];
    return el("div", { class: "row" },
      el("span", { class: "glyph", title: st || "" }, st === "busy" ? "↑" : st === "bad" ? "!" : st === "ok" ? "✓" : "·"),
      el("div", { class: "grow" }, el("div", { class: "title" }, s.title), el("div", { class: "sub" + (bad ? " bad" : "") }, sub)),
      s.kind === "layer" ? el("sp-action-button", { size: "s", onclick: () => bindActive(s) }, L.useActive) : null);
  }));
  show("secSources", !(!m.sources.length));

  // outputs are editable here: rebuild only when the set of outputs changes, so typing keeps focus
  const okey = JSON.stringify(m.outputs.map((o) => [o.id, o.title]));
  if (okey !== outputsKey) {
    outputsKey = okey;
    setKids($("outputs"), m.outputs.map((o) => {
      const name = el("sp-textfield", { size: "s", value: o.name ?? "", "data-out": o.id, placeholder: L.layerName,
        onchange: (e) => send({ type: "set", node: o.id, widget: "name", value: e.target.value }) });
      // variable chips: click to add to the name
      const vars = [...BUILTIN_VARS, ...m.params.map((p) => p.name)];
      const chips = vars.map((v) => el("div", { class: "chip", title: L.insertVar, onclick: () => {
        const cur = String(name.value || "");
        name.value = cur + (cur && !cur.endsWith(" ") ? " " : "") + `{${v}}`;
        send({ type: "set", node: o.id, widget: "name", value: name.value });
      } }, `{${v}}`));
      const where = el("div", { class: "sub" }, outWhere(o));
      outWhereEl[o.id] = where;
      return el("div", { class: "outRow" },
        el("div", { class: "outHead" }, el("div", { class: "title grow" }, o.title),
          el("sp-action-button", { size: "s", title: L.runThis, onclick: () => run([o.id]) }, "▶")),
        where,
        el("div", { class: "outHead" },
          el("sp-action-button", { size: "s", onclick: () => bindActive({ id: o.id }, "destination") }, L.useActive),
          el("sp-action-button", { size: "s", onclick: () => send({ type: "set", node: o.id, widget: "destination", value: "panel" }) }, L.tPanel)),
        el("sp-detail", {}, L.nameLabel), name, el("div", { class: "chips" }, ...chips));
    }));
  } else {
    for (const o of m.outputs) {
      const f = $("outputs").querySelector(`[data-out="${o.id}"]`);
      if (f && document.activeElement !== f && f.value !== o.name) f.value = o.name ?? "";
      if (outWhereEl[o.id]) outWhereEl[o.id].textContent = outWhere(o);
    }
  }
  show("secOutputs", !(!m.outputs.length));

  // the I/O tab carries a "!" when an input needs attention, so you notice it from the Generate tab
  const problem = m.sources.some((s) => s.kind === "layer" && (!s.binding || !resolveBinding(s.binding)));
  $("tabIo").textContent = L.tabIo + (problem ? "  !" : "");
  renderRun();
}

function fmt(v, step) {
  const n = Number(v);
  const dec = step >= 1 ? 0 : Math.min(4, String(step || 0.01).split(".")[1]?.length || 2);
  return Number.isFinite(n) ? n.toFixed(dec) : "";
}

function bindActive(src, widgetName = "layer") {
  const d = app.activeDocument;
  const l = d?.activeLayers?.[0];
  if (!l) return;
  publishDoc();
  const info = S.doc.layers.find((x) => x.id === l.id);
  send({ type: "set", node: src.id, widget: widgetName, value: `${info.path}${info.kind === "group" ? "/" : ""} #${info.id}` });
}

function init() {
  $("btnRun").textContent = L.run;
  $("tabGen").textContent = L.tabGen;
  $("tabIo").textContent = L.tabIo;
  $("tabGen").onclick = () => setTab("gen");
  $("tabIo").onclick = () => setTab("io");
  setTab(store.get("tab", "gen"));
  $("btnCancel").textContent = L.cancel;
  $("btnCancel").title = L.cancel;
  $("chkLive").textContent = L.live;
  $("btnAddLayer").textContent = L.addLayer;
  $("btnAddLayer").disabled = true;
  $("lblServer").textContent = L.server;
  $("lblRes").textContent = L.res;
  $("resFull").textContent = L.resFull;
  $("hintRes").textContent = L.resHint;
  $("btnConnect").textContent = L.connect;
  $("hParams").textContent = L.params;
  $("hSources").textContent = L.sources;
  $("hOutputs").textContent = L.outputs;
  $("previewEmpty").textContent = L.noPreview;
  $("inServer").value = S.url;
  $("inRes").value = String(S.maxSide);
  for (const item of $("inRes").querySelectorAll("sp-menu-item"))
    if (item.getAttribute("value") === String(S.maxSide)) item.setAttribute("selected", "");

  $("btnSettings").onclick = () => show("settings", !isShown("settings"));
  $("btnConnect").onclick = () => {
    S.url = String($("inServer").value || "").trim().replace(/\/$/, "") || "http://127.0.0.1:8188";
    store.set("url", S.url);
    show("settings", !(true));
    connect();
  };
  $("inRes").addEventListener("change", (e) => {
    S.maxSide = Number(e.target.value) || 0;
    store.set("maxSide", S.maxSide);
    S.sent = {};                           // new scale → everything must be re-sent
    syncSources();
  });
  $("btnRun").onclick = () => run();
  $("btnCancel").onclick = () => { S.pending = false; send({ type: "cancel" }); };
  $("chkLive").addEventListener("change", (e) => { S.live = !!e.target.checked; if (S.live) requestRun(); });
  $("btnAddLayer").onclick = () => { if (S.lastResult) writeResult(S.lastResult, true).catch((e) => report("add layer", e)); };

  renderStatus(); renderLists(); connect();
}

init();
