import { useSyncExternalStore } from "react";

import { LightCurtainPaddle } from "@/components/content-mode/light-curtain-paddle";
import { PhaseRing } from "@/components/content-mode/phase-ring";
import "@/components/content-mode/content-mode-prototypes.css";
import {
    getContentModePrototypeSnapshot,
    getServerContentModePrototypeSnapshot,
    subscribeContentModePrototype,
} from "@/lib/content-mode-prototype";

/**
 * 舞台层挂载：A 顶栏光幕、C 右下相位环。
 * B 胶片轨挂在侧栏脚（见 workspace-sidebar-nav）。
 */
export function ContentModeStageHost() {
    const proto = useSyncExternalStore(
        subscribeContentModePrototype,
        getContentModePrototypeSnapshot,
        getServerContentModePrototypeSnapshot,
    );

    if (proto === "a") return <LightCurtainPaddle />;
    if (proto === "c") return <PhaseRing />;
    return null;
}
