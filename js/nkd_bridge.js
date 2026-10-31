// NKD Comfy Bridge — browser tab side.
// The tab is the "runner": the host (Photoshop) asks, the tab queues its own workflow, so all of
// ComfyUI's progress and live previews show here. It also publishes a manifest of the bridge
// nodes for the host panel and applies the widget edits the panel sends back.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const REV = "0.4.0";
const SOURCES = { NKDBridgeInput: "layer" };
const PARAMS = { NKDBridgeNumber: "number", NKDBridgeText: "text" };
const OUTPUT = "NKDBridgeOutput";
const NONE = "(pick a layer)";
const DOCUMENT = "@document";          // Bridge Input reading the whole document
const DOC_LABEL = "Whole document";
const SELECTION = "@selection";        // selection_source: the live selection
const SEL_LABEL = "Current selection";
const ACTIVE = "@active";              // document: whichever one is active in Photoshop
const ACTIVE_LABEL = "Active document";

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

function manifest() {
  const m = { sources: [], params: [], outputs: [], workflow: app.extensionManager?.workflow?.activeWorkflow?.filename ?? "" };
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
      else p.value = v("text");
      m.params.push(p);
    } else {
      m.outputs.push({ id: n.id, title: n.title, dest: v("destination") || "new:layer", name: v("name"),
        doc: boundDoc(v("document")), save: !!v("save_after_write") });
    }
  }
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
    api.addEventListener("nkd_bridge.run", async (e) => {
      const outputs = (e.detail?.outputs ?? []).map(String);
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
    const status = (state, extra) => tab("status", { state, ...extra });
    api.addEventListener("execution_start", (e) => status("running", { prompt: e.detail?.prompt_id }));
    api.addEventListener("progress", (e) => {
      const now = performance.now();
      if (hosts && now - lastProgress > 100) { lastProgress = now; status("progress", { value: e.detail.value, max: e.detail.max }); }
    });
    api.addEventListener("execution_success", () => status("idle"));
    api.addEventListener("execution_interrupted", () => status("idle", { interrupted: true }));
    api.addEventListener("execution_error", (e) => status("error", { message: e.detail?.exception_message }));
    api.addEventListener("b_preview", (e) => { if (hosts) post("/nkd_bridge/preview", e.detail, true); });
  },
});
