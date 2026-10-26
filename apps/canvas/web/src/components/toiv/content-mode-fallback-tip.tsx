/**
 * 切回普通后一次性内联徽标：已回落 SFW 默认模型（普通口径）。
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import {
    COPY_FALLBACK_TIP,
    consumeFallbackTip,
    peekFallbackTip,
    subscribeFallbackTip,
} from "@/redline";

export function ContentModeFallbackTip() {
    const ping = useSyncExternalStore(
        subscribeFallbackTip,
        () => (peekFallbackTip() ? 1 : 0),
        () => 0,
    );
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (ping && consumeFallbackTip()) {
            setVisible(true);
            const t = window.setTimeout(() => setVisible(false), 8_000);
            return () => window.clearTimeout(t);
        }
    }, [ping]);

    if (!visible) return null;
    return (
        <div
            className="toiv-content-mode-fallback-tip"
            role="status"
            data-testid="content-mode-fallback-tip"
        >
            {COPY_FALLBACK_TIP}
        </div>
    );
}
