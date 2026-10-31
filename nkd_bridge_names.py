"""Name templates for layers the bridge creates: "{Prompt} · s{seed} · {n}".

Resolved on the server except {n}, which only Photoshop knows (how many layers the group already
has), so it's left in place for the plugin. Unknown variables are left as typed, so a typo shows up
in the layer name instead of silently vanishing.
"""
import re
import time

VAR = re.compile(r"\{([^{}]+)\}")
BRIDGE_PARAMS = {"NKDBridgeText": "text", "NKDBridgeNumber": "value", "NKDBridgeChoice": "value", "NKDBridgeSeed": "seed"}
SEED_INPUTS = ("seed", "noise_seed")
MAX_VALUE = 40      # a whole prompt makes an unreadable layer name


def variables(prompt, doc_name="", now=None):
    """Every variable available for this run. `prompt` is the API-format graph."""
    now = now or time.localtime()
    out = {"date": time.strftime("%Y-%m-%d", now), "time": time.strftime("%H-%M-%S", now),
           "doc": re.sub(r"\.[A-Za-z0-9]+$", "", doc_name or "")}
    for node in (prompt or {}).values():
        inputs = node.get("inputs", {})
        field = BRIDGE_PARAMS.get(node.get("class_type"))
        if field and isinstance(inputs.get("name"), str) and not isinstance(inputs.get(field), list):
            v = inputs.get(field)
            out[inputs["name"]] = f"{v:g}" if isinstance(v, float) else str(v)
        for k in SEED_INPUTS:                       # first literal seed wins
            if "seed" not in out and isinstance(inputs.get(k), int):
                out["seed"] = str(inputs[k])
    return out


def resolve(template, values):
    def sub(m):
        key = m.group(1).strip()
        if key == "n":
            return m.group(0)                        # Photoshop fills it in
        v = values.get(key)
        if v is None:
            return m.group(0)
        v = " ".join(str(v).split())
        return v if len(v) <= MAX_VALUE else v[:MAX_VALUE - 1].rstrip() + "…"
    return VAR.sub(sub, template or "").strip()


if __name__ == "__main__":
    graph = {"1": {"class_type": "NKDBridgeText", "inputs": {"name": "Prompt", "text": "a man in a white\njacket"}},
             "2": {"class_type": "NKDBridgeNumber", "inputs": {"name": "Denoise", "value": 0.65}},
             "3": {"class_type": "KSampler", "inputs": {"seed": 42, "steps": 4}},
             "4": {"class_type": "NKDBridgeText", "inputs": {"name": "Linked", "text": ["9", 0]}}}
    v = variables(graph, "retrato.psd", time.strptime("2026-10-14 17:05:09", "%Y-%m-%d %H:%M:%S"))
    assert resolve("{Prompt} · s{seed} · {n}", v) == "a man in a white jacket · s42 · {n}", resolve("{Prompt} · s{seed} · {n}", v)
    assert resolve("{doc}_{date}_{time}", v) == "retrato_2026-10-14_17-05-09"
    assert resolve("d{Denoise}", v) == "d0.65"
    assert resolve("{Linked} {typo}", v) == "{Linked} {typo}"          # linked / unknown: left as typed
    assert len(resolve("{Prompt}", {"Prompt": "x" * 100})) == MAX_VALUE
    print("OK  name templates")
