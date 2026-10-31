/**
 * 内容策略接口 + 中性空实现(unrestricted)。
 *
 * web 薄壳的内容可见性判定统一走 `@content-lock` 别名:存在 content-lock.ts 时用锁,
 * 删除锁文件后自动回落到本文件的 no-op(全部放行),主代码零改动、零报错。
 * 本文件只定义接口与空实现,不含任何限制逻辑。
 */
export interface ContentPolicy {
    id: string;
    isAppVisible(pure: boolean, adultOn: boolean): boolean;
}

export const contentPolicy: ContentPolicy = {
    id: "unrestricted",
    isAppVisible: () => true,
};
