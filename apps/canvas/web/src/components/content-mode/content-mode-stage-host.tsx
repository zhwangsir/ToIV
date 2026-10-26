import { LightCurtainPaddle } from "@/components/content-mode/light-curtain-paddle";
import "@/components/content-mode/content-mode-prototypes.css";

/**
 * 生产挂载：仅 A 光幕拨片（舞台顶栏居中）。
 * B/C 源码仍在 content-mode/*，默认不渲染；勿再挂原型切换器。
 */
export function ContentModeStageHost() {
    return <LightCurtainPaddle />;
}
