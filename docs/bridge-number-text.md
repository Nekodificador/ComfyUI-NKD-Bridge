# 😺NKD Bridge Number / 😺NKD Bridge Text

Each one shows up in the Photoshop panel as a control named after `name`: a slider for Number, a text box for Text. Drag a control by its ⋮⋮ grip to put the panel in the order you want; the order is saved with the workflow. Moving the slider writes the value into the node in your ComfyUI tab, so what you see in both places is always the same value, and it's saved with the workflow.

## Bridge Number

<img src="img/NKDBridgeNumber.png" alt="😺NKD Bridge Number" align="left" width="30%">

- `name`: the label in the panel.
- `value`, `min`, `max`, `step`: the slider.
- Outputs both `float` and `int` (rounded), so it can drive denoise or a seed.

<br clear="left">

![Bridge Number named Denoise driving the denoise input of a KSampler](img/NKDBridgeNumber-context.png)

## Bridge Text

<img src="img/NKDBridgeText.png" alt="😺NKD Bridge Text" align="left" width="30%">

- `name`: the label in the panel.
- `text`: the text. Outputs it as a string.

<br clear="left">

![Bridge Text named Prompt driving the text input of a CLIP Text Encode](img/NKDBridgeText-context.png)

---

[← All 😺NKD Comfy Bridge nodes](../README.md)
