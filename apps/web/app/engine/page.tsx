import type { Metadata } from "next";

import { CapabilityShowcase } from "@/components/hero/CapabilityShowcase";
import { CreationEngineHero } from "@/components/hero/CreationEngineHero";

export const metadata: Metadata = {
  title: "ToIV · 创作引擎",
  description:
    "全息指挥控制台 —— 由 4× RTX PRO 6000 驱动的 AI 创作飞船驾驶舱。图像 / 视频 / 漫剧 / 3D / 音频 / 模型,一个引擎驱动全部创作。",
};

/**
 * /engine —— 创作引擎落地页。
 * 首屏:全息指挥控制台 hero(满屏 100dvh);
 * 第二屏:六大能力展示区,滚动揭示,每卡直达对应模块。
 */
export default function EnginePage() {
  return (
    <>
      <CreationEngineHero />
      <CapabilityShowcase />
    </>
  );
}
