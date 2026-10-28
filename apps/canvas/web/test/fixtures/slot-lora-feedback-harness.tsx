import { App as AntApp } from "antd";
import { createRoot } from "react-dom/client";

import inventory from "@/generated/lora-inventory.json";
import { LOCAL_H3_FL2VA_BASENAME, LOCAL_IMAGE_CHECKPOINT_BASENAME } from "@/lib/local-model-defaults";
import { SLOT_LORA_STORAGE_KEY } from "@/lib/slot-lora";
import { SlotLoraRow } from "@/pages/settings/slot-lora-row";

const candidate = inventory.items.find((item) => item.slots.includes("video-primary") && !item.nsfw);
if (!candidate) throw new Error("missing SFW video-primary fixture");
window.localStorage.setItem(SLOT_LORA_STORAGE_KEY, JSON.stringify({
    "video-primary": [{ name: candidate.id, strength: 0.6, label: candidate.label }],
}));

const compatible = new URLSearchParams(window.location.search).has("compatible");

createRoot(document.getElementById("root")!).render(
    <AntApp>
        <main style={{ width: 560, margin: "40px auto", padding: 24, background: "var(--toiv-surface)" }}>
            <SlotLoraRow
                slot="video-primary"
                baseLabel={compatible ? "H3 主视频基座" : "Qwen 出图基座"}
                baseHint={compatible ? LOCAL_H3_FL2VA_BASENAME : LOCAL_IMAGE_CHECKPOINT_BASENAME}
            />
        </main>
    </AntApp>,
);
