"""NKD Comfy Bridge — server side.

A thin relay between image-editor "hosts" (Photoshop today) and the ComfyUI browser tab.

    host  ──ws /nkd_bridge/ws──▶ server ──send_sync──▶ runner tab (queues the workflow itself,
          ◀──────────────────── server ◀──POST /nkd_bridge/tab── so progress/previews show there)
    host  ──PUT /nkd_bridge/source?key=…──▶ in-memory store ──▶ NKD Bridge source nodes

The browser tab is the source of truth for the graph: it publishes a manifest (which sources,
params and outputs the workflow has) and applies widget edits sent by the host. The host is the
source of truth for pixels: it uploads raw bound sources only when their hash changes.
"""
import asyncio
import io as _io
import itertools
import json
import logging
import threading
import time
from collections import OrderedDict

import numpy as np
from aiohttp import web, WSMsgType
from server import PromptServer

PROTOCOL = 1
MAX_SOURCES = 64          # ponytail: plain LRU by count; raw RGBA ≤2048² is 16 MB, so worst case ~1 GB
MAX_RESULTS = 8

log = logging.getLogger("NKD Bridge")


class _State:
    """Hung off PromptServer.instance so hot reloads don't split it (see nkd-node: routes)."""

    def __init__(self):
        self.hosts = set()                 # live host websockets
        self.runner = None                 # client_id of the tab that queues runs
        self.doc = None                    # last document info from the host
        self.manifest = None               # last manifest from the runner tab
        self.sources = OrderedDict()       # key -> dict(hash, arr HxWxC uint8, x, y, dw, dh)
        self.results = OrderedDict()       # id -> dict(rgba bytes, w, h, jpg)
        self.uploaded = threading.Condition()
        self.ids = itertools.count(1)


srv = PromptServer.instance
if not hasattr(srv, "nkd_bridge"):
    srv.nkd_bridge = _State()
S = srv.nkd_bridge
routes = srv.routes


# ── outgoing ────────────────────────────────────────────────────────────────────────────────

async def _broadcast_hosts(msg):
    for ws in list(S.hosts):
        try:
            if isinstance(msg, (bytes, bytearray)):
                await ws.send_bytes(msg)
            else:
                await ws.send_json(msg)
        except Exception:
            S.hosts.discard(ws)


def send_hosts(msg):
    """Thread-safe: callable from node execute (worker thread) or from the server loop."""
    if not S.hosts:
        return
    coro = _broadcast_hosts(msg)
    try:
        if asyncio.get_running_loop() is srv.loop:
            return asyncio.ensure_future(coro)
    except RuntimeError:
        pass
    asyncio.run_coroutine_threadsafe(coro, srv.loop)


def send_tab(event, data, everyone=False):
    srv.send_sync("nkd_bridge." + event, data, None if everyone else S.runner)


def host_status():
    return {"type": "status", "protocol": PROTOCOL, "tab": S.runner is not None,
            "manifest": S.manifest}


# ── sources (host → nodes) ──────────────────────────────────────────────────────────────────

def get_source(key, timeout=4.0):
    """Latest upload for `key`. If the host is connected but hasn't sent it yet, ask and wait."""
    with S.uploaded:
        if key not in S.sources and S.hosts:
            send_hosts({"type": "need", "keys": [key]})
            S.uploaded.wait_for(lambda: key in S.sources, timeout)
        return S.sources.get(key)


def source_hash(key):
    src = S.sources.get(key)
    return src["hash"] if src else None


def _intarg(q, name, default=0):
    try:
        return int(q.get(name, default))
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text=f"bad {name}")


@routes.put("/nkd_bridge/source")
async def put_source(request):
    q = request.query
    key = q.get("key", "")
    if not key or len(key) > 300:
        raise web.HTTPBadRequest(text="bad key")
    w, h, c = _intarg(q, "w"), _intarg(q, "h"), _intarg(q, "c", 4)
    body = await request.read()
    if w == 0 or h == 0:                     # e.g. empty selection / empty layer
        arr = None
    else:
        if c not in (1, 3, 4) or len(body) != w * h * c:
            raise web.HTTPBadRequest(text=f"size mismatch: {len(body)} != {w}x{h}x{c}")
        arr = np.frombuffer(body, np.uint8).reshape(h, w, c)
    src = {"hash": q.get("hash") or str(hash(body)), "arr": arr,
           "x": _intarg(q, "x"), "y": _intarg(q, "y"),
           "dw": _intarg(q, "dw", w), "dh": _intarg(q, "dh", h)}
    if key not in S.sources:
        log.info("[NKD Bridge] first upload of '%s': %sx%sx%s at %s,%s", key, w, h, c, q.get("x"), q.get("y"))
    with S.uploaded:
        S.sources.pop(key, None)
        S.sources[key] = src
        while len(S.sources) > MAX_SOURCES:
            S.sources.popitem(last=False)
        S.uploaded.notify_all()
    return web.json_response({"ok": True})


# ── results (nodes → host) ──────────────────────────────────────────────────────────────────

def publish_result(rgba, meta):
    """rgba: HxWx4 uint8. Stores it and tells hosts where it should go."""
    from PIL import Image
    rid = str(next(S.ids))
    h, w = rgba.shape[:2]
    buf = _io.BytesIO()
    Image.fromarray(rgba[..., :3]).save(buf, "JPEG", quality=90)
    S.results[rid] = {"rgba": rgba.tobytes(), "w": w, "h": h, "jpg": buf.getvalue()}
    while len(S.results) > MAX_RESULTS:
        S.results.popitem(last=False)
    send_hosts({"type": "result", "id": rid, "w": w, "h": h, **meta})
    return rid


@routes.get("/nkd_bridge/result/{rid}")
async def get_result(request):
    r = S.results.get(request.match_info["rid"])
    if not r:
        raise web.HTTPNotFound()
    if request.query.get("fmt") == "jpg":
        return web.Response(body=r["jpg"], content_type="image/jpeg")
    return web.Response(body=r["rgba"], content_type="application/octet-stream")


# ── browser tab ↔ server ───────────────────────────────────────────────────────────────────

@routes.post("/nkd_bridge/tab")
async def from_tab(request):
    msg = await request.json()
    ev, data = msg.get("event"), msg.get("data")
    if ev == "claim":                      # the most recently focused tab runs the workflows
        S.runner = msg.get("client_id") or None
        if S.doc:
            send_tab("doc", S.doc)
        await _broadcast_hosts(host_status())
    elif ev == "manifest":
        if msg.get("client_id") == S.runner:
            S.manifest = data
            await _broadcast_hosts({"type": "manifest", "manifest": data})
    elif ev == "status":                   # execution progress forwarded to the host panel
        await _broadcast_hosts({"type": "run_status", **(data or {})})
    elif ev == "bye" and msg.get("client_id") == S.runner:
        S.runner = None
        await _broadcast_hosts(host_status())
    return web.json_response({"ok": True, "hosts": len(S.hosts)})


@routes.post("/nkd_bridge/preview")
async def from_tab_preview(request):
    """Latent preview JPEG/PNG the runner tab got from ComfyUI → host panel (binary ws frame)."""
    body = await request.read()
    if S.hosts and len(body) < 4 * 1024 * 1024:
        await _broadcast_hosts(body)
    return web.json_response({"ok": True})


# ── host websocket ─────────────────────────────────────────────────────────────────────────

@routes.get("/nkd_bridge/ws")
async def host_ws(request):
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024 * 1024)
    await ws.prepare(request)
    S.hosts.add(ws)
    log.info("[NKD Bridge] host connected (%s)", request.query.get("host", "?"))
    await ws.send_json(host_status())
    try:
        async for m in ws:
            if m.type != WSMsgType.TEXT:
                continue
            try:
                await _on_host_msg(ws, json.loads(m.data))
            except Exception as exc:          # never let one bad message kill the socket
                log.exception("[NKD Bridge] host message failed")
                await ws.send_json({"type": "error", "message": str(exc)})
    finally:
        S.hosts.discard(ws)
        log.info("[NKD Bridge] host disconnected")
    return ws


async def _on_host_msg(ws, msg):
    t = msg.get("type")
    if t == "hello":
        await ws.send_json(host_status())
    elif t == "doc":
        S.doc = msg.get("doc")
        send_tab("doc", S.doc, everyone=True)   # every tab gets the layer list for its pickers
    elif t in ("run", "set"):
        if S.runner is None:
            await ws.send_json({"type": "error", "code": "no_tab",
                                "message": "Open ComfyUI in your browser to run workflows."})
            return
        send_tab(t, msg)
    elif t == "cancel":
        import comfy.model_management
        comfy.model_management.interrupt_current_processing()
    elif t == "ping":
        await ws.send_json({"type": "pong", "t": msg.get("t"), "now": time.time()})
    elif t == "log":                           # host-side errors end up in the ComfyUI console
        S.host_log = (getattr(S, "host_log", []) + [msg.get("message", "")])[-20:]
        log.warning("[NKD Bridge] host: %s", msg.get("message"))


@routes.get("/nkd_bridge/debug")
async def debug(request):
    """What the bridge currently knows. Paste this when reporting a problem."""
    return web.json_response({
        "hosts": len(S.hosts), "runner": S.runner,
        "doc": S.doc and {k: v for k, v in S.doc.items() if k != "layers"} | {"layers": len(S.doc.get("layers", []))},
        "manifest": S.manifest,
        "sources": {k: {"hash": v["hash"], "shape": None if v["arr"] is None else list(v["arr"].shape),
                        "x": v["x"], "y": v["y"], "dw": v["dw"], "dh": v["dh"]} for k, v in S.sources.items()},
        "results": list(S.results), "host_log": getattr(S, "host_log", [])})
