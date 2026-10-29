import type { ContentPolicy } from "./content-policy";

/** 前端内容策略锁(web 薄壳)。删除本文件即完全解锁:别名回落到 content-policy.ts 的 no-op。 */
export const contentPolicy: ContentPolicy = {
    id: "D-U1=B-frontend-guard",
    isAppVisible: (pure, adultOn) => adultOn || !pure,
};
