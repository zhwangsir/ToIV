/**
 * M2 加强点（轻量）：市场应用注册为画布「待接 provider」清单。
 * 本批只做本地注册表（localStorage），供后续 create-menu / 节点模板读取；
 * 真正的画布节点 provider 接线（生成通道/参数映射）下一切片再做。
 */
const STORAGE_KEY = "toiv_market_canvas_providers";

export type ToivMarketProviderEntry = {
    id: string;
    name: string;
    category?: string;
    output_kind?: string;
    registered_at: string;
};

function readRaw(): ToivMarketProviderEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        const out: ToivMarketProviderEntry[] = [];
        for (const item of parsed) {
            const r = (item ?? {}) as Record<string, unknown>;
            const id = String(r.id ?? "").trim();
            const name = String(r.name ?? "").trim();
            if (!id || !name) continue;
            const entry: ToivMarketProviderEntry = {
                id,
                name,
                registered_at: String(r.registered_at ?? new Date().toISOString()),
            };
            if (r.category != null) entry.category = String(r.category);
            if (r.output_kind != null) entry.output_kind = String(r.output_kind);
            out.push(entry);
        }
        return out;
    } catch {
        return [];
    }
}

function writeRaw(entries: ToivMarketProviderEntry[]): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function listMarketCanvasProviders(): ToivMarketProviderEntry[] {
    return readRaw();
}

export function isMarketCanvasProvider(id: string): boolean {
    return readRaw().some((e) => e.id === id);
}

/** 注册（幂等：同 id 覆盖 name/分类并刷新时间） */
export function registerMarketCanvasProvider(entry: {
    id: string;
    name: string;
    category?: string;
    output_kind?: string;
}): ToivMarketProviderEntry {
    const id = entry.id.trim();
    const name = entry.name.trim();
    if (!id || !name) throw new Error("应用 id/名称不能为空");
    const next: ToivMarketProviderEntry = {
        id,
        name,
        category: entry.category,
        output_kind: entry.output_kind,
        registered_at: new Date().toISOString(),
    };
    const others = readRaw().filter((e) => e.id !== id);
    writeRaw([next, ...others]);
    return next;
}

export function unregisterMarketCanvasProvider(id: string): boolean {
    const before = readRaw();
    const after = before.filter((e) => e.id !== id);
    if (after.length === before.length) return false;
    writeRaw(after);
    return true;
}
