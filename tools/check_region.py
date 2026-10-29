"""Check: selection → Bridge Crop → Bridge Output(region) lands the result exactly on the selection,
in document pixels, even when sources were sent downscaled.

Needs the browser tab on a workflow: Bridge Canvas → Bridge Crop(image) ← Bridge Selection(region),
Crop → Bridge Output(images), Selection.region → Output.region.
"""
import asyncio
import sys

import aiohttp
import numpy as np

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8188"
DOC_W, DOC_H, S = 1024, 768, 0.5                   # document sent at half resolution
DW, DH = int(DOC_W * S), int(DOC_H * S)
SEL = dict(x=100, y=50, w=200, h=100)               # in transfer pixels


async def put(http, key, arr, x, y):
    h, w, c = arr.shape
    q = dict(key=key, w=w, h=h, c=c, x=x, y=y, dw=DW, dh=DH, hash=str(hash(arr.tobytes())))
    async with http.put(f"{URL}/nkd_bridge/source", params=q, data=arr.tobytes()) as r:
        assert r.status == 200, await r.text()


async def main():
    async with aiohttp.ClientSession() as http, http.ws_connect(f"{URL}/nkd_bridge/ws?host=check") as ws:
        await ws.send_json({"type": "doc", "doc": {"id": 7, "name": "r.psd", "w": DOC_W, "h": DOC_H, "layers": []}})
        await ws.receive_json()
        canvas = np.full((DH, DW, 4), 255, np.uint8)
        await put(http, "canvas", canvas, 0, 0)
        # Photoshop sends the selection as a WHOLE-DOCUMENT mask: the box must come from its pixels
        sel = np.zeros((DH, DW, 1), np.uint8)
        sel[SEL["y"]:SEL["y"] + SEL["h"], SEL["x"]:SEL["x"] + SEL["w"]] = 255
        await put(http, "selection", sel, 0, 0)
        await ws.send_json({"type": "run"})
        while True:
            m = await ws.receive(timeout=60)
            if m.type != aiohttp.WSMsgType.TEXT:
                continue
            msg = m.json()
            if msg["type"] == "result":
                break
            if msg["type"] == "error" or msg.get("state") == "error":
                sys.exit(f"FAIL: {msg}")
        got = (msg["x"], msg["y"], msg["w"], msg["h"])
        want = (SEL["x"] / S, SEL["y"] / S, SEL["w"] / S, SEL["h"] / S)
        print("result box", got, "expected", want)
        if got != tuple(int(v) for v in want):
            sys.exit("FAIL: result not placed on the selection")
        print("OK  region placement")


asyncio.run(main())
