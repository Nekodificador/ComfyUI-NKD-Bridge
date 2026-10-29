from typing_extensions import override
from comfy_api.latest import ComfyExtension, io

from . import nkd_bridge_server  # noqa: F401 — registers /nkd_bridge/* at import time
from . import nkd_bridge_plugin  # noqa: F401 — serves the Photoshop plugin download
from .nkd_bridge_nodes import NODES

WEB_DIRECTORY = "./js"


class NKDBridgeExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return NODES


async def comfy_entrypoint() -> NKDBridgeExtension:
    return NKDBridgeExtension()


NODE_CLASS_MAPPINGS = {n.__name__: n for n in NODES}
NODE_DISPLAY_NAME_MAPPINGS = {n.__name__: "😺NKD " + n.__name__[3:].replace("Bridge", "Bridge ")
                              for n in NODES}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
