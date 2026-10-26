/**
 * 内容模式 UI 原型切换（临时对比 A/B/C，非产品 SSOT）。
 * localStorage 仅选壳；真源仍为 redline me/mode。
 */
export type ContentModePrototypeId = "a" | "b" | "c";

export const CONTENT_MODE_PROTOTYPE_KEY = "toiv_content_mode_prototype";
export const CONTENT_MODE_PROTOTYPE_EVENT = "toiv-content-mode-prototype";

export const PROTOTYPE_META: Record<
    ContentModePrototypeId,
    { id: ContentModePrototypeId; label: string; short: string; placement: string }
> = {
    a: { id: "a", label: "A 光幕拨片", short: "光幕", placement: "舞台顶栏" },
    b: { id: "b", label: "B 胶片双轨", short: "胶片", placement: "侧栏脚" },
    c: { id: "c", label: "C 相位环", short: "相位环", placement: "右下悬浮" },
};

function normalize(raw: unknown): ContentModePrototypeId {
    const v = String(raw ?? "").trim().toLowerCase();
    if (v === "a" || v === "b" || v === "c") return v;
    return "b";
}

export function getContentModePrototype(): ContentModePrototypeId {
    if (typeof window === "undefined") return "b";
    try {
        return normalize(window.localStorage.getItem(CONTENT_MODE_PROTOTYPE_KEY));
    } catch {
        return "b";
    }
}

export function setContentModePrototype(id: ContentModePrototypeId): void {
    if (typeof window === "undefined") return;
    const next = normalize(id);
    try {
        window.localStorage.setItem(CONTENT_MODE_PROTOTYPE_KEY, next);
    } catch {
        /* ignore */
    }
    window.dispatchEvent(new CustomEvent(CONTENT_MODE_PROTOTYPE_EVENT, { detail: { id: next } }));
}

export function subscribeContentModePrototype(onChange: () => void): () => void {
    if (typeof window === "undefined") return () => {};
    const handler = () => onChange();
    window.addEventListener(CONTENT_MODE_PROTOTYPE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
        window.removeEventListener(CONTENT_MODE_PROTOTYPE_EVENT, handler);
        window.removeEventListener("storage", handler);
    };
}

export function getContentModePrototypeSnapshot(): ContentModePrototypeId {
    return getContentModePrototype();
}

export function getServerContentModePrototypeSnapshot(): ContentModePrototypeId {
    return "b";
}
