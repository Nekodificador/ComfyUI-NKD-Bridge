"""Serves the Photoshop plugin as a .ccx built on the fly from ./photoshop, so the plugin a user
downloads always matches the node pack they have installed (no separate release to keep in sync)."""
import io
import os
import zipfile

from aiohttp import web
from server import PromptServer

PLUGIN_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "photoshop")


def build_ccx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(PLUGIN_DIR):
            for f in files:
                p = os.path.join(root, f)
                z.write(p, os.path.relpath(p, PLUGIN_DIR).replace(os.sep, "/"))
    return buf.getvalue()


@PromptServer.instance.routes.get("/nkd_bridge/plugin.ccx")
async def download_plugin(request):
    return web.Response(body=build_ccx(), content_type="application/octet-stream", headers={
        "Content-Disposition": 'attachment; filename="NKD-Comfy-Bridge.ccx"'})
