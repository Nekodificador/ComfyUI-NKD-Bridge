// NKD Comfy Bridge — Photoshop side (UXP).
// Watches the layers the open ComfyUI workflow asks for, uploads them only when their pixels
// change, asks the ComfyUI browser tab to run, and writes results back into named layers.
// Protocol reference: tools/fake_host.py in the node pack.
const { app, core, action, imaging } = require("photoshop");
const uxp = require("uxp");

const VERSION = "0.6.0";
const $ = (id) => document.getElementById(id);

// ── i18n ────────────────────────────────────────────────────────────────────────────────────
const T = {
  en: {
    dragToOrder: "Drag to reorder", liveCancelled: "CANCELLED", unchanged: "Nothing changed since the last generation.", off: "Not connected, retrying…", noTab: "Connected · open ComfyUI in your browser",
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
    useDoc: "Document", addVar: "Add a variable", channel: "Channel", path: "Path", selLabel: "selection",
    docMissing: "document not open", inDoc: "in", workflow: "Workflow", wfSearch: "Search workflows…", stale: "Reload the ComfyUI tab (Ctrl+F5): it runs an old version",
    wfNone: "No workflow matches.", wfEmpty: "No saved workflow has Bridge Input or Output nodes yet.",
  },
  es: {
    dragToOrder: "Arrastra para reordenar", liveCancelled: "CANCELADO", unchanged: "No ha cambiado nada desde la última generación.", off: "Sin conexión, reintentando…", noTab: "Conectado · abre ComfyUI en el navegador",
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
    useDoc: "Documento", addVar: "Añadir variable", channel: "Canal", path: "Trazado", selLabel: "selección",
    docMissing: "documento no abierto", inDoc: "en", workflow: "Workflow", wfSearch: "Buscar workflow…", stale: "Recarga la pestaña de ComfyUI (Ctrl+F5): va con una versión antigua",
    wfNone: "Ningún workflow coincide.", wfEmpty: "Ningún workflow guardado tiene nodos Bridge Input u Output.",
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
  doc: null, docs: [], docJson: "",   // active document info, and every open one
  sent: {},            // key -> hash last uploaded (only re-send on change)
  srcState: {},        // key -> "ok" | "busy" | "bad"
  syncing: null, resync: false,
  busy: false, pending: false, live: false,
  ownWriteUntil: 0,    // ignore Photoshop events caused by our own layer writes
  lastResult: null,
  runStart: 0, runAvg: 0,
  runDone: false,      // this run's result arrived: later sampling frames must not cover it
  step: "",            // "3/8" for the LIVE badge
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

/** Saved selections: alpha channels and paths, bound like layers ("channel:Cara #12"). */
/** UXP collections aren't always iterable: read them by index. */
function listOf(col) {
  if (!col) return [];
  const out = [];
  for (let i = 0; i < (col.length || 0); i++) out.push(col[i]);
  return out;
}

let masksDiag = "";
function savedMasks(d) {
  const out = [];
  try {
    // an alpha channel is any channel that isn't a colour component (don't trust .kind on PS 27)
    const comp = new Set(listOf(d.componentChannels).map((c) => c.name));
    const all = listOf(d.channels);
    for (const c of all)
      if (!comp.has(c.name) && !/component|spot/i.test(String(c.kind))) out.push({ id: c.id, name: c.name, kind: "channel" });
    const diag = all.map((c) => `${c.name}(${c.kind},${c.id})`).join(" ");
    if (!out.length && all.length > comp.size && diag !== masksDiag) { masksDiag = diag; send({ type: "log", message: `channels seen: ${diag}` }); }
  } catch (e) { report("channels", e); }
  try {
    for (const p of listOf(d.pathItems)) out.push({ id: p.id, name: p.name, kind: "path" });
  } catch (e) { report("paths", e); }
  return out.map((m) => ({ ...m, binding: `${m.kind}:${m.name}${m.id != null ? ` #${m.id}` : ""}` }));
}

function docInfo(d) {
  const layers = flatLayers(d.layers);
  return { id: d.id, name: d.name, w: Math.round(d.width), h: Math.round(d.height), layers, masks: savedMasks(d) };
}

/** Every open document is published, so nodes can read from one and write to another. */
function publishDoc() {
  try {
    const active = app.activeDocument;
    S.docs = listOf(app.documents).map(docInfo);
    S.doc = active ? S.docs.find((x) => x.id === active.id) || null : null;
  } catch (e) { report("document", e); return; }
  const strip = (x) => ({ ...x, layers: x.layers.map(({ ref, ...l }) => l) });
  const wire = S.doc && { ...strip(S.doc), docs: S.docs.map(strip) };
  const json = JSON.stringify(wire);
  if (json !== S.docJson) { S.docJson = json; send({ type: "doc", doc: wire }); renderLists(); }
}

/** A node's document: "" = the active one, else "Name #id" (id first, then name: ids change on reopen).
 *  Returns { d: the Photoshop document, info } or {} when it isn't open. */
function docFor(binding) {
  const b = String(binding || "").trim();
  let info = S.doc;
  if (b) {
    const id = /#(\d+)\s*$/.exec(b)?.[1], name = b.replace(/\s*#\d+\s*$/, "");
    info = S.docs.find((x) => id && String(x.id) === id) || S.docs.find((x) => x.name === name);
  }
  const d = info && listOf(app.documents).find((x) => x.id === info.id);
  return d ? { d, info } : {};
}

/** "channel:Cara #12" -> the saved mask, by id first, then by kind + name. */
function findMask(binding, info = S.doc) {
  const masks = info?.masks || [];
  const m = /^(channel|path):(.*?)(?:\s*#(\S+))?\s*$/.exec(binding || "");
  if (!m) return null;
  return masks.find((x) => x.kind === m[1] && m[3] != null && String(x.id) === m[3])
    || masks.find((x) => x.kind === m[1] && x.name === m[2]) || null;
}
const maskLabel = (x) => `${x.kind === "channel" ? L.channel : L.path}: ${x.name}`;
/** What the selection dropdown offers: the live selection, then every saved channel and path. */
function selectionOptions(current, info = S.doc) {
  const opts = [{ value: "@selection", label: L.selection },
    ...(info?.masks || []).map((x) => ({ value: x.binding, label: maskLabel(x) }))];
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: `${L.missing}: ${current}` });
  return opts;
}
// Rebuilt only when its options or value change: a re-render mid-click would close an open dropdown.
const pickers = {};
function selectionPicker(s, problem) {
  const value = s.binding || "@selection", opts = selectionOptions(s.binding, docFor(s.doc).info);
  const key = JSON.stringify([value, opts, problem]);
  if (pickers[s.id]?.key === key) return pickers[s.id].el;
  const menu = el("sp-menu", { slot: "options" }, ...opts.map((o) =>
    el("sp-menu-item", { value: o.value, selected: o.value === value }, o.label)));
  const pick = el("sp-picker", { size: "s", class: "selPick",
    onchange: (e) => send({ type: "set", node: s.id, widget: "selection_source", value: e.target.value }) }, menu);
  const box = el("div", {}, pick, problem ? el("div", { class: "sub bad" }, problem) : null);
  pickers[s.id] = { key, el: box };
  return box;
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

function resolveBinding(binding, info = S.doc) {
  return info ? findBinding(info.layers, binding) : null;
}

const scale = (info = S.doc) => {
  if (!info || !S.maxSide) return 1;
  return Math.min(1, S.maxSide / Math.max(info.w, info.h));
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
  const { d, info } = docFor(src.doc);
  if (!d) return { missing: true };
  const s = scale(info);
  const dw = Math.max(1, Math.round(info.w * s)), dh = Math.max(1, Math.round(info.h * s));
  const base = { dw, dh };
  const noSelection = { ...base, w: 0, h: 0, c: 1, x: 0, y: 0, data: new Uint8Array(0) };
  let res;
  if (src.kind === "selection") {
    return src.binding ? await readSavedMask(d, s, base, noSelection, src.binding)
      : await readSelection(d, s, base, noSelection);
  } else if (src.kind === "canvas") {
    res = await withTimeout(imaging.getPixels({ documentID: d.id, componentSize: 8, applyAlpha: false,
      ...(s < 1 && { targetSize: { width: dw, height: dh } }) }), 8000, "getPixels(canvas)");
  } else {
    const layer = resolveBinding(src.binding, info);
    if (!layer) return { missing: true };
    const b = layer.ref.bounds;
    const bw = b.right - b.left, bh = b.bottom - b.top;
    if (bw <= 0 || bh <= 0) return { ...base, w: 0, h: 0, c: 4, x: 0, y: 0, data: new Uint8Array(0) };
    if (layer.kind === "group") return await readGroup(d, layer.ref, s, base);
    res = await withTimeout(imaging.getPixels({ documentID: d.id, layerID: layer.id, componentSize: 8, applyAlpha: false,
      ...(s < 1 && { targetSize: { width: Math.max(1, Math.round(bw * s)), height: Math.max(1, Math.round(bh * s)) } }) }), 8000, "getPixels(layer)");
  }
  return pixelsOf(res, s, base);
}

let lastSelectionError = "";
/** getSelection returns the selection's OWN box, so targetSize must be that box scaled, never the
 *  document (a document-sized target stretches the box over the whole canvas). */
async function readSelection(d, s, base, none) {
  let b;
  try { b = d.selection?.bounds; } catch { b = undefined; }   // PS 27 can throw here (batchPlay)
  if (b === null) return none;                                // PS 25+: null = nothing selected
  let box = b && { left: +b.left, top: +b.top, right: +b.right, bottom: +b.bottom };
  if (box && ![box.left, box.top, box.right, box.bottom].every(Number.isFinite)) box = undefined;
  const get = (o) => withTimeout(imaging.getSelection({ documentID: d.id, ...o }), 8000, "getSelection");
  let res;
  try {
    if (!box) {                    // no box from the DOM: one native read tells us where it is
      res = await get({});
      if (!res?.imageData) return none;                       // PS 27, nothing selected: no imageData
      if (s >= 1 || !res.sourceBounds) return await pixelsOf(res, s, base);
      box = res.sourceBounds;
      res.imageData.dispose();
    }
    const size = { width: Math.max(1, Math.round((box.right - box.left) * s)),
      height: Math.max(1, Math.round((box.bottom - box.top) * s)) };
    res = await get({ sourceBounds: box, ...(s < 1 && { targetSize: size }) });
  } catch (e) {
    if (/modal/i.test(String(e && e.message))) throw e;
    // usually "nothing selected"; say it once, so a real failure never passes for an empty selection
    const msg = String(e && e.message || e);
    if (msg !== lastSelectionError) { lastSelectionError = msg; report("selection", e); }
    return none;
  }
  if (!res?.imageData) return none;
  lastSelectionError = "";
  return await pixelsOf(res, s, base);
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
async function readGroup(d, group, s, base) {
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
  return inModal(work, "NKD Bridge read group");
}

/** Run `work(ctx)` in a modal scope, reusing the one we're already in (modals don't nest). */
async function inModal(work, commandName) {
  if (modalCtx) return work(modalCtx);
  let out;
  await withTimeout(core.executeAsModal(async (ctx) => { out = await work(ctx); }, { commandName }), 10000, commandName);
  return out;
}

/** A saved channel or path: load it as the selection, read that, then roll it all back, so the user's
 *  own selection and history are left as they were (same trick as readGroup). */
async function readSavedMask(d, s, base, none, binding) {
  const m = /^(channel|path):(.*?)(?:\s*#(\S+))?\s*$/.exec(binding);
  if (!m) return { missing: true };
  const [, kind, name, id] = m;
  const list = kind === "channel" ? listOf(d.channels) : listOf(d.pathItems);
  const item = (id != null && list.find((x) => String(x.id) === id)) || list.find((x) => x.name === name);
  if (!item) return { missing: true };
  return inModal(async (ctx) => {
    const hc = ctx.hostControl;
    const sid = await hc.suspendHistory({ documentID: d.id, name: "NKD Bridge read mask" });
    try {
      if (kind === "channel") await d.selection.load(item);
      else await item.makeSelection(0, true);          // no feather, anti-aliased
      return await readSelection(d, s, base, none);
    } finally {
      await hc.resumeHistory(sid, false);              // discard: the selection change never happened
      ownStateKey = historyKey();
    }
  }, "NKD Bridge read mask");
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
            if (S.srcState[src.key] !== "bad")
              report(src.title, new Error(src.doc && !docFor(src.doc).d ? `${L.docMissing}: ${src.doc}` : `${L.missing}: ${src.binding}`));
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
  // what Photoshop sent, so the tab can tell "nothing changed" (the graph alone doesn't show pixels)
  const sources = (S.manifest?.sources || []).map((s) => S.sent[s.key] || "");
  send({ type: "run", outputs: outputs || null, sources });
}

function requestRun() {                    // live: never more than one job in flight
  if (S.busy) S.pending = true;
  else run();
}

/** "live" (sampling frame on screen) | "cancelled" (the run stopped on a sampling frame) | null */
function setLive(state) {
  const b = $("liveBadge");
  b.style.display = state ? "" : "none";
  b.className = "liveBadge" + (state === "cancelled" ? " cancelled" : "");
  b.textContent = state === "cancelled" ? L.liveCancelled : "LIVE" + (S.step ? ` · ${S.step}` : "");
  S.liveState = state;
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
  S.runDone = true; setLive(null);
  const jpg = await (await fetch(`${S.url}/nkd_bridge/result/${msg.id}?fmt=jpg`)).arrayBuffer();
  showImage(jpg, "image/jpeg");
  setOff($("btnAddLayer"), false);
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
const createdFor = {};       // output node -> {from: its "new:…", to: what we created}, until the tab confirms the re-bind
const fillN = (tpl, n) => String(tpl || "NKD {n}").replace(/\{\s*n\s*\}/g, String(n)).trim();
/** The template with {n} one past the highest number its siblings already use, so every new layer
 *  gets its own number and a deleted one is never repeated. Without {n} the name is used as is. */
function nextName(siblings, tpl) {
  const t = String(tpl || "NKD {n}").trim();
  const re = new RegExp("^" + t.split(/\{\s*n\s*\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(\\d+)") + "$");
  let max = 0;
  for (const l of siblings) { const m = re.exec(l.name); if (m) max = Math.max(max, ...m.slice(1).map(Number)); }
  return fillN(t, max + 1);
}
const groupName = (tpl) => String(tpl || "").replace(/\{\s*n\s*\}/g, "").replace(/[\s·_-]+$/, "").trim() || "NKD";

async function newLayerIn(d, group, tpl) {
  const layer = await d.createPixelLayer({ name: nextName(listOf(group.layers), tpl) });
  await layer.move(group, "placeInside");
  lastInGroup[group.id] = layer.id;
  return layer;
}

async function targetLayer(d, msg, forceNew) {
  const all = flatLayers(d.layers);
  let dest = msg.dest || "new:layer";
  if (forceNew) return d.createPixelLayer({ name: nextName(listOf(d.layers), msg.name) });
  // Live can queue the next run before the tab applies our re-bind: that run still says "new:…",
  // so it goes to what we just created instead of creating another one
  const made = createdFor[msg.node];
  if (made?.from === dest && findBinding(all, made.to)) dest = made.to;
  const rebind = (l, group) => {
    const to = `${l.name}${group ? "/" : ""} #${l.id}`;
    createdFor[msg.node] = { from: dest, to };
    send({ type: "set", node: msg.node, widget: "destination", value: to });
  };
  if (dest === "new:layer") {
    const layer = await d.createPixelLayer({ name: nextName(listOf(d.layers), msg.name) });
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

/** One write at a time: two results landing together must not both create the "new" layer. */
let writing = Promise.resolve();
function writeResult(msg, forceNew) {
  const p = writing.then(() => writeResultRaw(msg, forceNew));
  writing = p.catch(() => {});
  return p;
}

async function writeResultRaw(msg, forceNew) {
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
    if (msg.save && !forceNew) await d.save();    // a smart object's contents: saving updates its parent
  }, { commandName: "NKD Bridge: write result" });
  ownStateKey = historyKey();         // the state our write left is not an edit (no upload loop)
  S.ownWriteUntil = Date.now() + 600;
  publishDoc();                       // a layer/group we just created must be known, or the panel says "not found"
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
    if (typeof e.data !== "string") {                                             // live sampling frame
      if (S.runDone) return;
      showImage(e.data, new Uint8Array(e.data, 0, 1)[0] === 0x89 ? "image/png" : "image/jpeg");
      setLive("live");
      return;
    }
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "status":
        S.tab = !!msg.tab; setManifest(msg.manifest); renderStatus(); break;
      case "manifest": setManifest(msg.manifest); break;
      case "need": syncSources(msg.keys || []); break;
      case "result": onResult(msg).catch((err) => report("result", err)); break;
      case "run_status":
        if (msg.state === "progress") {
          setProgress(msg.value / msg.max);
          S.step = `${msg.value}/${msg.max}`;
          if (S.liveState === "live") setLive("live");
        } else if (msg.state === "running") { S.busy = true; S.runDone = false; S.step = ""; renderRun(); }
        else {
          // stopped on a sampling frame: say so, so it isn't mistaken for a result
          const stopped = msg.interrupted || msg.state === "error";
          if (S.liveState === "live") setLive(stopped ? "cancelled" : null);
          if (msg.state === "error") flash(msg.message || "Error");
          if (msg.unchanged) flash(L.unchanged);
          onIdle();
        }
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
  renderStatus();
  for (const o of S.manifest?.outputs || []) if (createdFor[o.id]?.to === o.dest) delete createdFor[o.id];   // re-bind landed
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

/** Buttons are plain divs styled as .btn (Spectrum's own come in mismatched sizes). "off" = disabled. */
const isOff = (e) => /\boff\b/.test(e.className || "");
function setOff(e, off) { e.className = (e.className || "").replace(/\s*\boff\b/g, "") + (off ? " off" : ""); }
function btn(label, onclick, cls = "small", title) {
  return el("div", { class: "btn " + cls, title, onclick: (e) => { if (!isOff(e.currentTarget || e.target)) onclick(e); } }, label);
}
/** Wire a static button from index.html the same way. */
function tap(id, fn) { $(id).onclick = () => { if (!isOff($(id))) fn(); }; }

function renderStatus() {
  const stale = S.connected && S.tab && S.manifest?.stale;
  const st = !S.connected ? "off" : S.tab && !stale ? "ok" : "warn";
  $("status").className = "status " + st;
  $("statusText").textContent = stale ? L.stale : L[{ off: "off", warn: "noTab", ok: "ok" }[st]];
  $("status").title = S.url;
  renderRun();
}

function renderRun() {
  setOff($("btnRun"), !S.connected || !S.manifest?.outputs?.length);
  $("btnRun").textContent = S.busy ? L.running : L.run;
  setOff($("btnCancel"), !S.busy);
  $("chkLive").className = "btn toggle" + (S.live ? " on" : "");
  $("chkLive").textContent = (S.live ? "● " : "○ ") + L.live;
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
const outWhereEl = {}, outSegEls = {};
const varsOpen = {};                         // per output: is the variable list unfolded
/** What kind of destination: "panel", "layer" (new or bound) or "group" (new or bound). */
function destKind(dest) {
  if (dest === "panel") return "panel";
  if (dest === "new:group" || /\/\s*(#\d+)?\s*$/.test(dest)) return "group";
  return "layer";
}
const BUILTIN_VARS = ["n", "seed", "date", "time", "doc"];
/** One line telling where this output will land in the active document, and how. */
function outWhere(o) {
  const dest = o.dest || "new:layer";
  if (dest === "panel") return L.toPanel;
  const { info } = docFor(o.doc);
  if (o.doc && !info) return `${L.docMissing}: ${o.doc}`;
  const where = whereIn(o, dest, info);
  return o.doc ? `${where} · ${L.inDoc} ${info.name}` : where;
}
function whereIn(o, dest, info) {
  if (dest === "new:layer") return `${L.willCreate} “${nextName(info ? info.layers.filter((l) => !l.path.includes("/")) : [], o.name)}”`;
  if (dest === "new:group") return `${L.willCreateGroup} “${groupName(o.name)}”`;
  const hit = resolveBinding(dest, info);
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

/** The saved workflows that have Bridge nodes, in their folders, with a fuzzy search on top. Picking
 *  one opens it in the ComfyUI tab. A homemade list, not sp-picker: that one can't filter or nest. */
const wfLabel = (p) => String(p).replace(/^workflows\//, "").replace(/\.json$/i, "");
const wfFolders = store.get("wfFolders", {});        // folder path -> unfolded
const WF = { open: false, query: "", key: "", head: null, browser: null, list: null };

/** Every word of the query must appear in order (letters may be apart). Higher = better: letters in a
 *  row and at word starts count more, shorter names win ties. -1 = no match. */
function fuzzy(query, text) {
  const s = text.toLowerCase();
  let total = 0;
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    let i = 0, last = -2;
    for (const ch of word) {
      const j = s.indexOf(ch, i);
      if (j < 0) return -1;
      total += j === last + 1 ? 3 : j === 0 || /[\s/_\-.]/.test(s[j - 1]) ? 2 : 1;
      last = j; i = j + 1;
    }
  }
  return total - s.length * 0.01;
}

function buildWorkflowBox() {
  WF.head = el("div", { class: "wfHead", onclick: () => { WF.open = !WF.open; drawWorkflows(); } });
  const search = el("sp-textfield", { size: "s", placeholder: L.wfSearch, class: "wfSearch",
    oninput: (e) => { WF.query = String(e.target.value || ""); drawWorkflows(); } });
  WF.list = el("div", { class: "wfList" });
  WF.browser = el("div", { class: "wfBrowser" }, search, WF.list);
  setKids($("wfBox"), [el("div", { class: "section" }, L.workflow), WF.head, WF.browser]);
}

function renderWorkflows() {
  show("wfBox", S.tab && (S.manifest?.workflows?.length > 0 || !!S.manifest?.workflow));
  drawWorkflows();
}

function drawWorkflows() {
  if (!WF.head) buildWorkflowBox();
  const list = S.manifest?.workflows || [], cur = S.manifest?.workflow || "";
  setKids(WF.head, [el("div", { class: "wfName" }, cur ? wfLabel(cur).split("/").pop() : "—"),
    el("div", { class: "wfChevron" }, WF.open ? "▲" : "▼")]);
  WF.browser.style.display = WF.open ? "" : "none";
  const key = JSON.stringify([list, cur, WF.query, wfFolders, WF.open]);
  if (key === WF.key) return;                         // typing keeps the search box as it is
  WF.key = key;
  const item = (p, depth, text) => {
    const row = el("div", { class: "wfItem" + (p === cur ? " on" : ""), onclick: () => {
      if (p !== cur) send({ type: "open", path: p });
      WF.open = false; drawWorkflows();
    } }, text);
    row.style.paddingLeft = `${4 + depth * 12}px`;
    return row;
  };
  const rows = [];
  if (WF.query.trim()) {                              // search: flat, best first, folder shown dimmed
    list.map((p) => ({ p, s: fuzzy(WF.query, wfLabel(p)) })).filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s).forEach(({ p }) => {
        const parts = wfLabel(p).split("/"), name = parts.pop();
        rows.push(item(p, 0, parts.length ? `${name}   ${parts.join("/")}/` : name));
      });
  } else {                                            // tree: folders first, each one folds
    const tree = { dirs: {}, files: [] };
    for (const p of list) {
      const parts = wfLabel(p).split("/"), name = parts.pop();
      let node = tree, at = "";
      for (const d of parts) { at += d + "/"; node = node.dirs[d] ||= { dirs: {}, files: [], at }; }
      node.files.push({ p, name });
    }
    const walk = (node, depth) => {
      for (const [d, sub] of Object.entries(node.dirs).sort(([a], [b]) => a.localeCompare(b))) {
        const row = el("div", { class: "wfFolder", onclick: () => {
          wfFolders[sub.at] = !wfFolders[sub.at]; store.set("wfFolders", wfFolders); drawWorkflows();
        } }, `${wfFolders[sub.at] ? "▾" : "▸"} ${d}/`);
        row.style.paddingLeft = `${4 + depth * 12}px`;
        rows.push(row);
        if (wfFolders[sub.at]) walk(sub, depth + 1);
      }
      for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) rows.push(item(f.p, depth, f.name));
    };
    walk(tree, 0);
  }
  if (!rows.length) rows.push(el("div", { class: "sub" }, list.length ? L.wfNone : L.wfEmpty));
  setKids(WF.list, rows);
}

function renderListsRaw() {
  renderWorkflows();
  const m = S.manifest;
  const has = m && (m.sources?.length || m.params?.length || m.outputs?.length);
  for (const id of ["empty", "emptyIo"]) {
    show(id, !has);
    $(id).textContent = !app.activeDocument ? L.noDoc : L.empty;
  }
  for (const s of ["secParams", "secSources", "secOutputs"]) show(s, false);
  if (!has) { listsKey = ""; outputsKey = ""; $("tabIo").textContent = L.tabIo; return; }

  // params: rebuild only when the set of controls changes, so dragging a slider is never interrupted
  // lists and checkboxes are rebuilt when their value changes too (they only change on a pick)
  const key = JSON.stringify(m.params.map((p) => [p.id, p.kind, p.name, p.min, p.max, p.step, p.options,
    p.kind === "choice" || p.kind === "toggle" ? p.value : 0]));
  if (key !== listsKey) {
    listsKey = key;
    const label = (p) => el("div", { class: "label grow" }, p.name);
    setKids($("params"), m.params.map((p) => {
      if (p.kind === "text") {
        const ta = el("sp-textarea", { value: p.value ?? "", "data-id": p.id,
          oninput: (e) => sendParam(p.id, "text", e.target.value) });
        return paramRow(p, label(p), ta);
      }
      if (p.kind === "toggle") {
        return paramRow(p, el("sp-checkbox", { class: "grow", checked: !!p.value,
          onchange: (e) => sendParam(p.id, "value", e.target.checked ? "true" : "false") }, p.name));
      }
      if (p.kind === "choice") {
        const opts = p.options || [];
        const menu = el("sp-menu", { slot: "options" }, ...opts.map((o) =>
          el("sp-menu-item", { value: o, selected: o === p.value }, o)));
        return paramRow(p, label(p), el("sp-picker", { size: "s", class: "selPick",
          onchange: (e) => sendParam(p.id, "value", e.target.value) }, menu));
      }
      const val = el("span", { class: "val" }, fmt(p.value, p.step));
      const sl = el("sp-slider", { min: p.min, max: p.max, step: p.step || 0.01, value: p.value, "data-id": p.id,
        oninput: (e) => { val.textContent = fmt(e.target.value, p.step); sendParam(p.id, "value", Number(e.target.value)); } });
      return paramRow(p, label(p), sl, val);
    }));
  } else {                                   // just refresh values the user isn't touching
    for (const p of m.params) {
      const c = $("params").querySelector(`[data-id="${p.id}"]`);
      if (c && document.activeElement !== c && c.value != p.value) c.value = p.value;
    }
  }
  show("secParams", !(!m.params.length));

  setKids($("sources"), m.sources.map((s) => {
    const { info } = docFor(s.doc);
    const layer = s.kind === "layer" ? resolveBinding(s.binding, info) : null;
    const mask = s.kind === "selection" && s.binding ? findMask(s.binding, info) : null;
    const what = s.kind === "canvas" ? L.canvas
      : s.kind === "selection" ? (!s.binding ? L.selection : mask ? maskLabel(mask) : `${L.missing}: ${s.binding}`)
      : !s.binding ? L.unbound : layer ? layer.path + (layer.kind === "group" ? ` (${L.group})` : "") : L.missing;
    const sub = s.doc && !info ? `${L.docMissing}: ${s.doc}` : s.doc ? `${info.name} · ${what}` : what;
    const bad = (!!s.doc && !info) || (s.kind === "layer" && !layer) || (s.kind === "selection" && !!s.binding && !mask);
    if (s.kind === "selection") {             // pick it here, so retouching never needs the ComfyUI tab
      const st = bad ? "bad" : S.srcState[s.key];
      return el("div", { class: "selRow" },
        el("div", { class: "outHead" },
          el("span", { class: "glyph", title: st || "" }, st === "busy" ? "↑" : st === "bad" ? "!" : st === "ok" ? "✓" : "·"),
          el("div", { class: "title grow" }, s.title + " · " + L.selLabel)),
        selectionPicker(s, bad ? sub : null));
    }
    const st = bad ? "bad" : S.srcState[s.key];
    return el("div", { class: "row" },
      el("span", { class: "glyph", title: st || "" }, st === "busy" ? "↑" : st === "bad" ? "!" : st === "ok" ? "✓" : "·"),
      el("div", { class: "grow" }, el("div", { class: "title" }, s.title), el("div", { class: "sub" + (bad ? " bad" : "") }, sub)),
      // Bridge Input (bindable): switch between the active layer and the whole document
      s.bindable ? btn(L.useActive, () => bindActive(s)) : null,
      s.bindable && s.kind === "layer" ? btn(L.useDoc, () => send({ type: "set", node: s.id, widget: "source", value: "@document" })) : null);
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
      // Layer · Group · Panel: picking another kind starts a new one; "Use active" binds an existing one
      const setDest = (v) => { delete createdFor[o.id]; send({ type: "set", node: o.id, widget: "destination", value: v }); };
      const segs = [["layer", L.tLayer, "new:layer"], ["group", L.tGroup, "new:group"], ["panel", L.tPanel, "panel"]]
        .map(([k, label, v]) => el("div", { class: "seg", "data-kind": k,
          onclick: () => {           // o is from the last rebuild: read the live destination
            const cur = S.manifest?.outputs?.find((x) => x.id === o.id)?.dest || "new:layer";
            if (destKind(cur) !== k) setDest(v);
          } }, label));
      outSegEls[o.id] = segs;
      const chipBox = el("div", { class: "chips" }, ...chips);
      chipBox.style.display = varsOpen[o.id] ? "" : "none";
      const fold = el("div", { class: "fold", onclick: () => {
        varsOpen[o.id] = !varsOpen[o.id];
        chipBox.style.display = varsOpen[o.id] ? "" : "none";
        fold.textContent = (varsOpen[o.id] ? "▾ " : "▸ ") + L.addVar;
      } }, (varsOpen[o.id] ? "▾ " : "▸ ") + L.addVar);
      return el("div", { class: "outRow" },
        el("div", { class: "outHead" }, el("div", { class: "title grow" }, o.title),
          btn("▶", () => run([o.id]), "small", L.runThis)),
        el("div", { class: "segs" }, ...segs),
        where,
        el("div", { class: "outHead" }, el("div", { class: "grow" }),
          btn(L.useActive, () => bindActive({ id: o.id }, "destination"))),
        el("div", { class: "label" }, L.nameLabel), name, fold, chipBox);
    }));
  } else {
    for (const o of m.outputs) {
      const f = $("outputs").querySelector(`[data-out="${o.id}"]`);
      if (f && document.activeElement !== f && f.value !== o.name) f.value = o.name ?? "";
      if (outWhereEl[o.id]) outWhereEl[o.id].textContent = outWhere(o);
    }
  }
  for (const o of m.outputs) {
    const k = destKind(o.dest || "new:layer");
    for (const sg of outSegEls[o.id] || []) sg.className = "seg" + (sg.getAttribute("data-kind") === k ? " on" : "");
  }
  show("secOutputs", !(!m.outputs.length));

  // the I/O tab carries a "!" when an input needs attention, so you notice it from the Generate tab
  const problem = m.sources.some((s) => {
    const { info } = docFor(s.doc);
    return (!!s.doc && !info) || (s.kind === "layer" && (!s.binding || !resolveBinding(s.binding, info)))
      || (s.kind === "selection" && s.binding && !findMask(s.binding, info));
  });
  $("tabIo").textContent = L.tabIo + (problem ? "  !" : "");
  renderRun();
}

/** One control in the panel: ⋮⋮ grip + label (+ value) on top, the control under it. */
function paramRow(p, head, control, extra) {
  const row = el("div", { class: "param" });
  const grip = el("div", { class: "grip", title: L.dragToOrder }, "⋮⋮");
  grip.addEventListener("mousedown", (e) => dragParam(e, row));
  row.appendChild(el("div", { class: "paramHead" }, grip, head, extra));
  if (control) row.appendChild(control);
  row.nkdId = p.id;
  return row;
}

/** Drag a control by its grip; on drop the new order is saved in the workflow (the tab stores it). */
function dragParam(e, row) {
  e.preventDefault?.();
  const box = $("params"), before = Array.from(box.children).map((r) => r.nkdId);
  row.className = "param dragging";
  const move = (ev) => {
    const others = Array.from(box.children).filter((r) => r !== row);
    const at = others.find((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
    const want = at ? others.indexOf(at) : others.length;
    if (Array.from(box.children).indexOf(row) === want) return;
    box.removeChild(row);
    if (at) box.insertBefore(row, at); else box.appendChild(row);
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    row.className = "param";
    const ids = Array.from(box.children).map((r) => r.nkdId);
    if (JSON.stringify(ids) !== JSON.stringify(before)) send({ type: "order", ids });
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function fmt(v, step) {
  const n = Number(v);
  const dec = step >= 1 ? 0 : Math.min(4, String(step || 0.01).split(".")[1]?.length || 2);
  return Number.isFinite(n) ? n.toFixed(dec) : "";
}

function bindActive(src, widgetName = "source") {
  const d = app.activeDocument;
  const l = d?.activeLayers?.[0];
  if (!l) return;
  publishDoc();
  const info = S.doc.layers.find((x) => x.id === l.id);
  send({ type: "set", node: src.id, widget: "document", value: `${d.name} #${d.id}` });   // the layer lives in this document
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
  $("btnAddLayer").textContent = L.addLayer;
  setOff($("btnAddLayer"), true);
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
  tap("btnConnect", () => {
    S.url = String($("inServer").value || "").trim().replace(/\/$/, "") || "http://127.0.0.1:8188";
    store.set("url", S.url);
    show("settings", !(true));
    connect();
  });
  $("inRes").addEventListener("change", (e) => {
    S.maxSide = Number(e.target.value) || 0;
    store.set("maxSide", S.maxSide);
    S.sent = {};                           // new scale → everything must be re-sent
    syncSources();
  });
  tap("btnRun", () => run());
  tap("btnCancel", () => { S.pending = false; send({ type: "cancel" }); });
  tap("chkLive", () => { S.live = !S.live; renderRun(); if (S.live) requestRun(); });
  tap("btnAddLayer", () => { if (S.lastResult) writeResult(S.lastResult, true).catch((e) => report("add layer", e)); });

  renderStatus(); renderLists(); connect();
}

init();
