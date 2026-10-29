"""Reference host for the NKD Comfy Bridge protocol — and its end-to-end check.

Pretends to be Photoshop: connects, publishes a document with two layers, uploads them as raw
pixels, asks the browser tab to run, and waits for the result. Any new host adapter (Krita,
Affinity, Photopea…) only has to do what this file does.

    python tools/fake_host.py [--url http://127.0.0.1:8188] [--runs 3]

Needs ComfyUI running with a browser tab open on a workflow containing a 😺NKD Bridge Layer bound
to "Sketch #2" (or a Canvas node) feeding a 😺NKD Bridge Output. Prints the round-trip latency.
"""
import argparse
import asyncio
import hashlib
import json
import sys
import time

import aiohttp
import numpy as np

W, H = 512, 512


def layer_pixels(seed):
    rng = np.random.default_rng(seed)
    a = np.zeros((H, W, 4), np.uint8)
    a[64:448, 64:448, :3] = rng.integers(0, 255, 3, dtype=np.uint8)
    a[64:448, 64:448, 3] = 255
    return a


async def upload(http, url, key, arr, x=0, y=0):
    body = arr.tobytes()
    h, w, c = arr.shape
    q = dict(key=key, w=w, h=h, c=c, x=x, y=y, dw=W, dh=H, hash=hashlib.md5(body).hexdigest())
    async with http.put(f"{url}/nkd_bridge/source", params=q, data=body) as r:
        assert r.status == 200, await r.text()


async def main(url, runs, check_cache=True):
    doc = {"id": 1, "name": "fake.psd", "w": W, "h": H,
           "layers": [{"id": 1, "name": "Background", "path": "Background", "kind": "layer"},
                      {"id": 2, "name": "Sketch", "path": "Sketch", "kind": "layer"}]}
    async with aiohttp.ClientSession() as http:
        async with http.ws_connect(f"{url}/nkd_bridge/ws?host=fake") as ws:
            await ws.send_json({"type": "doc", "doc": doc})
            status = await ws.receive_json()
            print("status:", json.dumps(status)[:300])
            if not status.get("tab"):
                sys.exit("FAIL: no ComfyUI browser tab registered as runner — open ComfyUI first.")
            manifest = status.get("manifest") or {}
            keys = {s["key"] for s in manifest.get("sources", [])} or {"canvas", "layer:Sketch #2"}
            print("manifest sources:", keys)

            async def cached_nodes(prompt_id):
                async with http.get(f"{url}/history/{prompt_id}") as r:
                    hist = (await r.json())[prompt_id]
                return {n for ev, d in hist["status"]["messages"] if ev == "execution_cached" for n in d["nodes"]}

            # pixel sequence: same, same, changed → the source node must be cached on run 1 only
            seeds = [0, 0, 1] + list(range(2, runs)) if check_cache else list(range(runs))
            times, prompts = [], []
            for i, seed in enumerate(seeds):
                for k in keys:
                    await upload(http, url, k, layer_pixels(seed if "Sketch" in k or k == "canvas" else 99))
                t0 = time.perf_counter()
                await ws.send_json({"type": "run"})
                while True:
                    m = await ws.receive(timeout=120)
                    if m.type == aiohttp.WSMsgType.BINARY:
                        print(f"  preview frame {len(m.data)} B")
                        continue
                    msg = json.loads(m.data)
                    if msg["type"] == "error":
                        sys.exit(f"FAIL: {msg}")
                    if msg["type"] == "result":
                        async with http.get(f"{url}/nkd_bridge/result/{msg['id']}") as r:
                            raw = await r.read()
                        assert len(raw) == msg["w"] * msg["h"] * 4, "result size mismatch"
                        dt = (time.perf_counter() - t0) * 1000
                        times.append(dt)
                        print(f"run {i}: result {msg['w']}x{msg['h']} -> {msg['dest']} as '{msg['name']}' in {dt:.0f} ms")
                        break
                    if msg["type"] == "run_status" and msg.get("state") == "running":
                        prompts.append(msg.get("prompt"))
                    if msg["type"] == "run_status" and msg.get("state") == "error":
                        sys.exit(f"FAIL: workflow error: {msg.get('message')}")
            if check_cache:
                src_ids = {str(s["id"]) for s in manifest.get("sources", [])}
                c = [await cached_nodes(p) for p in prompts[:3]]
                print("cached per run:", [sorted(x) for x in c])
                if not (src_ids <= c[1] and not (src_ids & c[2])):
                    sys.exit("FAIL: unchanged source was not cached, or changed source was cached")
                print("OK  cache: unchanged layer reused, changed layer re-read")
            print(f"OK  median round trip {sorted(times)[len(times) // 2]:.0f} ms")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8188")
    ap.add_argument("--runs", type=int, default=3)
    a = ap.parse_args()
    asyncio.run(main(a.url, max(3, a.runs)))
