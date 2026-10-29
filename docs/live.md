# Live mode and speed

Tick **Live** in the panel and the workflow runs again every time you stop painting. It never queues a pile of jobs: while one is running, your new strokes wait, and the moment it finishes the latest state goes in. Moving a panel slider or editing the prompt triggers it too.

## Getting it fast

Most of the time goes into sampling, not into the bridge. On the machine it was developed on (RTX 5090, Windows), a trivial workflow made the full round trip, Photoshop to ComfyUI and back, in 28 to 47 ms. A 512 px SD 1.5 + LCM run at 4 steps spent about 270 ms in ComfyUI.

- **Use a distilled model.** SD 1.5 with the LCM LoRA, 4 steps, cfg 1, sampler `lcm`, scheduler `sgm_uniform`. That's what the example workflow does.
- **Set the KSampler seed to `fixed`.** With `randomize`, every run gets a new seed: the picture jumps around while you paint, and nothing can be cached.
- **Keep the working size small.** The example scales the canvas to about 0.26 megapixels (512 × 512) before sampling. In the panel ⚙, **Send resolution** limits what Photoshop sends; 512 to 768 is plenty for live work.
- **Start ComfyUI with `--disable-dynamic-vram`** if your GPU has room for the whole model. Recent ComfyUI versions prepare the model again before every run; turning that off took the sampler from about 390 ms to about 270 ms on the test machine.
- **Live previews** need ComfyUI started with `--preview-method taesd`. You'll then see the image form step by step, in your ComfyUI tab and in the panel.

## Memory

The bridge itself puts nothing on the GPU. On the ComfyUI side it keeps the last upload of each source in RAM (up to 64 of them) and the last 8 results. A 2048 px layer is 16 MB raw, so the worst case is about 1 GB; at 768 px the same 64 sources take about 150 MB.

---

[← All 😺NKD Comfy Bridge nodes](../README.md)
