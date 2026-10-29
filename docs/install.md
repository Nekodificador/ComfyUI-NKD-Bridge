# Installing NKD Comfy Bridge

Two pieces get installed: a node pack inside ComfyUI, and a small panel inside Photoshop. It takes about five minutes. Follow the steps in order and don't skip the checks: each one tells you the step before it worked.

## What you need

- **Photoshop 2023 (version 24.4) or newer.** To check: in Photoshop, `Help > About Photoshop`.
- **ComfyUI** already installed and working (you can open it in your browser and run a workflow).
- **Creative Cloud desktop app**, the one that installed Photoshop. It is used to install the panel.

## Step 1. Install the nodes in ComfyUI

**Option A: with ComfyUI Manager (easiest)**

1. Open ComfyUI in your browser.
2. Click **Manager**, then **Custom Nodes Manager**.
3. Search for `NKD Comfy Bridge` and click **Install**.
4. When it finishes, click **Restart** and wait until ComfyUI loads again.

**Option B: by hand**

1. Open a terminal in your `ComfyUI/custom_nodes` folder.
2. Run:
   ```bash
   git clone https://github.com/Nekodificador/ComfyUI-NKD-Bridge
   ```
3. Restart ComfyUI.

**Check:** double-click on an empty spot of the ComfyUI canvas and type `Bridge`. You should see seven nodes starting with `😺NKD Bridge`. If you don't, ComfyUI didn't restart or the install failed; look at the ComfyUI console for a red line mentioning `NKD-Bridge`.

## Step 2. Install the Photoshop panel

**Windows, the quick way:** open the folder `ComfyUI/custom_nodes/ComfyUI-NKD-Bridge` and double-click **`install-photoshop-plugin.bat`**. A black window opens, says `Done`, and you can close it.

**Any system (Windows or Mac):**

1. In ComfyUI, open the top-left menu (the ComfyUI logo), then **Extensions > NKD Comfy Bridge > Download NKD Comfy Bridge plugin for Photoshop**. A file called `NKD-Comfy-Bridge.ccx` lands in your Downloads folder.
2. Double-click that file. The Creative Cloud app opens and warns that the plugin doesn't come from the Adobe marketplace. That's expected: click **Install**.

**Check:** open (or restart) Photoshop. In the top menu go to **Plugins**. You should see **NKD Comfy Bridge**; click it and the panel opens.

## Step 3. Connect

With ComfyUI running and its tab open in your browser, look at the top of the panel:

| The panel shows | Meaning | What to do |
|---|---|---|
| ● Connected to ComfyUI | All good | Go to step 4 |
| ◐ Connected · open ComfyUI in your browser | Photoshop found ComfyUI but no browser tab is open | Open ComfyUI in your browser. Any tab works; the last one you clicked is the one that runs |
| ○ Not connected, retrying | Photoshop can't reach ComfyUI | Is ComfyUI running? If it isn't at `http://127.0.0.1:8188`, click the ⚙ in the panel and type its address (the one in your browser bar) |

## Step 4. Your first run

1. In ComfyUI, open the top-left menu, then **File > Open**, and pick `example_workflows/NKD Bridge - Live SD1.5 LCM.json` from the `ComfyUI-NKD-Bridge` folder. (Or drag the file onto the ComfyUI canvas.)
2. The example uses two models. If ComfyUI marks them red, download them and pick yours in the two loader nodes:
   - an SD 1.5 checkpoint, for example `v1-5-pruned-emaonly.safetensors`, into `models/checkpoints`
   - the LCM LoRA for SD 1.5, `lcm-lora-sdv1-5.safetensors`, into `models/loras`
3. In Photoshop, create a document (1024 × 1024 is fine) and paint some colour blobs.
4. In the panel, press **Generate**. You'll see the progress in your ComfyUI tab, and the result appears in the panel and as a new layer called `NKD Live 1`.
5. Tick **Live** and keep painting: it regenerates each time you pause.
6. For inpainting, open `NKD Bridge - Inpaint selection SD1.5 LCM.json` instead, make a selection in Photoshop and press **Generate**: only the selected area is redone, and the result lands back on it as the `NKD Inpaint 1` layer.

## Binding a layer to a node

Use a **😺NKD Bridge Layer** node when one part of your workflow should always read the same layer or group.

- In ComfyUI, pick the layer in the node's **Photoshop layer** list. Or,
- in Photoshop, select the layer, open the panel's **Inputs & outputs** tab and press **Use active** next to that input.

The binding is saved with the workflow. Renaming the layer doesn't break it.

## If something goes wrong

| Problem | Fix |
|---|---|
| No **Plugins > NKD Comfy Bridge** menu | Restart Photoshop. Still missing: run the install again and read the message in the black window |
| Creative Cloud says the file is invalid | Download the `.ccx` again from the ComfyUI menu; a half-downloaded file can't be installed |
| The panel is blank | Update Photoshop to the latest version from the Creative Cloud app |
| "Open ComfyUI in your browser first" | The bridge runs workflows through your ComfyUI tab, so that you can watch them. Open it |
| An input shows **!** | That node's layer no longer exists in this document. Bind it again |
| Generate does nothing | The workflow needs at least one **😺NKD Bridge Output** node |
| ComfyUI is on another computer | Put its address in the ⚙ settings (for example `http://192.168.1.20:8188`) and start ComfyUI with `--listen` |

---

[← All 😺NKD Comfy Bridge nodes](../README.md)
