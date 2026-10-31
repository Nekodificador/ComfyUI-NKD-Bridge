"""Bridge Choice and Bridge Output's mask, without a running ComfyUI (the server is stubbed).
Usage, from the ComfyUI folder with its venv: python custom_nodes/ComfyUI-NKD-Bridge/tools/check_nodes.py"""
import importlib
import os
import sys
import types

here = os.path.dirname(os.path.abspath(__file__))
comfy = os.path.abspath(os.path.join(here, "..", "..", ".."))
sys.path[:0] = [comfy, os.path.join(comfy, "custom_nodes")]
srv = types.SimpleNamespace(routes=types.SimpleNamespace(**{m: (lambda *a, **k: (lambda f: f)) for m in ("get","put","post")}), loop=None, send_sync=lambda *a: None)
sys.modules["server"] = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=srv))

pkg = importlib.import_module("ComfyUI-NKD-Bridge.nkd_bridge_nodes")
import torch
C = pkg.NKDBridgeChoice
assert C.execute("x", "true", "@boolean").args[0] is True
assert C.execute("x", "false", "@boolean").args[0] is False
assert C.execute("x", "euler", "euler\ndpmpp_2m").args[0] == "euler"
assert C.validate_inputs("x", "", "") is not True
got = {}
pkg.bridge.publish_result = lambda arr, meta: got.update(arr=arr)
O = pkg.NKDBridgeOutput
O.hidden = types.SimpleNamespace(unique_id="1", prompt={})
pkg.ui.PreviewImage = lambda *a, **k: None
img = torch.rand(1, 8, 8, 3)
O.execute(img, "panel", "n", mask=torch.zeros(1, 8, 8))
assert got["arr"][..., 3].min() == 255, "black mask must mean opaque"
m = torch.zeros(1, 8, 8); m[:, :4] = 1
O.execute(img, "panel", "n", mask=m)
assert got["arr"][:4, :, 3].min() == 255 and got["arr"][6:, :, 3].max() == 0
print("OK  Choice bool/combo, Output ignores all-black mask, keeps a real one")
rgba = torch.cat([img, torch.zeros(1, 8, 8, 1)], -1); rgba[:, 2:6, 2:6, 3] = 1
O.execute(rgba, "panel", "n")
assert got["arr"][3, 3, 3] == 255 and got["arr"][0, 0, 3] == 0, "RGBA image must keep its alpha"
O.execute(rgba, "panel", "n", mask=m)                                 # mask cuts the alpha further
assert got["arr"][3, 3, 3] == 255 and got["arr"][5, 5, 3] == 0
print("OK  RGBA image keeps its transparency, a mask cuts it further")
assert pkg.NKDBridgeSeed.execute("Seed", 1234).args[0] == 1234
print("OK  Seed passes its number through")
