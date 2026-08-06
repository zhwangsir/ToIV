import { useEffect, useState } from "react";

/**
 * 断点 hook(批 4 断点收敛):阈值与 globals.css 断点令牌(--bp-sm/md/lg/xl)一致,
 * 新代码一律走这里读取断点,不再在组件里硬编码像素值。
 *
 * 注意:存量各视图 styled-jsx/CSS 媒体查询的断点值未收敛(如 1023/767/479 等 bp-1 写法),
 * 本 hook 只供新代码使用;旧值收敛记录在批 4 遗留项,不在本批改动(回归风险大)。
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
