import type { Metadata } from "next";

import { CreationEngineHero } from "@/components/hero/CreationEngineHero";

export const metadata: Metadata = {
  title: "ToIV · 创作引擎",
  description: "全息指挥控制台 —— 由 4× RTX PRO 6000 驱动的 AI 创作飞船驾驶舱。",
};

/**
 * /engine —— 创作引擎 hero 预览路由(实机查看)。
 * 满屏暗色,渲染 CreationEngineHero。独立于主应用壳。
 */
export default function EnginePage() {
  return <CreationEngineHero />;
}
