/**
 * 设置页 LoRA 可用库存（调研结果收口）。
 * 规则：available + 来源 A/B + 用途 P-A/P-B；隔离/C/D/blocked 默认不出现。
 * 数据由 scripts/ops/gen-lora-inventory-json.py 从 CSV 生成。
 */
import inventory from "@/generated/lora-inventory.json";

export type LoraInventorySlot = "image" | "video-primary" | "video-motion";

export type LoraInventoryGrade = "P-A" | "P-B";

export type LoraInventoryItem = {
    id: string;
    label: string;
    purposeZh: string;
    purposeGrade: LoraInventoryGrade | string;
    sourceGrade: string;
    typeTag: string;
    cluster: string;
    pathRoot: string;
    sourceUrl: string;
    slots: string[];
    nsfw: boolean;
};

type InventoryFile = {
    generatedAt?: string;
    count?: number;
    items?: LoraInventoryItem[];
};

const FILE = inventory as InventoryFile;
const ALL: LoraInventoryItem[] = Array.isArray(FILE.items) ? FILE.items : [];

export function listLoraInventory(opts?: {
    slot?: LoraInventorySlot;
    /** 默认只返回 P-A / P-B（生成脚本已过滤；此处再保险） */
    grades?: Array<LoraInventoryGrade | string>;
}): LoraInventoryItem[] {
    const grades = opts?.grades ?? ["P-A", "P-B"];
    const gradeSet = new Set(grades);
    return ALL.filter((item) => {
        if (!gradeSet.has(item.purposeGrade)) return false;
        if (item.sourceGrade !== "A" && item.sourceGrade !== "B") return false;
        if (opts?.slot && !item.slots.includes(opts.slot)) return false;
        return true;
    });
}

export function loraInventoryStats(): { total: number; generatedAt?: string; bySlot: Record<LoraInventorySlot, number> } {
    return {
        total: ALL.length,
        generatedAt: FILE.generatedAt,
        bySlot: {
            image: listLoraInventory({ slot: "image" }).length,
            "video-primary": listLoraInventory({ slot: "video-primary" }).length,
            "video-motion": listLoraInventory({ slot: "video-motion" }).length,
        },
    };
}

/** 把库存项映射成挂件候选（供设置弹层）。 */
export function inventoryToCandidates(slot: LoraInventorySlot) {
    return listLoraInventory({ slot }).map((item) => ({
        value: item.id,
        label: item.label,
        nsfw: Boolean(item.nsfw),
        purposeZh: item.purposeZh,
        purposeGrade: item.purposeGrade,
        typeTag: item.typeTag,
        sourceUrl: item.sourceUrl || undefined,
        fromInventory: true as const,
    }));
}
