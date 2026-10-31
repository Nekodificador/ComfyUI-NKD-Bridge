// NKD Comfy Bridge — browser tab side.
// The tab is the "runner": the host (Photoshop) asks, the tab queues its own workflow, so all of
// ComfyUI's progress and live previews show here. It also publishes a manifest of the bridge
// nodes for the host panel and applies the widget edits the panel sends back.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const REV = "0.7.2";   // the server compares it with this file: a tab not reloaded since is stale
const SOURCES = { NKDBridgeInput: "layer" };
const PARAMS = { NKDBridgeNumber: "number", NKDBridgeText: "text", NKDBridgeChoice: "choice" };
const OUTPUT = "NKDBridgeOutput";
const NONE = "(pick a layer)";
const DOCUMENT = "@document";          // Bridge Input reading the whole document
const DOC_LABEL = "Whole document";
const SELECTION = "@selection";        // selection_source: the live selection
const SEL_LABEL = "Current selection";
const ACTIVE = "@active";              // document: whichever one is active in Photoshop
const ACTIVE_LABEL = "Active document";
const BOOLEAN = "@boolean";            // Bridge Choice options for an on/off input

let doc = null;        // active document info from the host; doc.docs = every open document

// Which document a node works on: its "document" widget ("Name #id", id first then name), else the active one
const docBinding = (d) => `${d.name} #${d.id}`;
const boundDoc = (v) => { const b = String(v ?? "").trim(); return b === ACTIVE ? "" : b; };
function docOf(node) {
  const b = boundDoc(widget(node, "document")?.value);
  if (!b) return doc;
  const id = /#(\d+)\s*$/.exec(b)?.[1], name = b.replace(/\s*#\d+\s*$/, "");
  const docs = doc?.docs ?? [];
  return docs.find((d) => id && String(d.id) === id) || docs.find((d) => d.name === name) || null;
}
const docLabelsAll = () => [ACTIVE_LABEL, ...(doc?.docs ?? []).map(docBinding)];
const docToLabel = (v) => (boundDoc(v) || ACTIVE_LABEL);
const labelToDoc = (l) => (l === ACTIVE_LABEL ? ACTIVE : l);

// saved channels/paths: "Channel: Cara" in the list, "channel:Cara #12" stored
const maskLabelOf = (m) => `${m.kind === "channel" ? "Channel" : "Path"}: ${m.name}${m.id != null ? ` #${m.id}` : ""}`;
const masksOf = (n) => docOf(n)?.masks ?? [];
const maskLabels = (n) => [SEL_LABEL, ...masksOf(n).map(maskLabelOf)];
const maskToLabel = (n, v) => {
  if (!v || v === SELECTION) return SEL_LABEL;
  const m = masksOf(n).find((x) => x.binding === v);
  return m ? maskLabelOf(m) : v;
};
const labelToMask = (n, l) => (l === SEL_LABEL ? SELECTION : masksOf(n).find((m) => maskLabelOf(m) === l)?.binding ?? l);
let hosts = 0;         // connected hosts, as last reported by the server
let lastManifest = "";

const post = (path, body, raw) =>
  api.fetchApi(path, raw ? { method: "POST", body } :
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json()).then((j) => { if (j && "hosts" in j) hosts = j.hosts; return j; })
    .catch(() => null);

const tab = (event, data) => post("/nkd_bridge/tab", { event, data, client_id: api.clientId });
const status = (state, extra) => tab("status", { state, ...extra });   // execution status → host panel
const widget = (node, name) => node.widgets?.find((w) => w.name === name);
const active = (n) => !n.mode;  // 0 = always; muted (2) and bypassed (4) don't count

// Groups end in "/" like folders, so they read as groups in every list
const labelOf = (l) => `${l.path}${l.kind === "group" ? "/" : ""} #${l.id}`;
const docLabels = (n) => (docOf(n)?.layers ?? []).map(labelOf);
const sourceLabels = (n) => [DOC_LABEL, ...docLabels(n)];

// Output destination: friendly label <-> stored value
const DEST_SPECIAL = [["Panel only", "panel"], ["+ New layer", "new:layer"], ["+ New group", "new:group"]];
const destLabels = (n) => [...DEST_SPECIAL.map((d) => d[0]), ...docLabels(n)];
const destToLabel = (v) => DEST_SPECIAL.find((d) => d[1] === v)?.[0] ?? (v || DEST_SPECIAL[1][0]);
const labelToDest = (l) => DEST_SPECIAL.find((d) => d[0] === l)?.[1] ?? l;

const VAR_PROMPT = "choose…";
const BUILTIN_VARS = ["{n}", "{seed}", "{date}", "{time}", "{doc}"];
const paramNames = () => (app.graph?._nodes ?? []).filter((n) => n.type in PARAMS)
  .map((n) => widget(n, "name")?.value).filter(Boolean);

// ponytail: top-level graph only; bridge nodes inside subgraphs need subgraph-aware ids
function bridgeNodes() {
  return (app.graph?._nodes ?? []).filter((n) => active(n) &&
    (n.type in SOURCES || n.type in PARAMS || n.type === OUTPUT));
}

const wfStore = () => app.extensionManager?.workflow;
/** Saved workflows the panel can switch to (paths like "workflows/Folder/Live.json"): only those with a
 *  Bridge Input or Output, since the rest can't talk to Photoshop. The open one counts as it is now. */
function workflowList() {
  const st = wfStore(), cur = st?.activeWorkflow?.path;
  const live = (n) => n.type in SOURCES || n.type === OUTPUT;
  return (st?.workflows ?? []).filter((w) => w.isPersisted && !w.isTemporary && w.path?.startsWith("workflows/"))
    .filter((w) => (w.path === cur ? (app.graph?._nodes ?? []).some(live) : hasBridge(w)))
    .map((w) => w.path).sort((a, b) => a.localeCompare(b));
}

// path -> {mod, has}. Each saved file is read once (again only when it's modified), one at a time.
const bridgeScan = {};
let scanQueue = Promise.resolve();
const BRIDGE_TYPE = /"type"\s*:\s*"NKDBridge(Input|Output)"/;   // subgraph definitions included
function hasBridge(w) {
  const mod = w.lastModified ?? w.size ?? 0, c = bridgeScan[w.path];
  if (c?.mod === mod) return c.has;
  if (c?.pending === mod) return c.has ?? null;
  bridgeScan[w.path] = { pending: mod, has: c?.has ?? null };
  scanQueue = scanQueue.then(async () => {
    let has = null;
    try {
      const r = await api.fetchApi("/userdata/" + encodeURIComponent(w.path));
      if (r.ok) has = BRIDGE_TYPE.test(await r.text());
    } catch {}
    bridgeScan[w.path] = { mod, has };
    publish();
  });
  return c?.has ?? null;
}

async function openWorkflow({ path }) {
  const st = wfStore(), wf = path && st?.getWorkflowByPath?.(path);
  if (!wf) { status("error", { message: `ComfyUI: workflow not found: ${path}` }); return; }
  if (st.isActive?.(wf)) return;
  const prev = st.activeWorkflow, wasOpen = st.isOpen?.(wf);
  if (!wf.isLoaded) await wf.load();
  // what the tab bar does: switches to its tab if it's already open, else opens one
  await app.loadGraphData(JSON.parse(JSON.stringify(wf.activeState)), true, true, wf);   // a Vue proxy: structuredClone throws
  // a workflow that wasn't open takes the place of the tab you were on, unless that one has unsaved changes
  if (!wasOpen && prev && prev !== wf && !prev.isModified && st.isOpen?.(prev)) await st.closeWorkflow(prev);
  publish(true);
}

/** Bridge Choice: one option per line, or "@boolean" for an on/off input. */
const choiceOptions = (n) => String(widget(n, "options")?.value ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/** Connecting Bridge Choice to an input takes that input's options (and its value, if ours isn't one). */
function adoptTarget(node, link) {
  const target = link && app.graph?.getNodeById(link.target_id);
  const inp = target?.inputs?.[link.target_slot];
  if (!inp) return;
  const tw = widget(target, inp.widget?.name ?? inp.name);
  let opts, cur = tw?.value;
  if (inp.type === "BOOLEAN" || tw?.type === "toggle" || tw?.type === "boolean") { opts = [BOOLEAN]; cur = cur ? "true" : "false"; }
  else {
    const v = tw?.options?.values;
    opts = (typeof v === "function" ? v() : v) ?? [];
    if (!opts.length) return;              // not a list: leave it as it was
  }
  widget(node, "options").value = opts.join("\n");
  const val = widget(node, "value"), allowed = opts[0] === BOOLEAN ? ["true", "false"] : opts.map(String);
  if (!allowed.includes(String(val.value))) { val.value = String(cur ?? allowed[0]); val.callback?.(val.value); }
  for (const refresh of node.__nkdPickers || []) refresh();
  node.setDirtyCanvas(true, true);
  publish();
}

function manifest() {
  const wf = wfStore()?.activeWorkflow;
  const m = { rev: REV, sources: [], params: [], outputs: [], workflow: wf?.path ?? wf?.filename ?? "", workflows: workflowList() };
  for (const n of bridgeNodes()) {
    const v = (name) => widget(n, name)?.value;
    if (n.type in SOURCES) {
      let kind = SOURCES[n.type];
      let binding = kind === "layer" ? String(v("source") ?? "").trim() : "";
      const bindable = kind === "layer";           // Bridge Input: the panel can rebind it
      if (binding === DOCUMENT) { kind = "canvas"; binding = ""; }
      // same key the node computes (nkd_bridge_nodes._key): a bound document prefixes it
      const d = boundDoc(v("document")), dk = d ? `doc:${d}|` : "";
      m.sources.push({ id: n.id, kind, title: n.title, binding, bindable, doc: d,
        key: dk + (kind === "layer" ? "layer:" + binding : kind) });
      // the selection is read only while its output is wired, so selecting never re-runs for nothing
      if (n.outputs?.find((o) => o.name === "selection")?.links?.length) {
        const sb = String(v("selection_source") ?? "").trim();
        const saved = sb && sb !== SELECTION;
        m.sources.push({ id: n.id, kind: "selection", title: n.title, binding: saved ? sb : "", bindable: true, doc: d,
          key: dk + (saved ? "selection:" + sb : "selection") });
      }
    } else if (n.type in PARAMS) {
      const p = { id: n.id, kind: PARAMS[n.type], name: v("name") || n.title };
      if (p.kind === "number") Object.assign(p, { value: v("value"), min: v("min"), max: v("max"), step: v("step") });
      else if (p.kind === "choice") {
        const opts = choiceOptions(n);
        if (opts[0] === BOOLEAN) Object.assign(p, { kind: "toggle", value: v("value") === "true" });
        else Object.assign(p, { value: v("value"), options: opts });
      } else p.value = v("text");
      m.params.push(Object.assign(p, { order: n.properties?.nkd_order ?? Infinity }));
    } else {
      m.outputs.push({ id: n.id, title: n.title, dest: v("destination") || "new:layer", name: v("name"),
        doc: boundDoc(v("document")), save: !!v("save_after_write") });
    }
  }
  // the order dragged in the panel; controls never dragged keep their place after them
  m.params.sort((a, b) => a.order - b.order);
  for (const p of m.params) delete p.order;
  return m;
}

/** "KSampler: Required input is missing (latent_image)" from ComfyUI's validation answer. */
function rejection(err) {
  const nodeErrors = Object.values(err?.response?.node_errors ?? app.lastNodeErrors ?? {});   // queuePrompt may just return false
  const first = nodeErrors[0], e0 = first?.errors?.[0];
  const cut = (t) => (t.length > 120 ? t.slice(0, 117) + "…" : t);
  if (e0) return `ComfyUI: ${first.class_type}: ${e0.message}${e0.details ? ` (${cut(e0.details)})` : ""}`;
  return `ComfyUI: ${err?.response?.error?.message || err?.message || "the workflow was not accepted, look at the ComfyUI tab"}`;
}

function publish(force) {
  if (!api.clientId) return;
  const m = manifest(), s = JSON.stringify(m);
  if (!force && s === lastManifest) return;
  lastManifest = s;
  tab("manifest", m);
}

function claim() {
  if (!api.clientId) return;
  tab("claim").then(() => publish(true));
}

/** Panel order: saved on each node, so it travels with the workflow. */
function setOrder({ ids }) {
  (ids ?? []).forEach((id, i) => { const n = app.graph?.getNodeById(id); if (n) (n.properties ||= {}).nkd_order = i; });
  app.graph?.setDirtyCanvas(true, true);
  app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  publish();
}

function setWidget({ node, widget: name, value }) {
  const n = app.graph?.getNodeById(node), w = n && widget(n, name);
  if (!w) return;
  w.value = value;
  w.callback?.(value);
  n.setDirtyCanvas(true, true);
  app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  publish();
}

function hideWidget(w) {                 // hidden but still serialized (never w.type = "hidden")
  w.hidden = true;
  if (w.options) w.options.hidden = true;
  w.computeSize = () => [0, -4];
}

/** Put a non-serialized combo right after widget `after` (it isn't saved, so order is free). */
function addCombo(node, after, title, value, cb, values) {
  const w = node.addWidget("combo", title, value, cb, { values, serialize: false });
  w.serialize = false;
  const ws = node.widgets;
  ws.splice(ws.indexOf(w), 1);
  ws.splice(ws.indexOf(after) + 1, 0, w);
  return w;
}

/** The raw "Path #id" string stays (it's what gets saved) but hidden; the user sees a list. */
function addPicker(node, rawName, title, labels, toLabel, fromLabel) {
  const raw = widget(node, rawName);
  if (!raw || widget(node, title)) return;
  hideWidget(raw);
  const pick = addCombo(node, raw, title, toLabel(node, raw.value), (v) => {
    const val = fromLabel(node, v);
    if (val == null) return;
    raw.value = val;
    raw.callback?.(val);
    publish();
  }, () => labels(node));
  const origCb = raw.callback;             // keep the list showing what's bound
  raw.callback = function (v) { origCb?.apply(this, arguments); pick.value = toLabel(node, v); };
  (node.__nkdPickers ||= []).push(() => { hideWidget(raw); pick.value = toLabel(node, raw.value); });
  return pick;
}

/** "Document" goes first: it decides what the layer and selection lists below it offer. */
function addDocPicker(node) {
  const pick = addPicker(node, "document", "Document", docLabelsAll, (_, v) => docToLabel(v), (_, l) => labelToDoc(l));
  if (!pick) return;
  const ws = node.widgets;
  ws.splice(ws.indexOf(pick), 1);
  ws.unshift(pick);
}

/** "Insert variable": picking one appends it to the name, then the list goes back to its prompt. */
function addVariablePicker(node) {
  const name = widget(node, "name");
  if (!name || widget(node, "Insert variable")) return;
  const w = addCombo(node, name, "Insert variable", VAR_PROMPT, (v) => {
    if (v === VAR_PROMPT) return;
    const cur = String(name.value || "");
    name.value = cur + (cur && !cur.endsWith(" ") ? " " : "") + v;
    name.callback?.(name.value);
    w.value = VAR_PROMPT;
    node.setDirtyCanvas(true, true);
    publish();
  }, () => [VAR_PROMPT, ...BUILTIN_VARS, ...paramNames().map((n) => `{${n}}`)]);
}

// Photoshop's logo blues, so Bridge nodes read as "the Photoshop end" of a workflow at a glance
const PS_TITLE = "#0a3a66", PS_BODY = "#001e36";
function paintPhotoshop(node) { node.color = PS_TITLE; node.bgcolor = PS_BODY; }

const SETUP = {
  NKDBridgeInput: (n) => {
    addPicker(n, "source", "Photoshop source", sourceLabels,
      (_, v) => (v === DOCUMENT ? DOC_LABEL : v || NONE), (_, l) => (l === DOC_LABEL ? DOCUMENT : l === NONE ? null : l));
    addPicker(n, "selection_source", "Selection source", maskLabels, maskToLabel, labelToMask);
    addDocPicker(n);
  },
  NKDBridgeChoice: (n) => {
    const opts = widget(n, "options");
    if (opts) { hideWidget(opts); (n.__nkdPickers ||= []).push(() => hideWidget(opts)); }
    addPicker(n, "value", "Value", (node) => { const o = choiceOptions(node); return o[0] === BOOLEAN ? ["true", "false"] : o; },
      (_, v) => String(v ?? ""), (_, l) => l);
    const changed = n.onConnectionsChange;
    n.onConnectionsChange = function (type, slot, connected, link) {
      const r = changed?.apply(this, arguments);
      if (type === 2 && connected) adoptTarget(this, link);       // 2 = output side
      return r;
    };
  },
  NKDBridgeOutput: (n) => {
    addPicker(n, "destination", "Destination", destLabels, (_, v) => destToLabel(v), (_, l) => labelToDest(l));
    addDocPicker(n);
    addVariablePicker(n);
  },
};

app.registerExtension({
  name: "NKD.Bridge",
  commands: [{
    id: "NKD.Bridge.DownloadPlugin",
    label: "Download NKD Comfy Bridge plugin for Photoshop",
    function: () => { window.location.href = api.apiURL("/nkd_bridge/plugin.ccx"); },
  }],
  menuCommands: [{ path: ["Extensions", "NKD Comfy Bridge"], commands: ["NKD.Bridge.DownloadPlugin"] }],

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData.name.startsWith("NKDBridge") || nodeType.prototype.__nkdWrapped) return;
    nodeType.prototype.__nkdWrapped = true;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = created?.apply(this, arguments);
      SETUP[this.type]?.(this);
      paintPhotoshop(this);
      return r;
    };
    const configured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = configured?.apply(this, arguments);
      for (const refresh of this.__nkdPickers || []) refresh();   // saved values arrive after creation
      paintPhotoshop(this);                                         // forced: a saved colour doesn't win
      return r;
    };
  },

  setup() {
    console.log(`[NKD Bridge] rev ${REV}`);
    api.addEventListener("nkd_bridge.doc", (e) => { doc = e.detail; app.graph?.setDirtyCanvas(true, true); });
    api.addEventListener("nkd_bridge.set", (e) => setWidget(e.detail));
    api.addEventListener("nkd_bridge.order", (e) => setOrder(e.detail));
    api.addEventListener("nkd_bridge.open", (e) => openWorkflow(e.detail).catch((x) => status("error", { message: `ComfyUI: ${x?.message || x}` })));
    // Same graph, same pixels as the last run that finished: nothing would change, so don't queue it
    // (a "randomize" seed still changes the graph every run, as in ComfyUI).
    let lastRun = "", queuedRun = "";
    api.addEventListener("execution_success", () => { lastRun = queuedRun; });
    api.addEventListener("nkd_bridge.run", async (e) => {
      const outputs = (e.detail?.outputs ?? []).map(String);
      let key = "";
      try { key = JSON.stringify([(await app.graphToPrompt()).output, e.detail?.sources ?? null, outputs]); } catch {}
      if (key && key === lastRun) { status("idle", { unchanged: true }); return; }
      queuedRun = key; lastRun = "";
      // a workflow ComfyUI refuses never starts, so no execution event would tell the host: say it here
      let ok, err;
      try { ok = await app.queuePrompt(0, 1, outputs.length ? { queueNodeIds: outputs } : {}); } catch (x) { ok = false; err = x; }
      if (ok === false) status("error", { message: rejection(err) });
    });

    // runner = the tab you last looked at
    api.addEventListener("status", () => { if (api.clientId && !lastManifest) claim(); });
    api.addEventListener("reconnected", claim);        // ComfyUI restarted: the server forgot us
    claim();                                           // socket may already be up when setup runs
    window.addEventListener("focus", claim);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) claim(); });
    window.addEventListener("beforeunload", () => navigator.sendBeacon?.(
      api.apiURL("/nkd_bridge/tab"),
      new Blob([JSON.stringify({ event: "bye", client_id: api.clientId })], { type: "application/json" })));

    // ponytail: 1 s poll of the bridge nodes only; switch to graph change events if it ever shows up in a profile
    setInterval(() => publish(), 1000);

    // execution status → host panel (these events only reach the tab that queued the prompt)
    let lastProgress = 0;
    api.addEventListener("execution_start", (e) => status("running", { prompt: e.detail?.prompt_id }));
    api.addEventListener("progress", (e) => {
      const now = performance.now();
      if (hosts && now - lastProgress > 100) { lastProgress = now; status("progress", { value: e.detail.value, max: e.detail.max }); }
    });
    api.addEventListener("execution_success", () => status("idle"));
    api.addEventListener("execution_interrupted", () => status("idle", { interrupted: true }));
    api.addEventListener("execution_error", (e) => status("error", { message: e.detail?.exception_message }));
    // Live sampling frames → panel. The frontend no longer hands them to extensions, so they're read
    // off ComfyUI's own socket (binary types 1 and 4 carry an image, after a short header).
    let tapped = null;
    const tapPreviews = () => {
      const sock = api.socket;
      if (!sock || sock === tapped) return;
      tapped = sock;
      sock.addEventListener("message", (e) => {
        if (!hosts || !(e.data instanceof ArrayBuffer) || e.data.byteLength < 8) return;
        const type = new DataView(e.data).getUint32(0);
        if (type !== 1 && type !== 4) return;
        const b = new Uint8Array(e.data);
        for (let i = 4; i < Math.min(b.length - 4, 512); i++) {
          const jpg = b[i] === 0xff && b[i + 1] === 0xd8 && b[i + 2] === 0xff;
          const png = b[i] === 0x89 && b[i + 1] === 0x50 && b[i + 2] === 0x4e && b[i + 3] === 0x47;
          if (jpg || png) { post("/nkd_bridge/preview", b.subarray(i), true); return; }
        }
      });
    };
    // ponytail: 1 s check catches the first socket and the new one ComfyUI makes on every reconnect
    setInterval(tapPreviews, 1000);
  },
});
