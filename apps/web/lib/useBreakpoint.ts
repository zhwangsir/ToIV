import { useEffect, useState } from "react";

/**
 * 断点 hook(批 4 断点收敛):阈值与 globals.css 断点令牌(--bp-sm/md/lg/xl)一致,
 * 新代码一律走这里读取断点,不再在组件里硬编码像素值。
 *
 * 全站 CSS 媒体查询断点已收敛(2026-08-09 批 4 收尾):max 形式统一为令牌值 -1
 * (575/767/1023),min 形式为令牌值(576/768/1024/1440);JS 侧判断视口用本 hook,
 * SSR 不安全的场景(如 useState lazy init)用 BREAKPOINTS 常量拼查询串,
 * max 形式取 `BREAKPOINTS[bp] - 1` 与 CSS 对齐。
 */
export const BREAKPOINTS = { sm: 576, md: 768, lg: 1024, xl: 1440 } as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/** 通用 matchMedia hook:SSR 安全(初值 false,挂载后同步真实值),query 变化自动重挂。 */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** 视口宽度 ≤ 断点(令牌值,如 useBreakpoint("lg") = max-width: 1024px)。 */
export function useBreakpoint(bp: Breakpoint): boolean {
  return useMedia(`(max-width: ${BREAKPOINTS[bp]}px)`);
}
