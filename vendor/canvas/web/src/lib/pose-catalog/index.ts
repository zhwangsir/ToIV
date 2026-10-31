/** Pose gallery catalog (W5): JSON index only; thumbs/img served via /api/pose-gallery/*. */

import metaZh from "./meta-zh.json";
import poseZh from "./pose-zh.json";
import { POSE_GALLERY_IMG_PATH, POSE_GALLERY_THUMB_PATH } from "@/lib/media-library-routes";
import { isPoseSystemVisible, isR18Mode } from "@/redline";

export type PoseEntry = {
    id: string;
    体系: string;
    姿势编号: string;
    分类: string;
    姿势名称: string;
    角度: string;
    缩略图: string;
    原图: string;
    检索: string;
};

export type PoseGroup = {
    key: string;
    体系: string;
    姿势编号: string;
    分类: string;
    姿势名称: string;
    angles: readonly PoseEntry[];
    searchText: string;
};

export type PoseCatalogFilter = {
    system?: string | null;
    category?: string | null;
    query?: string | null;
    /** When omitted, uses live isR18Mode(). */
    adultOn?: boolean;
};

const ENTRIES: readonly PoseEntry[] = (poseZh as PoseEntry[]).map((row) => ({
    id: String(row.id ?? ""),
    体系: String(row.体系 ?? ""),
    姿势编号: String(row.姿势编号 ?? ""),
    分类: String(row.分类 ?? ""),
    姿势名称: String(row.姿势名称 ?? ""),
    角度: String(row.角度 ?? ""),
    缩略图: String(row.缩略图 ?? ""),
    原图: String(row.原图 ?? ""),
    检索: String(row.检索 ?? ""),
}));

const META_SYSTEMS: readonly string[] = Array.isArray((metaZh as { 体系分类?: unknown }).体系分类)
    ? ((metaZh as { 体系分类: string[] }).体系分类).map(String)
    : [];

export function listPoseSystems(): readonly string[] {
    if (META_SYSTEMS.length) return META_SYSTEMS;
    return [...new Set(ENTRIES.map((e) => e.体系).filter(Boolean))];
}

export function listPoseEntries(): readonly PoseEntry[] {
    return ENTRIES;
}

export function poseFileBasename(pathLike: string): string {
    const cleaned = String(pathLike || "").trim().replace(/\\/g, "/");
    const parts = cleaned.split("/");
    return parts[parts.length - 1] || cleaned;
}

/** `/api/pose-gallery/thumbs/{file}` — never `/static`. */
export function poseThumbUrl(entry: Pick<PoseEntry, "缩略图" | "id">): string {
    const file = poseFileBasename(entry.缩略图) || `${entry.id}.jpg`;
    return `${POSE_GALLERY_THUMB_PATH}/${file}`;
}

/** `/api/pose-gallery/img/{file}` — never `/static`. */
export function poseImgUrl(entry: Pick<PoseEntry, "原图" | "id">): string {
    const file = poseFileBasename(entry.原图) || `${entry.id}.png`;
    return `${POSE_GALLERY_IMG_PATH}/${file}`;
}

export function poseGroupKey(entry: Pick<PoseEntry, "体系" | "姿势编号">): string {
    return `${entry.体系}::${entry.姿势编号}`;
}

const ANGLE_ORDER = ["正面", "斜侧", "侧面", "俯视", "仰视"] as const;

function angleRank(angle: string): number {
    const idx = (ANGLE_ORDER as readonly string[]).indexOf(angle);
    return idx >= 0 ? idx : ANGLE_ORDER.length + 1;
}

export function buildPoseGroups(entries: readonly PoseEntry[] = ENTRIES): PoseGroup[] {
    const map = new Map<string, PoseEntry[]>();
    for (const entry of entries) {
        if (!entry.id || !entry.体系 || !entry.姿势编号) continue;
        const key = poseGroupKey(entry);
        const bucket = map.get(key);
        if (bucket) bucket.push(entry);
        else map.set(key, [entry]);
    }
    const groups: PoseGroup[] = [];
    for (const [key, angles] of map) {
        const sorted = [...angles].sort((a, b) => angleRank(a.角度) - angleRank(b.角度) || a.id.localeCompare(b.id));
        const head = sorted[0]!;
        groups.push({
            key,
            体系: head.体系,
            姿势编号: head.姿势编号,
            分类: head.分类,
            姿势名称: head.姿势名称,
            angles: sorted,
            searchText: sorted.map((a) => a.检索 || `${a.体系}${a.分类}${a.姿势名称}${a.角度}${a.id}`).join(" "),
        });
    }
    return groups.sort(
        (a, b) =>
            a.体系.localeCompare(b.体系, "zh") ||
            a.姿势编号.localeCompare(b.姿势编号) ||
            a.姿势名称.localeCompare(b.姿势名称, "zh"),
    );
}

const ALL_GROUPS = buildPoseGroups(ENTRIES);

export function listPoseGroups(): readonly PoseGroup[] {
    return ALL_GROUPS;
}

export function listPoseCategories(system?: string | null): string[] {
    const set = new Set<string>();
    for (const g of ALL_GROUPS) {
        if (system && g.体系 !== system) continue;
        if (g.分类) set.add(g.分类);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh"));
}

/** Redline-aware filter: adult-only systems hidden unless content_mode=adult (underage hard-closed via isR18Mode). */
export function filterPoseGroups(filter: PoseCatalogFilter = {}): PoseGroup[] {
    const adultOn = typeof filter.adultOn === "boolean" ? filter.adultOn : isR18Mode();
    const system = filter.system?.trim() || "";
    const category = filter.category?.trim() || "";
    const query = filter.query?.trim().toLowerCase() || "";
    return ALL_GROUPS.filter((group) => {
        if (!isPoseSystemVisible(group.体系, adultOn)) return false;
        if (system && group.体系 !== system) return false;
        if (category && group.分类 !== category) return false;
        if (query) {
            const hay = `${group.searchText} ${group.姿势编号} ${group.姿势名称} ${group.分类}`.toLowerCase();
            if (!hay.includes(query)) return false;
        }
        return true;
    });
}

export function visiblePoseSystems(adultOn = isR18Mode()): string[] {
    return listPoseSystems().filter((system) => isPoseSystemVisible(system, adultOn));
}

export function pickDefaultAngle(group: PoseGroup, preferred?: string | null): PoseEntry {
    if (preferred) {
        const hit = group.angles.find((a) => a.角度 === preferred);
        if (hit) return hit;
    }
    const front = group.angles.find((a) => a.角度 === "正面");
    return front ?? group.angles[0]!;
}
