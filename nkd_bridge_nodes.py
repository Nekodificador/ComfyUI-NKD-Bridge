"""NKD Comfy Bridge — nodes.

Source nodes read what the host uploaded (see nkd_bridge_server). Their fingerprint is the upload
hash, so an unchanged layer keeps every downstream node cached: drawing on another layer never
re-runs this branch. Params are plain widgets the host edits through the browser tab, so ComfyUI
caches them like any literal.
"""
import re

import numpy as np
import torch
import torch.nn.functional as F
from comfy_api.latest import io, ui

from . import nkd_bridge_names as names
from . import nkd_bridge_server as bridge

CAT = "😺NKD Nodes/Bridge"


DOCUMENT = "@document"                # Bridge Input value for the whole document
SELECTION = "@selection"              # Bridge Input selection_source: the live selection
ACTIVE = "@active"                    # document: whichever one is active in Photoshop


def _doc(document):
    """'' / '@active' -> '' (the active document), else the 'Name #id' binding."""
    b = (document or "").strip()
    return "" if b in ("", ACTIVE) else b


def _dk(document):
    """Source keys carry their document, so two documents' layers never share a cache slot."""
    b = _doc(document)
    return f"doc:{b}|" if b else ""


def _find_doc(document):
    """The host's info for a bound document: by id first (this session), then by name."""
    active = bridge.S.doc or {}
    b = _doc(document)
    if not b:
        return active
    docs = active.get("docs") or []
    m = re.search(r"#(\d+)\s*$", b)
    name = re.sub(r"\s*#\d+\s*$", "", b)
    return (next((d for d in docs if m and d.get("id") == int(m.group(1))), None)
            or next((d for d in docs if d.get("name") == name), None) or {})


def _sel_key(selection_source, document=""):
    b = (selection_source or SELECTION).strip()
    return _dk(document) + ("selection" if b in ("", SELECTION) else "selection:" + b)


def _key(source, document=""):
    b = source.strip()
    return _dk(document) + ("canvas" if b == DOCUMENT else "layer:" + b)


def _need(key, what):
    src = bridge.get_source(key)
    if src is None:
        raise RuntimeError(
            f"NKD Bridge: no data for {what}. Open the NKD Comfy Bridge panel in Photoshop "
            "and check it says 'Connected'.")
    return src


def _place(src):
    """Upload (crop at x,y) → document-sized float image + alpha."""
    dw, dh = src["dw"], src["dh"]
    out = np.zeros((dh, dw, 4), np.float32)
    arr = src["arr"]
    if arr is not None:
        h, w, c = arr.shape
        x0, y0 = src["x"], src["y"]
        # clip the upload to the document (layers can hang off canvas)
        sx, sy = max(0, -x0), max(0, -y0)
        ex, ey = min(w, dw - x0), min(h, dh - y0)
        if ex > sx and ey > sy:
            a = arr[sy:ey, sx:ex].astype(np.float32) / 255.0
            if c == 1:
                a = np.repeat(a, 3, axis=2)
            if a.shape[2] == 3:
                a = np.concatenate([a, np.ones_like(a[..., :1])], axis=2)
            out[y0 + sy:y0 + ey, x0 + sx:x0 + ex] = a
    t = torch.from_numpy(out)[None]
    return t[..., :3].contiguous(), t[..., 3].contiguous()


class NKDBridgeInput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDBridgeInput", display_name="😺NKD Bridge Input", category=CAT,
            description="The whole Photoshop document, or one layer or group (always the same one, "
                        "no matter which layer is active). Pick it with the 'Photoshop source' list "
                        "or from the panel. 'selection' is the document's current selection (or "
                        "Quick Mask), whatever the source: white = selected, black elsewhere.",
            inputs=[io.String.Input("source", default=DOCUMENT, socketless=True,
                                    tooltip=f"'{DOCUMENT}' for the whole document, or a layer/group as "
                                            "'Path/Name #id'. The id keeps the binding when you "
                                            "rename; the path is the fallback."),
                    io.String.Input("selection_source", default=SELECTION, socketless=True,
                                    tooltip=f"What 'selection' outputs: '{SELECTION}' for the live "
                                            "selection, or a saved one as 'channel:Name #id' / "
                                            "'path:Name #id'. Use the 'Selection source' list."),
                    io.String.Input("document", default=ACTIVE, socketless=True,
                                    tooltip=f"Which Photoshop document to read: '{ACTIVE}' for the "
                                            "active one, or 'Name #id' to always read that one, "
                                            "even while you work in another. Use the 'Document' list.")],
            outputs=[io.Image.Output("image"), io.Mask.Output("alpha"),
                     io.Mask.Output("selection", tooltip="Document-sized: white where selected. All "
                                                         "black with nothing selected.")])

    @classmethod
    def fingerprint_inputs(cls, source, selection_source=SELECTION, document=ACTIVE):
        # Photoshop only sends the selection while the 'selection' output is connected (the tab's
        # manifest), so an unused selection never changes this hash.
        return (f"{bridge.source_hash(_key(source, document))}|"
                f"{bridge.source_hash(_sel_key(selection_source, document))}")

    @classmethod
    def validate_inputs(cls, source, selection_source=SELECTION, document=ACTIVE):
        return True if source.strip() else "NKD Bridge Input: pick the document or a layer first."

    @classmethod
    def execute(cls, source, selection_source=SELECTION, document=ACTIVE):
        what = "the document" if source.strip() == DOCUMENT else f"layer '{source}'"
        if _doc(document):
            what += f" in '{_doc(document)}'"
        img, alpha = _place(_need(_key(source, document), what))
        sk = _sel_key(selection_source, document)
        wanted = any(x.get("key") == sk for x in (bridge.S.manifest or {}).get("sources", []))
        sel = bridge.get_source(sk) if wanted else None   # don't make Photoshop read it for nothing
        mask = _place(sel)[0][..., 0] if sel is not None else torch.zeros(img.shape[:3])
        if mask.shape != alpha.shape:            # sent at another scale: match the image
            mask = _resize(mask[..., None], img.shape[1:3])[..., 0]
        return io.NodeOutput(img, alpha, mask)


class NKDBridgeNumber(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDBridgeNumber", display_name="😺NKD Bridge Number", category=CAT,
            description="A number you can drive from the Photoshop panel (denoise, seed, steps…). "
                        "The panel shows a slider named after 'name'.",
            inputs=[io.String.Input("name", default="Denoise"),
                    io.Float.Input("value", default=0.5, min=-1e15, max=1e15, step=0.01, round=False),
                    io.Float.Input("min", default=0.0, min=-1e15, max=1e15, round=False),
                    io.Float.Input("max", default=1.0, min=-1e15, max=1e15, round=False),
                    io.Float.Input("step", default=0.01, min=0.0, max=1e9, round=False)],
            outputs=[io.Float.Output("float"), io.Int.Output("int")])

    @classmethod
    def execute(cls, name, value, min, max, step):
        return io.NodeOutput(float(value), int(round(value)))


class NKDBridgeText(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDBridgeText", display_name="😺NKD Bridge Text", category=CAT,
            description="Text you can edit from the Photoshop panel (prompts).",
            inputs=[io.String.Input("name", default="Prompt"),
                    io.String.Input("text", default="", multiline=True)],
            outputs=[io.String.Output("text")])

    @classmethod
    def execute(cls, name, text):
        return io.NodeOutput(text)


# Destination values (the widget stores one of these; the frontend shows a friendly list):
#   "panel"        only show it in the panel
#   "new:layer"    create a layer, then the node gets bound to it
#   "new:group"    create a group, then the node gets bound to it
#   "Path #id"     an existing layer: replaced on every run
#   "Path/ #id"    an existing group (trailing slash): a new layer inside on every run
DEST_DEFAULT = "new:layer"


class NKDBridgeOutput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDBridgeOutput", display_name="😺NKD Bridge Output", category=CAT,
            description="Sends the image back to Photoshop. Pick a destination: a layer is replaced "
                        "on every run, a group gets a new layer per run (so you keep the "
                        "variations; in Live mode the latest one is replaced instead), 'Panel only' "
                        "just shows it. 'name' names the layers it creates and accepts variables.",
            is_output_node=True, hidden=[io.Hidden.unique_id, io.Hidden.prompt],
            inputs=[io.Image.Input("images"),
                    io.String.Input("destination", default=DEST_DEFAULT, socketless=True,
                                    tooltip="Where the result goes. Use the 'Destination' list."),
                    io.String.Input("name", default="NKD {n}",
                                    tooltip="Name for layers it creates. Variables: {n} {seed} {date} "
                                            "{time} {doc}, and any Bridge Text/Number by its name, "
                                            "e.g. {Prompt}."),
                    io.Mask.Input("mask", optional=True,
                                  tooltip="Transparency for the written layer (white = keep). Give "
                                          "it Bridge Input's selection to change only the selection."),
                    io.String.Input("document", default=ACTIVE, socketless=True,
                                    tooltip=f"Which document gets the result: '{ACTIVE}' for the one "
                                            "the pixels came from, or 'Name #id' to send it to another "
                                            "open document (e.g. a smart object's contents). The "
                                            "result is scaled to fit that document."),
                    io.Boolean.Input("save_after_write", default=False,
                                     tooltip="Save the document after writing. Turn it on when it's a "
                                             "smart object's contents, so the parent updates by itself.")],
            outputs=[])

    @classmethod
    def fingerprint_inputs(cls, **kw):
        # always deliver: "Generate" with nothing changed must still (re)write the layer.
        # Cheap — everything upstream stays cached.
        return float("nan")

    @classmethod
    def execute(cls, images, destination, name, mask=None, document=ACTIVE, save_after_write=False):
        # ponytail: first image of the batch only; batches → panel gallery when someone needs it
        img = images[:1, ..., :3]
        a = mask.reshape(-1, *mask.shape[-2:])[:1, ..., None] if mask is not None             else torch.ones((*img.shape[:3], 1))
        rgba = torch.cat([img, _resize(a.to(img), img.shape[1:3])], dim=-1)
        doc = _find_doc(document)
        if _doc(document) and not doc:
            raise RuntimeError(f"NKD Bridge Output: the document '{_doc(document)}' isn't open in Photoshop.")
        w, h = doc.get("w") or img.shape[2], doc.get("h") or img.shape[1]
        rgba = _resize(rgba, (h, w))                 # transfer scale → document pixels
        arr = (rgba[0].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
        layer_name = names.resolve(name, names.variables(cls.hidden.prompt, doc.get("name", "")))
        bridge.publish_result(arr, {"node": cls.hidden.unique_id, "dest": destination or DEST_DEFAULT,
                                    "name": layer_name or "NKD {n}",
                                    "x": 0, "y": 0, "doc": doc.get("id"),
                                    "save": bool(save_after_write)})
        return io.NodeOutput(ui=ui.PreviewImage(img, cls=cls))


def _resize(t, hw):
    """BHWC resize; no-op when already that size."""
    if tuple(t.shape[1:3]) == tuple(hw):
        return t
    x = t.movedim(-1, 1)
    x = F.interpolate(x, size=tuple(hw), mode="bilinear", align_corners=False, antialias=True)
    return x.movedim(1, -1)


NODES = [NKDBridgeInput, NKDBridgeNumber, NKDBridgeText, NKDBridgeOutput]
