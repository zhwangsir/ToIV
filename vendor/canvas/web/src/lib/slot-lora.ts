/**
 * 设置页角色槽的 LoRA 挂件（本地偏好，非并列主槽）。
 * - 挂在出图 / 出视频主 / 出视频运动槽下
 * - 候选：引擎 /api/models/engines 的 type=loras ∪ 调研库存 JSON（来源 A+B × 用途 P-A/P-B）
 * - 隔离 / P-C / 来源 C|D 不进可用列表
 * - P1：钉选经 resolvePinnedLorasForGenerate 校验后注入市场生成（不兼容阻断）
 */
import {
    assertLorasCompatible,
    compatBadgeLabel,
    familyLabel,
    getLoraCompatRow,
    listCompatCandidatesForSlot,
    resolveFamilyHint,
    type CompatConfidence,
    type CompatStatus,
} from "@/lib/model-compat";
import { toivHttp } from "@/services/toiv/client";
import { filterNsfwListableAssets } from "@/redline";

export const SLOT_LORA_STORAGE_KEY = "toiv.model-mix.slotLoras";
export const SLOT_LORA_CAP = 3;

export type SlotLoraKey = "image" | "video-primary" | "video-motion";

export type SlotLoraPick = {
    name: string;
    strength: number;
    label?: string;
    /** 图谱触发词（有证据才写） */
    triggers?: string[];
};

export type SlotLoraCandidate = {
    value: string;
    label: string;
    nsfw?: boolean;
    engineIds?: string[];
    /** 调研用途文案 */
    purposeZh?: string;
    purposeGrade?: string;
    /** 加速 / 画风 / 角色 / 运镜 … */
    typeTag?: string;
    sourceUrl?: string;
    fromInventory?: boolean;
    /** 兼容置信度 A/B/C */
    compatConfidence?: CompatConfidence | string;
    compatStatus?: CompatStatus | string;
    /** D1：仅命名推断 */
    heuristic?: boolean;
    compatBadge?: string;
    recommendedStrength?: number;
    /** catalog | card | model_sources | heuristic */
    strengthSource?: string;
    triggers?: string[];
    /** 角色互斥 / 文件级互斥提示 */
    conflicts?: string[];
    /** 同 role 可替换 */
    substitutes?: string[];
};

type SlotLoraMap = Partial<Record<SlotLoraKey, SlotLoraPick[]>>;

export const SLOT_LORA_EMPTY_HINT: Record<SlotLoraKey, string> = {
    image:
        "当前底模族下无兼容 LoRA（含命名推断）。请确认已生成 lora-inventory.json 与 model-compat-graph.json，或换一个出图底模。",
    "video-primary":
        "当前 H3 底模下无兼容 LoRA。请确认 H3 专属库存 / 图谱，或 H3 引擎在线。",
    "video-motion":
        "当前运动底模族下无兼容 LoRA。请重新生成兼容图谱，或到生成台按引擎选。",
};

function clampStrength(n: unknown, fallback = 0.6): number {
    const v = typeof n === "number" ? n : Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(2, Math.max(0, Math.round(v * 100) / 100));
}

function normalizePicks(raw: unknown): SlotLoraPick[] {
    if (!Array.isArray(raw)) return [];
    const out: SlotLoraPick[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const name = String((item as SlotLoraPick).name || "").trim();
        if (!name) continue;
        const triggersRaw = (item as SlotLoraPick).triggers;
        const triggers = Array.isArray(triggersRaw)
            ? triggersRaw.map((t) => String(t).trim()).filter(Boolean)
            : undefined;
        out.push({
            name,
            strength: clampStrength((item as SlotLoraPick).strength, 0.6),
            label: typeof (item as SlotLoraPick).label === "string" ? (item as SlotLoraPick).label : undefined,
            triggers: triggers?.length ? triggers : undefined,
        });
        if (out.length >= SLOT_LORA_CAP) break;
    }
    return out;
}

export function readSlotLoras(slot: SlotLoraKey): SlotLoraPick[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(SLOT_LORA_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as SlotLoraMap;
        return normalizePicks(parsed?.[slot]);
    } catch {
        return [];
    }
}

export function writeSlotLoras(slot: SlotLoraKey, picks: SlotLoraPick[]): boolean {
    if (typeof window === "undefined") return false;
    try {
        const raw = window.localStorage.getItem(SLOT_LORA_STORAGE_KEY);
        const map: SlotLoraMap = raw ? (JSON.parse(raw) as SlotLoraMap) : {};
        map[slot] = normalizePicks(picks);
        window.localStorage.setItem(SLOT_LORA_STORAGE_KEY, JSON.stringify(map));
        return true;
    } catch {
        return false;
    }
}

export function formatSlotLoraSummary(picks: SlotLoraPick[]): string {
    if (!picks.length) return "未挂 LoRA";
    return picks.map((p) => `${p.label || p.name.split("/").pop() || p.name}·${p.strength}`).join(" · ");
}

type EngineParamOption = { value?: string; label?: string; nsfw?: boolean };
type EngineParam = { key?: string; type?: string; options?: EngineParamOption[] };
type EngineInfo = { id?: string; kind?: string; label?: string; params?: EngineParam[] };

function collectLoraOptions(engines: EngineInfo[], predicate: (engine: EngineInfo) => boolean): SlotLoraCandidate[] {
    const byValue = new Map<string, SlotLoraCandidate>();
    for (const engine of engines) {
        if (!predicate(engine)) continue;
        const params = Array.isArray(engine.params) ? engine.params : [];
        for (const param of params) {
            if (param?.type !== "loras" && param?.key !== "loras") continue;
            const options = Array.isArray(param.options) ? param.options : [];
            for (const opt of options) {
                const value = String(opt?.value || "").trim();
                if (!value) continue;
                const prev = byValue.get(value);
                const engineId = String(engine.id || "");
                if (prev) {
                    if (engineId && !prev.engineIds?.includes(engineId)) prev.engineIds = [...(prev.engineIds || []), engineId];
                    continue;
                }
                byValue.set(value, {
                    value,
                    label: String(opt?.label || value),
                    nsfw: Boolean(opt?.nsfw),
                    engineIds: engineId ? [engineId] : [],
                });
            }
        }
    }
    return Array.from(byValue.values());
}

function isPrimaryVideoEngine(engine: EngineInfo): boolean {
    const id = String(engine.id || "").toLowerCase();
    const label = String(engine.label || "").toLowerCase();
    return id.includes("h3") || label.includes("h3") || label.includes("minimax");
}

function isMotionVideoEngine(engine: EngineInfo): boolean {
    if (String(engine.kind || "") !== "video") return false;
    if (isPrimaryVideoEngine(engine)) return false;
    return true;
}

function basenameOf(path: string): string {
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || path;
}

/** 合并引擎候选与调研库存；同名以库存补用途/类型/URL，引擎缺省时库存兜底。 */
export function mergeLoraCandidates(engineList: SlotLoraCandidate[], inventoryList: SlotLoraCandidate[]): SlotLoraCandidate[] {
    const byKey = new Map<string, SlotLoraCandidate>();
    const index = (value: string) => value.trim().toLowerCase();

    for (const c of inventoryList) {
        byKey.set(index(c.value), { ...c });
        byKey.set(index(basenameOf(c.value)), { ...c });
    }

    const out = new Map<string, SlotLoraCandidate>();

    for (const eng of engineList) {
        const key = index(eng.value);
        const base = index(basenameOf(eng.value));
        const inv = byKey.get(key) || byKey.get(base);
        const merged: SlotLoraCandidate = {
            ...eng,
            purposeZh: inv?.purposeZh,
            purposeGrade: inv?.purposeGrade,
            typeTag: inv?.typeTag,
            sourceUrl: inv?.sourceUrl,
            fromInventory: Boolean(inv),
            nsfw: eng.nsfw || inv?.nsfw,
        };
        out.set(key, merged);
    }

    for (const inv of inventoryList) {
        const key = index(inv.value);
        if (out.has(key)) continue;
        // also skip if engine already has same basename under another path
        const base = index(basenameOf(inv.value));
        let hit = false;
        for (const existing of out.values()) {
            if (index(basenameOf(existing.value)) === base) {
                hit = true;
                break;
            }
        }
        if (hit) continue;
        out.set(key, { ...inv });
    }

    return Array.from(out.values()).sort((a, b) => {
        const rank = (c?: string) => (c === "A" ? 3 : c === "B" ? 2 : c === "C" ? 1 : 0);
        const ca = rank(a.compatConfidence);
        const cb = rank(b.compatConfidence);
        if (ca !== cb) return cb - ca; // A/B 在前，仅 C 沉底（D1）
        const ga = a.purposeGrade === "P-A" ? 0 : 1;
        const gb = b.purposeGrade === "P-A" ? 0 : 1;
        if (ga !== gb) return ga - gb;
        return a.label.localeCompare(b.label, "zh");
    });
}

/** 从兼容图谱（按底模族）+ 现网引擎抽 LoRA 候选。 */
export async function fetchSlotLoraCandidates(
    slot: SlotLoraKey,
    opts?: { baseHint?: string | null; strictEngines?: boolean },
): Promise<SlotLoraCandidate[]> {
    const compat = listCompatCandidatesForSlot({ slot, baseHint: opts?.baseHint });
    const inventoryList: SlotLoraCandidate[] = compat.items.map((item) => ({
        value: item.loraId,
        label: item.label,
        nsfw: Boolean(item.nsfw),
        purposeZh: item.purposeZh,
        purposeGrade: item.purposeGrade,
        typeTag: item.typeTag,
        sourceUrl: item.sourceUrl,
        fromInventory: true,
        compatConfidence: item.confidence,
        compatStatus: item.status,
        heuristic: Boolean(item.heuristic),
        compatBadge: compatBadgeLabel(item.status, item.confidence),
        recommendedStrength: item.strength.default,
        strengthSource: item.strengthSource,
        triggers: item.triggers,
        conflicts: item.conflicts,
        substitutes: item.substitutes,
    }));

    let engineList: SlotLoraCandidate[] = [];
    try {
        const { data } = await toivHttp.get<{ engines?: EngineInfo[] }>("/models/engines", { timeout: 12_000 });
        const engines = Array.isArray(data?.engines) ? data.engines : [];
        if (slot === "image") {
            engineList = collectLoraOptions(engines, (e) => String(e.kind || "") === "image");
        } else if (slot === "video-primary") {
            engineList = collectLoraOptions(engines, (e) => String(e.kind || "") === "video" && isPrimaryVideoEngine(e));
        } else {
            engineList = collectLoraOptions(engines, (e) => String(e.kind || "") === "video" && isMotionVideoEngine(e));
        }
    } catch (error) {
        if (opts?.strictEngines) throw error;
        engineList = [];
    }

    // 引擎候选也要过 D2 / 族过滤：只保留 compat 白名单 basename（或无图谱时降级全量）
    const allow = new Set(inventoryList.map((c) => c.value.trim().toLowerCase()));
    const allowBase = new Set(inventoryList.map((c) => basenameOf(c.value).toLowerCase()));
    const filteredEngines =
        allow.size === 0 && compat.degraded
            ? engineList
            : engineList.filter((e) => {
                  const v = e.value.trim().toLowerCase();
                  const b = basenameOf(e.value).toLowerCase();
                  if (allow.has(v) || allowBase.has(b)) return true;
                  // 引擎有但图谱无：不擅自加入（避免跨族）
                  return false;
              });

    const merged = mergeLoraCandidates(filteredEngines, inventoryList);
    // re-attach compat fields after merge (inventory side already has them; engine-only shouldn't remain)
    const byBase = new Map(inventoryList.map((c) => [basenameOf(c.value).toLowerCase(), c]));
    const attached = merged.map((m) => {
        const inv = byBase.get(basenameOf(m.value).toLowerCase());
        if (!inv) return m;
        return {
            ...m,
            compatConfidence: inv.compatConfidence ?? m.compatConfidence,
            compatStatus: inv.compatStatus ?? m.compatStatus,
            heuristic: inv.heuristic ?? m.heuristic,
            compatBadge: inv.compatBadge ?? m.compatBadge,
            recommendedStrength: inv.recommendedStrength ?? m.recommendedStrength,
            strengthSource: inv.strengthSource ?? m.strengthSource,
            triggers: inv.triggers ?? m.triggers,
            nsfw: Boolean(m.nsfw || inv.nsfw),
        };
    });
    // 普通模式隐藏 NSFW LoRA（与 checkpoint 同一红线）
    return filterNsfwListableAssets(attached, (c) => ({ nsfw: c.nsfw, value: c.value, label: c.label }));
}

export function slotLoraInventoryFooter(slot: SlotLoraKey, opts?: { baseHint?: string | null; shown?: number }): string {
    const compat = listCompatCandidatesForSlot({ slot, baseHint: opts?.baseHint });
    const fam = compat.baseFamily;
    const n = opts?.shown ?? compat.items.length;
    const ab = compat.items.filter((i) => i.confidence === "A" || i.confidence === "B").length;
    const cOnly = compat.items.filter((i) => i.confidence === "C").length;
    const famText = fam ? familyLabel(fam) : "族未解析·槽位降级";
    const degrade = compat.degraded ? " · 底模族未确认，仅按槽位+灰显启发式" : "";
    return `兼容 ${n} 项（${famText} · A/B ${ab} · 仅推断 ${cOnly}；来源 A+B · 用途 P-A/P-B；已隔离不展示）${degrade}`;
}


/** 市场 appId → 设置槽（无法映射则 null）。 */
export function marketAppToLoraSlot(appId: string | null | undefined): SlotLoraKey | null {
    const id = String(appId || "").trim().toLowerCase();
    if (!id) return null;
    if (id.startsWith("h3-")) return "video-primary";
    if (id.startsWith("ltx") || id.startsWith("wan-") || id.startsWith("longcat-")) return "video-motion";
    if (id.startsWith("qwen") || id.includes("image") || id.startsWith("flux")) return "image";
    return null;
}

export type PinnedLoraGenerateResult = {
    loras: SlotLoraPick[];
    ok: boolean;
    errors: string[];
    warnings: string[];
    source: "settings" | "form" | "none";
    /** schema 无 loras 时为 true：只校验/提示，勿假装已写入后端 */
    schemaMissingLoras: boolean;
    slot: SlotLoraKey | null;
    family: string | null;
};

/**
 * 生成前：读设置钉选 / 表单钉选 → 兼容断言 → 可合并列表。
 * form 非空 → 以表单为准；form 为 []/null 且设置有钉选 → 注入设置钉选；
 * 不兼容 → ok=false（禁止静默提交）。
 */
export function resolvePinnedLorasForGenerate(opts: {
    appId?: string | null;
    slot?: SlotLoraKey | null;
    baseHint?: string | null;
    formLoras?: unknown;
    hasLorasParam?: boolean;
}): PinnedLoraGenerateResult {
    const slot = opts.slot ?? marketAppToLoraSlot(opts.appId);
    const family = resolveFamilyHint(opts.baseHint, slot || undefined);
    const schemaMissingLoras = opts.hasLorasParam === false;

    const formRaw = opts.formLoras;
    let source: "settings" | "form" | "none" = "none";
    let picks: SlotLoraPick[] = [];

    if (Array.isArray(formRaw) && formRaw.length > 0) {
        picks = normalizePicks(formRaw);
        source = "form";
    } else if (slot) {
        const fromSettings = readSlotLoras(slot);
        if (fromSettings.length) {
            picks = fromSettings;
            source = "settings";
        }
    }

    if (!picks.length) {
        return {
            loras: [],
            ok: true,
            errors: [],
            warnings: [],
            source: "none",
            schemaMissingLoras,
            slot,
            family,
        };
    }

    picks = picks.map((p) => {
        const row = getLoraCompatRow(p.name);
        const edge = family ? row?.families.find((f) => f.family === family) : undefined;
        const nextStrength =
            p.strength !== 0.6
                ? p.strength
                : (edge?.strength?.default ?? row?.strengthDefault ?? p.strength);
        const triggers = p.triggers?.length
            ? p.triggers
            : row?.triggers.map((t) => t.text) || undefined;
        return {
            ...p,
            strength: clampStrength(nextStrength, 0.6),
            triggers: triggers?.length ? triggers : undefined,
        };
    });

    const checked = assertLorasCompatible({
        loraIds: picks.map((x) => x.name),
        baseHint: opts.baseHint,
        family: family || undefined,
        slot: slot || undefined,
    });

    return {
        loras: picks,
        ok: checked.ok,
        errors: checked.errors,
        warnings: checked.warnings,
        source,
        schemaMissingLoras,
        slot,
        family,
    };
}

export { resolveFamilyHint, familyLabel };

/** 卡片上的短冲突提示（文件名截断；角色名原样）。 */
export function formatLoraConflictHint(conflicts?: string[]): string | null {
    if (!conflicts?.length) return null;
    const shown = conflicts.slice(0, 3).map((c) => {
        const base = c.includes("/") ? c.split("/").pop()! : c;
        return base.length > 28 ? `${base.slice(0, 26)}…` : base;
    });
    const more = conflicts.length > 3 ? ` 等${conflicts.length}项` : "";
    return `互斥：${shown.join(" · ")}${more}`;
}
