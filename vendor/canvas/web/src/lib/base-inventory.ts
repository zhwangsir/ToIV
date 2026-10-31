/**
 * NAS 基座库存（checkpoints / diffusion_models / H3 非 LoRA 权重）。
 * 与 lora-inventory / model-compat-graph 并列；join key = basename。
 * 由 scripts/ops/gen-base-inventory-json.py 生成。
 */
import inventory from "@/generated/base-inventory.json";
import { familyLabel, familyOfBase } from "@/lib/model-compat";
import {
    LOCAL_H3_CHANNEL_NAME,
    LOCAL_IMAGE_CHANNEL_ID,
    LOCAL_IMAGE_CHANNEL_NAME,
    LOCAL_VIDEO_CHANNEL_ID,
    LOCAL_VIDEO_CHANNEL_NAME,
} from "@/lib/local-model-defaults";
import { LOCAL_H3_CHANNEL_ID } from "@/services/toiv/local-capability-surface";
import { classifyAssetContent, filterNsfwListableAssets, isNsfwAssetListable, isNsfwAssetSelectable } from "@/redline";

export type BaseInventorySlot = "image" | "video-primary" | "video-motion";

export type BaseInventoryItem = {
    id: string;
    basename: string;
    label: string;
    relPath: string;
    pathRoot: string;
    family: string | null;
    familyLabel: string | null;
    familyResolved: boolean;
    slots: BaseInventorySlot[];
    bytes?: number | null;
    purposeZh?: string | null;
    /** 显式成人标记（元数据优先；缺省则 redline 用文件名兜底） */
    is_nsfw?: boolean | null;
    nsfw?: boolean | null;
    content_rating?: string | null;
};

type InventoryFile = {
    generatedAt: string;
    source: { kind: string; live?: boolean; [k: string]: unknown };
    note?: string;
    count: number;
    familyResolved: number;
    familyUnknown: number;
    items: BaseInventoryItem[];
};

const FILE = inventory as InventoryFile;

function enrichNsfwMeta(item: BaseInventoryItem): BaseInventoryItem {
    if (item.is_nsfw != null || item.nsfw != null || item.content_rating != null) return item;
    // 无显式元数据时不在此写 is_nsfw=true（交给 redline 文件名兜底）；仅标 unknown 不在 JSON 内伪造
    return item;
}


export function baseInventoryMeta() {
    return {
        generatedAt: FILE.generatedAt,
        source: FILE.source,
        note: FILE.note || "",
        count: FILE.count,
        familyResolved: FILE.familyResolved,
        familyUnknown: FILE.familyUnknown,
        live: Boolean(FILE.source?.live),
    };
}

export function listBaseInventory(opts?: {
    slot?: BaseInventorySlot;
    family?: string | null;
    /** true=含 NSFW；false=强制普通；默认跟随成人模式 */
    includeNsfw?: boolean;
}): BaseInventoryItem[] {
    let items = (FILE.items || []).map(enrichNsfwMeta);
    if (opts?.slot) {
        items = items.filter((i) => (i.slots || []).includes(opts.slot!));
    }
    if (opts?.family) {
        const fam = opts.family;
        items = items.filter((i) => i.family === fam);
    }
    if (opts?.includeNsfw === true) return items;
    // 默认：已知 NSFW 仍列表可见（灰化锁定）；未知元数据普通藏
    const pick = (i: BaseInventoryItem) => ({
        is_nsfw: i.is_nsfw,
        nsfw: i.nsfw,
        content_rating: i.content_rating,
        basename: i.basename,
        label: i.label,
        relPath: i.relPath,
        purposeZh: i.purposeZh,
    });
    if (opts?.includeNsfw === false) {
        return items.filter((i) => classifyAssetContent(pick(i)) !== "nsfw" && classifyAssetContent(pick(i)) !== "unknown");
    }
    return filterNsfwListableAssets(items, pick);
}

/** Channel::basename ref for settings slot dropdown. */
export function baseInventoryModelRef(item: BaseInventoryItem): string {
    if ((item.slots || []).includes("video-primary") || item.family === "minimax-h3") {
        return `${LOCAL_H3_CHANNEL_ID}::${item.basename}`;
    }
    if ((item.slots || []).includes("video-motion") && !(item.slots || []).includes("image")) {
        return `${LOCAL_VIDEO_CHANNEL_ID}::${item.basename}`;
    }
    return `${LOCAL_IMAGE_CHANNEL_ID}::${item.basename}`;
}

export function baseInventoryOptionLabel(item: BaseInventoryItem): string {
    const fam =
        item.familyResolved && item.family
            ? item.familyLabel || familyLabel(item.family)
            : "族未解析";
    const liveTag = "";
    const pick = {
        is_nsfw: item.is_nsfw,
        nsfw: item.nsfw,
        content_rating: item.content_rating,
        basename: item.basename,
        label: item.label,
        relPath: item.relPath,
    };
    const locked = classifyAssetContent(pick) === "nsfw" && !isNsfwAssetSelectable(pick);
    return `${item.label} · ${fam}${liveTag}${locked ? " · NSFW 🔒" : ""}`;
}

export function baseInventoryChannelName(item: BaseInventoryItem): string {
    if ((item.slots || []).includes("video-primary") || item.family === "minimax-h3") {
        return LOCAL_H3_CHANNEL_NAME;
    }
    if ((item.slots || []).includes("video-motion") && !(item.slots || []).includes("image")) {
        return LOCAL_VIDEO_CHANNEL_NAME;
    }
    return LOCAL_IMAGE_CHANNEL_NAME;
}

/**
 * Merge channel models with NAS base inventory for a slot.
 * Existing channel options win on value collision; inventory fills the rest.
 */
export function mergeSlotOptionsWithBaseInventory(
    existing: Array<{ value: string; label: string; title?: string }>,
    slot: BaseInventorySlot,
): Array<{ value: string; label: string; title?: string }> {
    const visibleExisting = existing.filter((o) => isNsfwAssetListable(o.value) || isNsfwAssetListable(o.label) || isNsfwAssetListable(o.title));
    const seen = new Set(visibleExisting.map((o) => o.value.toLowerCase()));
    const basenameSeen = new Set(
        visibleExisting.map((o) => {
            const v = o.value.includes("::") ? o.value.split("::").pop() || o.value : o.value;
            return v.toLowerCase();
        }),
    );
    const extras = listBaseInventory({ slot })
        .filter((item) => {
            const ref = baseInventoryModelRef(item);
            if (seen.has(ref.toLowerCase())) return false;
            if (basenameSeen.has(item.basename.toLowerCase())) return false;
            return true;
        })
        .map((item) => {
            const ref = baseInventoryModelRef(item);
            const ch = baseInventoryChannelName(item);
            return {
                value: ref,
                label: `${baseInventoryOptionLabel(item)} · ${ch}`,
                title: item.relPath || item.basename,
            };
        });
    return [...visibleExisting, ...extras];
}

/** Resolve family for a model ref / basename via inventory then graph heuristics. */
export function familyOfBaseInventory(hint: string | null | undefined): string | null {
    const raw = String(hint || "").trim();
    if (!raw) return null;
    const bn = (raw.includes("::") ? raw.split("::").pop() : raw) || raw;
    const hit = FILE.items.find((i) => i.basename.toLowerCase() === bn.toLowerCase());
    if (hit?.family) return hit.family;
    return familyOfBase(bn);
}

export function baseInventoryFooter(slot?: BaseInventorySlot): string {
    const meta = baseInventoryMeta();
    const n = slot ? listBaseInventory({ slot }).length : meta.count;
    const src = meta.live ? "实时 NAS" : "非实时 NAS 种子";
    return `基座库存 ${n} · 族可解析 ${meta.familyResolved}/${meta.count} · ${src}`;
}
