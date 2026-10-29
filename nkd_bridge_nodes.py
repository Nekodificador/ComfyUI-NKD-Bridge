"""NKD Comfy Bridge — nodes.

Source nodes read what the host uploaded (see nkd_bridge_server). Their fingerprint is the upload
hash, so an unchanged layer keeps every downstream node cached: drawing on another layer never
re-runs this branch. Params are plain widgets the host edits through the browser tab, so ComfyUI
caches them like any literal.
"""
import numpy as np
import torch
import torch.nn.functional as F
from comfy_api.latest import io, ui

from . import nkd_bridge_names as names
from . import nkd_bridge_server as bridge

CAT = "😺NKD Nodes/Bridge"
Region = io.Custom("NKD_REGION")      # dict(x, y, w, h, dw, dh) in transfer-scale pixels


def _key_layer(binding):
    return "layer:" + binding.strip()


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


class NKDBridgeCanvas(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDBridgeCanvas", display_name="😺NKD Bridge Canvas", category=CAT,
            description="The whole visible document from Photoshop (all visible layers merged).",
            outputs=[io.Image.Output("image"), io.Mask.Output("alpha")])

    @classmethod
    def fingerprint_inputs(cls, **kw):
        return bridge.source_hash("canvas")

    @classmethod
    def execute(cls):
        return io.NodeOutput(*_place(_need("canvas", "the canvas")))


class NKDBridgeLayer(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDBridgeLayer", display_name="😺NKD Bridge Layer", category=CAT,
            description="One Photoshop layer or group, always the same one no matter which layer "
                        "is active. Pick it with the 'Photoshop layer' list or from the panel.",
            inputs=[io.String.Input("layer", default="", socketless=True,
                                    tooltip="Bound layer/group as 'Path/Name #id'. The id keeps the "
                                            "binding when you rename; the path is the fallback.")],
            outputs=[io.Image.Output("image"), io.Mask.Output("alpha")])

    @classmethod
    def fingerprint_inputs(cls, layer):
        return bridge.source_hash(_key_layer(layer))

    @classmethod
    def validate_inputs(cls, layer):
        return True if layer.strip() else "NKD Bridge Layer: pick a Photoshop layer first."

    @classmethod
    def execute(cls, layer):
        return io.NodeOutput(*_place(_need(_key_layer(layer), f"layer '{layer}'")))


class NKDBridgeSelection(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDBridgeSelection", display_name="😺NKD Bridge Selection", category=CAT,
            description="The current Photoshop selection (or Quick Mask) as a mask, independent "
                        "of any layer. 'region' is its bounding box: feed it to Bridge Output to "
                        "paste the result exactly there. No selection = whole document.",
            inputs=[io.Int.Input("padding", default=0, min=0, max=1024, step=8,
                                 tooltip="Grow the region by this many pixels (context for inpaint).")],
            outputs=[io.Mask.Output("mask"), Region.Output("region")])

    @classmethod
    def fingerprint_inputs(cls, padding):
        return bridge.source_hash("selection")

    @classmethod
    def execute(cls, padding):
        src = _need("selection", "the selection")
        dw, dh = src["dw"], src["dh"]
        mask = _place(src)[0][..., 0]          # 1-channel upload → gray rgb; outside box = 0
        # The box comes from the selected pixels, not from the upload's size: Photoshop may send
        # the selection as a whole-document mask.
        ys, xs = torch.nonzero(mask[0] > 0.01, as_tuple=True)
        if len(xs) == 0:                       # nothing selected
            x, y, w, h = 0, 0, dw, dh
        else:
            x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
            x, y = max(0, x0 - padding), max(0, y0 - padding)
            w, h = min(dw, x1 + padding) - x, min(dh, y1 + padding) - y
        return io.NodeOutput(mask, {"x": x, "y": y, "w": w, "h": h, "dw": dw, "dh": dh})


class NKDBridgeCrop(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDBridgeCrop", display_name="😺NKD Bridge Crop", category=CAT,
            description="Crop an image (and mask) to a Bridge Selection region, e.g. to inpaint "
                        "only the selected area at full detail. Give the same region to Bridge "
                        "Output and the result lands back in place.",
            inputs=[io.Image.Input("image"), Region.Input("region"), io.Mask.Input("mask", optional=True)],
            outputs=[io.Image.Output("image"), io.Mask.Output("mask")])

    @classmethod
    def execute(cls, image, region, mask=None):
        # sources and regions share the transfer scale, but scale anyway in case the image was resized
        sy, sx = image.shape[1] / region["dh"], image.shape[2] / region["dw"]
        x0, y0 = round(region["x"] * sx), round(region["y"] * sy)
        x1, y1 = x0 + max(1, round(region["w"] * sx)), y0 + max(1, round(region["h"] * sy))
        img = image[:, y0:y1, x0:x1]
        if mask is None:
            m = torch.ones(img.shape[:3])
        else:
            m = _resize(mask.reshape(-1, *mask.shape[-2:])[..., None], image.shape[1:3])[..., 0][:, y0:y1, x0:x1]
        return io.NodeOutput(img, m)


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
                                  tooltip="Transparency for the written layer (white = keep)."),
                    Region.Input("region", optional=True,
                                 tooltip="From Bridge Selection: paste the result into that box "
                                         "instead of over the whole document.")],
            outputs=[])

    @classmethod
    def fingerprint_inputs(cls, **kw):
        # always deliver: "Generate" with nothing changed must still (re)write the layer.
        # Cheap — everything upstream stays cached.
        return float("nan")

    @classmethod
    def execute(cls, images, destination, name, mask=None, region=None):
        # ponytail: first image of the batch only; batches → panel gallery when someone needs it
        img = images[:1, ..., :3]
        a = mask.reshape(-1, *mask.shape[-2:])[:1, ..., None] if mask is not None             else torch.ones((*img.shape[:3], 1))
        rgba = torch.cat([img, _resize(a.to(img), img.shape[1:3])], dim=-1)
        doc = bridge.S.doc or {}
        if region:                                   # transfer-scale box → document pixels
            s = (doc.get("w") or region["dw"]) / region["dw"]
            box = [round(v * s) for v in (region["x"], region["y"], region["w"], region["h"])]
        else:
            box = [0, 0, doc.get("w") or img.shape[2], doc.get("h") or img.shape[1]]
        rgba = _resize(rgba, (box[3], box[2]))
        arr = (rgba[0].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
        layer_name = names.resolve(name, names.variables(cls.hidden.prompt, doc.get("name", "")))
        bridge.publish_result(arr, {"node": cls.hidden.unique_id, "dest": destination or DEST_DEFAULT,
                                    "name": layer_name or "NKD {n}",
                                    "x": box[0], "y": box[1], "doc": doc.get("id")})
        return io.NodeOutput(ui=ui.PreviewImage(img, cls=cls))


def _resize(t, hw):
    """BHWC resize; no-op when already that size."""
    if tuple(t.shape[1:3]) == tuple(hw):
        return t
    x = t.movedim(-1, 1)
    x = F.interpolate(x, size=tuple(hw), mode="bilinear", align_corners=False, antialias=True)
    return x.movedim(1, -1)


NODES = [NKDBridgeCanvas, NKDBridgeLayer, NKDBridgeSelection, NKDBridgeCrop,
         NKDBridgeNumber, NKDBridgeText, NKDBridgeOutput]
