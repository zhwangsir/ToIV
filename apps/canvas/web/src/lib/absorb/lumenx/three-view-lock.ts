/**
 * Adapted from alibaba/lumenx@f2a02e23171447c939e7d8e1386b24d17049bbf1
 * CharacterWorkbench three_view / headshot isLocked pattern (MIT)
 * Copyright (c) 2026 Alibaba — see ../NOTICE
 */
import type { CharacterViewUrls } from "./character-image";
import { characterDerivedViewsLocked } from "./character-image";

export type ThreeViewLockState = {
    masterReady: boolean;
    derivedLocked: boolean;
    r2vLocked: boolean;
    slots: Array<{
        id: "full_body" | "three_view" | "headshot";
        label: string;
        url?: string;
        locked: boolean;
        description: string;
    }>;
};

export function buildThreeViewLockState(urls: CharacterViewUrls, r2vLocked = false): ThreeViewLockState {
    const derivedLocked = characterDerivedViewsLocked(urls);
    const masterReady = Boolean(urls.fullBody);
    return {
        masterReady,
        derivedLocked,
        r2vLocked,
        slots: [
            {
                id: "full_body",
                label: "主形象",
                url: urls.fullBody,
                locked: false,
                description: "一致性主参考（解锁派生视图的钥匙）",
            },
            {
                id: "three_view",
                label: "三视图",
                url: urls.threeView,
                locked: derivedLocked,
                description: "正/侧/背 · R2V 参考表",
            },
            {
                id: "headshot",
                label: "头像特写",
                url: urls.headshot,
                locked: derivedLocked,
                description: "面部细节与表情",
            },
        ],
    };
}
