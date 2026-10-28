/**
 * 底模 ↔ LoRA 兼容图谱（与 lora-inventory 并列，basename join）。
 * 数据：scripts/ops/build-model-compat-graph.py → generated/model-compat-graph.json
 * 拍板：D1 仅 C 灰显可强制 · D2 H3 严格分族 · D3 JSON · D4 并列 join
 */
import graphFile from "@/generated/model-compat-graph.json";
import {
    LOCAL_H3_FL2VA_BASENAME,
    LOCAL_H3_REF2VA_BASENAME,
    LOCAL_IMAGE_CHECKPOINT_BASENAME,
} from "@/lib/local-model-defaults";
import { listLoraInventory, type LoraInventoryItem, type LoraInventorySlot } from "@/lib/lora-inventory";

export type CompatConfidence = "A" | "B" | "C" | "D";
export type CompatStatus = "compatible" | "heuristic" | "incompatible" | "unknown";
export type CompatSlot = LoraInventorySlot;

type GraphNode = {
    id: string;
    type: string;
    label?: string;
    basename?: string;
    text?: string;
    url?: string;
};

type GraphEdge = {
    type: string;
    from: string;
    to: string;
    confidence?: string;
    evidence?: string;
    notes?: string;
    strength_range?: { default?: number; min?: number; max?: number; source?: string };
    mode?: string;
    scope?: string;
    grade?: string;
};

type GraphFile = {
    schemaVersion?: number;
    generatedAt?: string;
    phase?: string;
    phaseNotes?: string;
    nodes?: GraphNode[];
    edges?: GraphEdge[];
    stats?: Record<string, number>;
};

const FILE = graphFile as GraphFile;
const NODES = Array.isArray(FILE.nodes) ? FILE.nodes : [];
const EDGES = Array.isArray(FILE.edges) ? FILE.edges : [];

const CONF_RANK: Record<string, number> = { A: 3, B: 2, C: 1, D: 0 };

const FAMILY_LABEL: Record<string, string> = {
    "qwen-image": "Qwen-Image",
    "flux.1-d": "Flux.1 D",
    "flux.2-klein": "Flux.2 Klein",
    sd15: "SD 1.5",
    sdxl: "SDXL",
    illustrious: "Illustrious",
    noobai: "NoobAI",
    pony: "Pony",
    "wan2.2-i2v-a14b": "Wan 2.2 I2V",
    "wan2.2-t2v-a14b": "Wan 2.2 T2V",
    "wan2.2-ti2v": "Wan 2.2 TI2V",
    "ltx-2.3": "LTX 2.3",
    "ltx-legacy": "LTX legacy",
    "minimax-h3": "MiniMax H3",
    "hunyuan-video": "Hunyuan Video",
    "z-image-turbo": "ZImageTurbo",
    "krea-2": "Krea 2",
};

const SEED_BASE_FAMILY: Record<string, string> = {
    [LOCAL_IMAGE_CHECKPOINT_BASENAME.toLowerCase()]: "qwen-image",
    [LOCAL_H3_FL2VA_BASENAME.toLowerCase()]: "minimax-h3",
    [LOCAL_H3_REF2VA_BASENAME.toLowerCase()]: "minimax-h3",
};

type CompatEdge = {
    family: string;
    confidence: CompatConfidence;
    evidence?: string;
    notes?: string;
    strength?: { default: number; min?: number; max?: number };
};

type LoraCompatIndex = {
    families: CompatEdge[];
    slots: Array<{ slot: string; confidence: CompatConfidence }>;
    triggers: Array<{ text: string; mode?: string }>;
    /** purpose 角色互斥 + 文件级互斥 basename */
    conflicts: string[];
    /** 同 engines+role 可替换 basename */
    substitutes: string[];
    strengthDefault?: number;
    strengthSource?: string;
};

function stripPrefix(id: string, prefix: string): string {
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function asConf(c?: string): CompatConfidence {
    if (c === "A" || c === "B" || c === "C" || c === "D") return c;
    return "D";
}

function basenameOf(path: string): string {
    const parts = String(path || "")
        .replace(/\\/g, "/")
        .split("/");
    return parts[parts.length - 1] || path;
}

function buildIndex(): {
    byLora: Map<string, LoraCompatIndex>;
    baseToFamily: Map<string, string>;
} {
    const byLora = new Map<string, LoraCompatIndex>();
    const baseToFamily = new Map<string, string>();

    const ensure = (loraId: string): LoraCompatIndex => {
        let row = byLora.get(loraId);
        if (!row) {
            row = { families: [], slots: [], triggers: [], conflicts: [], substitutes: [] };
            byLora.set(loraId, row);
        }
        return row;
    };

    for (const e of EDGES) {
        if (e.type === "instance_of" && e.from.startsWith("base:") && e.to.startsWith("family:")) {
            baseToFamily.set(stripPrefix(e.from, "base:").toLowerCase(), stripPrefix(e.to, "family:"));
        }
    }

    for (const [k, v] of Object.entries(SEED_BASE_FAMILY)) {
        if (!baseToFamily.has(k)) baseToFamily.set(k, v);
    }

    const triggerText = new Map<string, string>();
    for (const n of NODES) {
        if (n.type === "TriggerPhrase" && n.text) triggerText.set(n.id, n.text);
    }

    for (const e of EDGES) {
        if (!e.from.startsWith("lora:")) continue;
        const loraId = stripPrefix(e.from, "lora:");
        const row = ensure(loraId);

        if (e.type === "compatible_with" && e.to.startsWith("family:")) {
            const family = stripPrefix(e.to, "family:");
            const confidence = asConf(e.confidence);
            const existing = row.families.find((f) => f.family === family);
            const next: CompatEdge = {
                family,
                confidence,
                evidence: e.evidence,
                notes: e.notes,
                strength: e.strength_range
                    ? {
                          default: Number(e.strength_range.default ?? 0.6),
                          min: e.strength_range.min,
                          max: e.strength_range.max,
                      }
                    : undefined,
            };
            if (!existing) {
                row.families.push(next);
            } else if (CONF_RANK[confidence] > CONF_RANK[existing.confidence]) {
                Object.assign(existing, next);
            }
        } else if (e.type === "used_in_slot" && e.to.startsWith("slot:")) {
            const slot = stripPrefix(e.to, "slot:");
            const confidence = asConf(e.confidence);
            const existing = row.slots.find((s) => s.slot === slot);
            if (!existing) row.slots.push({ slot, confidence });
            else if (CONF_RANK[confidence] > CONF_RANK[existing.confidence]) existing.confidence = confidence;
        } else if (e.type === "requires_trigger") {
            const text = triggerText.get(e.to) || stripPrefix(e.to, "trigger:");
            if (text && !row.triggers.some((t) => t.text === text)) {
                row.triggers.push({ text, mode: e.mode });
            }
        } else if (e.type === "conflicts_with") {
            let c: string;
            if (e.to.startsWith("purpose:")) c = stripPrefix(e.to, "purpose:");
            else if (e.to.startsWith("lora:")) c = stripPrefix(e.to, "lora:");
            else c = e.to;
            if (c && !row.conflicts.includes(c)) row.conflicts.push(c);
        } else if (e.type === "substitutes") {
            const s = e.to.startsWith("lora:") ? stripPrefix(e.to, "lora:") : e.to;
            if (s && !row.substitutes.includes(s)) row.substitutes.push(s);
        } else if (e.type === "recommended_strength" && e.strength_range?.default != null) {
            row.strengthDefault = Number(e.strength_range.default);
            const src = e.strength_range.source;
            if (src) row.strengthSource = String(src);
        }
    }

    return { byLora, baseToFamily };
}

const INDEX = buildIndex();

export function modelCompatStats() {
    return {
        schemaVersion: FILE.schemaVersion,
        generatedAt: FILE.generatedAt,
        phase: FILE.phase,
        phaseNotes: FILE.phaseNotes,
        nodeCount: NODES.length,
        edgeCount: EDGES.length,
        loraIndexed: INDEX.byLora.size,
        stats: FILE.stats,
    };
}

/** Resolve BaseFamily slug from a checkpoint / diffusion basename. */
export function familyOfBase(basename: string): string | null {
    const key = basenameOf(basename).toLowerCase();
    if (!key) return null;
    const hit = INDEX.baseToFamily.get(key);
    if (hit) return hit;
    return inferFamilyFromText(key);
}

/**
 * Best-effort family from model ref / display label / basename.
 * Returns null when unknown (UI should degrade to slot + gray heuristic).
 */
export function resolveFamilyHint(hint: string | undefined | null, slot?: CompatSlot): string | null {
    const raw = String(hint || "").trim();
    if (raw) {
        const fromBase = familyOfBase(raw);
        if (fromBase) return fromBase;
        const inferred = inferFamilyFromText(raw);
        if (inferred) return inferred;
    }
    // Slot product defaults (D2: video-primary → H3)
    if (slot === "video-primary") return "minimax-h3";
    if (slot === "image" && (!raw || /local-checkpoint|toiv-image|本地.*出图|出图/i.test(raw))) {
        return "qwen-image";
    }
    return null;
}

function inferFamilyFromText(text: string): string | null {
    const s = text.toLowerCase();
    if (!s) return null;
    if (/minimax_h3|minimax-h3|mini.?max.?h3/.test(s)) return "minimax-h3";
    if (/(?:^|[^a-z])h3(?:[^a-z]|$)/.test(s) || /toiv-h3|本地·?h3|本地 h3/.test(s)) return "minimax-h3";
    if (/qwen/.test(s)) return "qwen-image";
    if (/flux\.?2|klein/.test(s)) return "flux.2-klein";
    if (/flux/.test(s)) return "flux.1-d";
    if (/wan.*t2v|t2v.*wan/.test(s)) return "wan2.2-t2v-a14b";
    if (/wan.*ti2v|ti2v/.test(s)) return "wan2.2-ti2v";
    if (/\bwan\b|local-wan|toiv-video-wan/.test(s)) return "wan2.2-i2v-a14b";
    if (/ltx/.test(s)) return "ltx-2.3";
    if (/pony/.test(s)) return "pony";
    if (/sdxl/.test(s)) return "sdxl";
    if (/illustrious/.test(s)) return "illustrious";
    if (/hunyuan/.test(s)) return "hunyuan-video";
    if (/z[\s_-]?image|zimageturbo/.test(s)) return "z-image-turbo";
    if (/longcat/.test(s)) return null;
    for (const [base, fam] of Object.entries(SEED_BASE_FAMILY)) {
        if (s.includes(base.replace(/\.safetensors$/i, "").toLowerCase())) return fam;
    }
    return null;
}

export function familyLabel(slug: string | null | undefined): string {
    if (!slug) return "未知族";
    return FAMILY_LABEL[slug] || slug;
}

export function compatStatus(loraId: string, family: string | null | undefined): CompatStatus {
    if (!family) return "unknown";
    const row = INDEX.byLora.get(basenameOf(loraId)) || INDEX.byLora.get(loraId);
    if (!row || !row.families.length) return "unknown";
    const hit = row.families.find((f) => f.family === family);
    if (hit) {
        if (hit.confidence === "A" || hit.confidence === "B") return "compatible";
        if (hit.confidence === "C") return "heuristic";
        return "unknown";
    }
    return "incompatible";
}

export function isH3ExclusiveLora(loraId: string, inventoryItem?: LoraInventoryItem | null): boolean {
    const id = basenameOf(loraId);
    const row = INDEX.byLora.get(id);
    if (inventoryItem) {
        const pr = (inventoryItem.pathRoot || "").toLowerCase();
        const c = (inventoryItem.cluster || "").toLowerCase();
        if (pr.includes("h3/loras") || c.startsWith("catalog:h3") || c === "h3_family") return true;
    }
    if (!row) return false;
    const fams = row.families.map((f) => f.family);
    if (fams.length && fams.every((f) => f === "minimax-h3")) return true;
    return false;
}

export type CompatQueryItem = {
    loraId: string;
    label: string;
    purposeZh: string;
    purposeGrade: string;
    confidence: CompatConfidence;
    status: CompatStatus;
    strength: { default: number; min?: number; max?: number };
    /** catalog | card | model_sources | heuristic */
    strengthSource?: string;
    triggers: string[];
    triggerMode?: string;
    conflicts: string[];
    substitutes: string[];
    sourceUrl?: string;
    typeTag?: string;
    nsfw?: boolean;
    notes?: string;
    heuristic?: boolean;
};

export type CompatQueryResult = {
    baseFamily: string | null;
    familyResolved: boolean;
    degraded: boolean;
    items: CompatQueryItem[];
};

function confidenceAtLeast(c: CompatConfidence, min: CompatConfidence): boolean {
    return CONF_RANK[c] >= CONF_RANK[min];
}

/** Agent / UI query: join graph × inventory. */
export function queryCompat(opts: {
    baseId?: string;
    family?: string;
    slot?: CompatSlot;
    minConfidence?: CompatConfidence;
    includeTriggers?: boolean;
    excludeNsfw?: boolean;
    allowDegraded?: boolean;
}): CompatQueryResult {
    const minConf = opts.minConfidence ?? "B";
    const family =
        opts.family ||
        (opts.baseId ? familyOfBase(opts.baseId) : null) ||
        resolveFamilyHint(opts.baseId, opts.slot);

    const inventory = listLoraInventory(opts.slot ? { slot: opts.slot } : undefined);
    const allInv = listLoraInventory();
    const degraded = !family;
    const items: CompatQueryItem[] = [];
    const pool = degraded ? (opts.slot ? inventory : allInv) : allInv;

    for (const inv of pool) {
        // D2 hard rules
        if (opts.slot && opts.slot !== "video-primary" && isH3ExclusiveLora(inv.id, inv)) {
            continue;
        }
        if (opts.slot === "video-primary") {
            const st = compatStatus(inv.id, "minimax-h3");
            if (st === "incompatible") continue;
            if (st === "unknown" && !isH3ExclusiveLora(inv.id, inv)) continue;
        }

        if (opts.excludeNsfw && inv.nsfw) continue;

        const row = INDEX.byLora.get(inv.id);
        let status: CompatStatus;
        let confidence: CompatConfidence = "D";
        let notes: string | undefined;
        let strength: CompatQueryItem["strength"] = { default: row?.strengthDefault ?? 0.6 };

        if (degraded) {
            if (!(opts.allowDegraded ?? true)) continue;
            const slotOk =
                !opts.slot ||
                row?.slots.some((s) => s.slot === opts.slot) ||
                inv.slots.includes(opts.slot);
            if (!slotOk) continue;
            status = "heuristic";
            confidence = "C";
            notes = "底模族未解析，按槽位亲和降级（命名/路径推断）";
        } else {
            status = compatStatus(inv.id, family);
            if (status === "incompatible" || status === "unknown") continue;
            const edge = row?.families.find((f) => f.family === family);
            confidence = edge?.confidence ?? (status === "heuristic" ? "C" : "B");
            notes = edge?.notes;
            if (edge?.strength) {
                strength = { default: edge.strength.default, min: edge.strength.min, max: edge.strength.max };
            } else if (row?.strengthDefault != null) {
                strength = { default: row.strengthDefault };
            }

            if (opts.slot && row?.slots.length) {
                const slotHit = row.slots.some((s) => s.slot === opts.slot);
                if (!slotHit && confidence === "C") continue;
            }

            if (!confidenceAtLeast(confidence, minConf)) continue;
        }

        items.push({
            loraId: inv.id,
            label: inv.label,
            purposeZh: inv.purposeZh,
            purposeGrade: inv.purposeGrade,
            confidence,
            status,
            strength,
            strengthSource: row?.strengthSource,
            triggers: opts.includeTriggers === false ? [] : row?.triggers.map((t) => t.text) || [],
            triggerMode: row?.triggers[0]?.mode,
            conflicts: row?.conflicts || [],
            substitutes: row?.substitutes || [],
            sourceUrl: inv.sourceUrl || undefined,
            typeTag: inv.typeTag,
            nsfw: inv.nsfw,
            notes,
            heuristic: status === "heuristic" || confidence === "C",
        });
    }

    items.sort((a, b) => {
        const ca = CONF_RANK[a.confidence] ?? 0;
        const cb = CONF_RANK[b.confidence] ?? 0;
        if (ca !== cb) return cb - ca;
        const ga = a.purposeGrade === "P-A" ? 0 : 1;
        const gb = b.purposeGrade === "P-A" ? 0 : 1;
        if (ga !== gb) return ga - gb;
        return a.label.localeCompare(b.label, "zh");
    });

    return {
        baseFamily: family,
        familyResolved: Boolean(family) && !degraded,
        degraded,
        items,
    };
}

/** Settings UI: candidates for a slot given current base hint. Always allows C (D1). */
export function listCompatCandidatesForSlot(opts: {
    slot: CompatSlot;
    baseHint?: string | null;
}): CompatQueryResult {
    const family = resolveFamilyHint(opts.baseHint, opts.slot);
    return queryCompat({
        family: family || undefined,
        slot: opts.slot,
        minConfidence: "C",
        includeTriggers: true,
        allowDegraded: true,
    });
}

export function compatBadgeLabel(status: CompatStatus, confidence: CompatConfidence): string {
    if (status === "heuristic" || confidence === "C") return "命名推断，未确认";
    if (confidence === "A") return "产品确认";
    if (confidence === "B") return "卡页声明";
    return "未知";
}

export function getLoraCompatRow(loraId: string) {
    return INDEX.byLora.get(basenameOf(loraId)) || null;
}

export function listKnownFamilies(): string[] {
    return Object.keys(FAMILY_LABEL);
}

export type CompatAssertResult = {
    ok: boolean;
    loraId: string;
    status: CompatStatus;
    confidence: CompatConfidence;
    family: string | null;
    message: string;
    strength?: { default: number; min?: number; max?: number };
    triggers: string[];
    heuristic: boolean;
};

/**
 * 钉选/提交前兼容断言。不兼容 → ok=false（禁止静默提交）。
 * 仅 C（启发式）→ ok=true 但 heuristic=true（调用方可警告）。
 */
export function assertLoraCompatible(opts: {
    loraId: string;
    baseHint?: string | null;
    family?: string | null;
    slot?: CompatSlot;
}): CompatAssertResult {
    const loraId = basenameOf(opts.loraId);
    const family =
        opts.family ||
        resolveFamilyHint(opts.baseHint, opts.slot) ||
        (opts.baseHint ? familyOfBase(opts.baseHint) : null);
    const row = INDEX.byLora.get(loraId);
    const status = compatStatus(loraId, family);
    const edge = family && row ? row.families.find((f) => f.family === family) : undefined;
    const confidence: CompatConfidence = edge?.confidence ?? (status === "heuristic" ? "C" : status === "compatible" ? "B" : "D");
    const strength =
        edge?.strength ||
        (row?.strengthDefault != null ? { default: row.strengthDefault } : undefined);
    const triggers = row?.triggers.map((t) => t.text) || [];

    if (!family) {
        return {
            ok: false,
            loraId,
            status: "unknown",
            confidence: "D",
            family: null,
            message: `无法解析底模族，拒绝静默挂载 ${loraId}`,
            strength,
            triggers,
            heuristic: true,
        };
    }
    if (status === "incompatible") {
        return {
            ok: false,
            loraId,
            status,
            confidence,
            family,
            message: `${loraId} 与底模族 ${familyLabel(family)} 不兼容，已阻断提交`,
            strength,
            triggers,
            heuristic: false,
        };
    }
    if (status === "unknown") {
        return {
            ok: false,
            loraId,
            status,
            confidence: "D",
            family,
            message: `${loraId} 在族 ${familyLabel(family)} 下无兼容边，已阻断提交`,
            strength,
            triggers,
            heuristic: true,
        };
    }
    const heuristic = status === "heuristic" || confidence === "C";
    return {
        ok: true,
        loraId,
        status,
        confidence,
        family,
        message: heuristic
            ? `${loraId} 仅为命名推断（未确认），允许强制但请知悉风险`
            : `${loraId} 兼容 ${familyLabel(family)}（${confidence}）`,
        strength,
        triggers,
        heuristic,
    };
}

/** 批量校验；任一不兼容则 ok=false。 */
export function assertLorasCompatible(opts: {
    loraIds: string[];
    baseHint?: string | null;
    family?: string | null;
    slot?: CompatSlot;
}): { ok: boolean; results: CompatAssertResult[]; errors: string[]; warnings: string[] } {
    const results = opts.loraIds.map((id) =>
        assertLoraCompatible({
            loraId: id,
            baseHint: opts.baseHint,
            family: opts.family,
            slot: opts.slot,
        }),
    );
    const errors = results.filter((r) => !r.ok).map((r) => r.message);
    const warnings = results.filter((r) => r.ok && r.heuristic).map((r) => r.message);
    return { ok: errors.length === 0, results, errors, warnings };
}

