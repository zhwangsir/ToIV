/**
 * Adapted from alibaba/lumenx@f2a02e23171447c939e7d8e1386b24d17049bbf1
 * frontend/src/lib/characterImage.ts (MIT)
 * Copyright (c) 2026 Alibaba — see ../NOTICE
 *
 * ToIV-shaped helpers: resolve cover / three-view / headshot URLs from node metadata.
 */
import type { CanvasNodeData } from "@/types/canvas";

export type CharacterViewSlot = "full_body" | "three_view" | "headshot";

export type CharacterViewUrls = {
    fullBody?: string;
    threeView?: string;
    headshot?: string;
};

/** Prefer explicit cover; fall back to definition-stored URLs when present. */
export function characterViewUrlsFromNode(node: CanvasNodeData | null | undefined): CharacterViewUrls {
    if (!node) return {};
    const meta = node.metadata || {};
    const def = (meta.characterDefinition || {}) as Record<string, unknown>;
    const fullBody =
        str(def.fullBodyUrl) ||
        str(def.full_body_image_url) ||
        (meta.characterView === "multi" ? undefined : str(meta.characterCoverUrl)) ||
        str(meta.characterCoverUrl);
    const threeView =
        str(def.threeViewUrl) ||
        str(def.three_view_image_url) ||
        (meta.characterView === "multi" ? str(meta.characterCoverUrl) : undefined);
    const headshot = str(def.headshotUrl) || str(def.headshot_image_url) || str(def.avatar_url);
    return {
        fullBody: fullBody || undefined,
        threeView: threeView || undefined,
        headshot: headshot || undefined,
    };
}

/** Derived views lock until a master (full body or any upload) exists — LumenX workbench rule. */
export function characterDerivedViewsLocked(urls: CharacterViewUrls): boolean {
    return !urls.fullBody && !urls.threeView && !urls.headshot ? false : !urls.fullBody;
}

export function characterHasMasterReference(urls: CharacterViewUrls): boolean {
    return Boolean(urls.fullBody || urls.threeView || urls.headshot);
}

function str(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}
