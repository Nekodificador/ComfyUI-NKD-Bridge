# 😺NKD Comfy Bridge

Paint in Photoshop, generate in ComfyUI. Every layer, group or selection you want becomes its own node, wired exactly where your workflow needs it, and the result lands back in the layer you name.

<!-- hero video goes here -->

- **Bound inputs.** An Input node reads the whole document or stays tied to one layer or group, whatever layer you happen to be painting on. Only bound layers are read, and only when their pixels change, so ComfyUI keeps everything else cached.
- **You watch it run in ComfyUI.** Photoshop asks your open ComfyUI tab to queue the workflow, so progress, node highlighting and live previews show up there as if you had pressed Run yourself.
- **Results go straight to a layer.** Name the layer (or group) in the Output node and every run replaces it. No preview-then-click-send round trip.
- **Live mode.** Turn it on and the workflow re-runs when you stop drawing, one job at a time. Built for SD1.5 + LCM style models.
- **Light.** Nothing is loaded on the GPU by the bridge, pixels travel raw over localhost, and nothing polls.

**[Install it (step by step) →](docs/install.md)** · [Instalación en español →](docs/install.es.md)

## Nodes

All of them live under `😺NKD Nodes/Bridge`.

| Node | What it does |
|---|---|
| [Bridge Input](docs/nodes.md#bridge-input) | The whole document, or one layer or group bound by id, from the active document or any open one, plus the current selection, or a saved channel or path, as a mask for [inpainting](docs/nodes.md#inpainting-a-selection) |
| [Bridge Number](docs/nodes.md#bridge-number-and-bridge-text) | A slider in the Photoshop panel |
| [Bridge Text](docs/nodes.md#bridge-number-and-bridge-text) | A text box in the Photoshop panel |
| [Bridge Seed](docs/nodes.md#bridge-seed) | A seed in the Photoshop panel: type one, roll one, or fixed / random / +1 / −1 after each run |
| [Bridge Choice](docs/nodes.md#bridge-choice) | Any dropdown (sampler, scheduler, a switch's options) or on/off input as a list or checkbox in the panel |
| [Bridge Output](docs/nodes.md#bridge-output) | Sends the image back to a named layer, in the same document or [another one](docs/nodes.md#painting-in-one-document-results-in-another) such as a smart object, or to the panel |

More: [Live mode and speed](docs/live.md) · [Protocol, for adding other apps](docs/protocol.md)

### Example workflows

In [example_workflows/](example_workflows/):

- `NKD Bridge - Live SD1.5 LCM.json`: paint and watch it regenerate. The one to start with.
- `NKD Bridge - Inpaint selection SD1.5 LCM.json`: redoes only the selected area. Also needs [NKD Basic Tools](https://github.com/Nekodificador/ComfyUI-NKD-Basic-Tools).
- `NKD Bridge - ZImage Turbo Inpaint.json`: the same with Z-Image Turbo, a prompt and a denoise slider in the panel, and explained hints on each Bridge node. Also needs [NKD Basic Tools](https://github.com/Nekodificador/ComfyUI-NKD-Basic-Tools), and [NKD Notes](https://github.com/Nekodificador/ComfyUI-NKD-Notes) for the hints.
- `NKD Bridge - Klein Tools.json`: edits the document or just the selection with FLUX.2 [klein] 9B, with the prompt, Reference Strength, sampler, scheduler and a detailer switch in the panel. Needs [NKD Klein Tools](https://github.com/Nekodificador/ComfyUI-NKD-Klein-Tools), [RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF) for the sampler, and [NKD Notes](https://github.com/Nekodificador/ComfyUI-NKD-Notes) for the hints.

## Credits

Clean-room design. No code was copied from other bridges, but the ideas owe a lot to them:

- [krita-ai-diffusion](https://github.com/Acly/krita-ai-diffusion) by Acly: layers as nodes inside your own workflow, and live painting.
- [SD-PPP](https://github.com/zombieyang/sd-ppp) by zombieyang (the v1 line): input nodes bound to a layer, and results sent straight into a layer.
- [comfyui-photoshop](https://github.com/NimaNzrii/comfyui-photoshop) by NimaNzrii: the drawing panel with preview and live render.
- [ComfyUI-StableProjectorzBridge](https://github.com/tianlang0704/ComfyUI-StableProjectorzBridge) by tianlang0704: one node per data source inside the graph.

## License

GPL-3.0. See [LICENSE](LICENSE). You can use it, change it and share it; if you share a modified version, its source has to stay open too.
