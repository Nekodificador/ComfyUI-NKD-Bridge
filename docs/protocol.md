# Protocol

Photoshop is the first app, not the only one. Everything app-specific lives in the plugin; the ComfyUI side speaks a small protocol that any editor with a scripting API can use (Krita, Affinity, GIMP, Photopea). [`tools/fake_host.py`](../tools/fake_host.py) is a complete client in under 150 lines, and it's also the end-to-end test.

Three parties are involved. The **host** is the image editor. The **runner** is the ComfyUI browser tab you clicked last: it owns the graph and queues every run itself, which is why progress and previews show up there. The **server** is the node pack, which relays messages and keeps the uploaded pixels in memory.

## Host websocket: `GET /nkd_bridge/ws`

Messages are JSON text. The server also sends **binary** frames: those are live preview images (JPEG or PNG) forwarded from the runner tab.

Host to server:
- `{"type": "doc", "doc": {...}}`: the active document. `id`, `name`, `w`, `h` in pixels, and `layers`, a flat list of `{id, name, path, kind}` where `kind` is `layer` or `group` and `path` is `Group/Sub/Name`. Send it on connect and whenever it changes.
- `{"type": "run", "outputs": [ids] | null}`: ask the runner to queue the workflow, optionally only some Bridge Output nodes.
- `{"type": "set", "node": id, "widget": name, "value": v}`: change a widget in the runner's graph (`layer` on Layer, `destination` and `name` on Output, `value` on Number and Choice, `text` on Text; a boolean Choice takes `"true"` or `"false"`). Bindings are `Path/Name #id`, with a trailing slash on the path for groups.
- `{"type": "open", "path": "workflows/Name.json"}`: open one of the manifest's `workflows` in the runner tab.
- `{"type": "order", "ids": [ids]}`: the order of the panel's controls (`params`); the runner saves it in the workflow and sends `params` in that order from then on.
- `{"type": "cancel"}`: interrupt the running job.

Server to host:
- `status`: `{tab, manifest}` on connect and when the runner changes.
- `manifest`: what the open workflow uses. `sources` (`{id, kind, title, binding, key}`), `params` (`{id, kind, name, value, min, max, step}`; `kind` is `number`, `text`, `choice` with `options`, or `toggle` with a boolean `value`) and `outputs` (`{id, title, dest, name}`). Also `workflow`, the open workflow's path, and `workflows`, every saved one that has a Bridge Input or Output.
- `need`: `{keys}`, sources a node asked for that were never uploaded. Upload them.
- `result`: `{id, w, h, x, y, dest, name, node, doc}`. Fetch the pixels and place them at `x, y` in document pixels, in document `doc`. `dest` is `panel`, `new:layer`, `new:group` or a binding. `name` is the layer name with every variable resolved except `{n}`, which the host fills in. After creating a `new:*` destination, send a `set` of `destination` so the node stays bound to it.
- `run_status`: `state` is `running`, `progress` (with `value`, `max`), `idle` or `error` (with `message`).
- `error`: `{code, message}`. `code: "no_tab"` means no ComfyUI tab is open.

## Uploading a source: `PUT /nkd_bridge/source`

The body is raw 8-bit pixels, row by row, interleaved. Query parameters:

- `key`: the source's `key` from the manifest (`canvas`, `selection`, or `layer:<binding>`).
- `w`, `h`, `c`: size and channels (1, 3 or 4) of the body. `w=0&h=0` with an empty body means "nothing there" (empty layer, no selection).
- `x`, `y`: where the body's top-left sits in the document.
- `dw`, `dh`: the document size at the scale you're sending. Send everything at one scale; the server scales results back to the full size from `doc`.
- `hash`: anything that changes when the pixels do. Nodes use it as their cache key, so upload only when it changes.

## Getting a result: `GET /nkd_bridge/result/{id}`

Raw RGBA, 8-bit, `w × h × 4`. Add `?fmt=jpg` for a JPEG you can show in a panel.

---

[← All 😺NKD Comfy Bridge nodes](../README.md)
