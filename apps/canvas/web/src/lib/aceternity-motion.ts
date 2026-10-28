/**
 * 动效配置 — 对齐 Freezone `--toiv-motion-*`（R12/A2：base **220ms**）。
 *
 * JS duration（秒）↔ CSS token（毫秒）：
 *   instant  0.15s = --toiv-motion-fast   (150ms)
 *   state    0.15s = --toiv-motion-fast   (150ms) · 微态
 *   panel    0.22s = --toiv-motion-base   (220ms) · 面板/入场裁判（创作台主路径）
 *   slow     0.32s = --toiv-motion-slow   (320ms) · 备档，非主路径
 *
 * easing：
 *   enter  [0.22, 1, 0.36, 1] = --toiv-motion-ease
 *   exit   [0.4, 0, 1, 1]
 *
 * A2：创作台主路径优先 `tween.panel`（duration 220），勿再硬编码 spring≈250/320。
 * spring 仅 dock/手势残留；prefers-reduced-motion 由组件 useReducedMotion() 处理。
 */
export const aceternityMotion = {
    duration: {
        instant: 0.15,
        state: 0.15,
        panel: 0.22,
        slow: 0.32,
    },
    tween: {
        /** Panel / indicator / empty enter — R12 nail 220ms */
        panel: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const },
        state: { duration: 0.15, ease: [0.22, 1, 0.36, 1] as const },
        exit: { duration: 0.15, ease: [0.4, 0, 1, 1] as const },
    },
    spring: {
        // Dock/gesture only; settle tuned ≈ motion-base, not a second motion language.
        dock: { mass: 0.12, stiffness: 320, damping: 28 },
        surface: { mass: 0.22, stiffness: 340, damping: 30 },
        panel: { mass: 0.28, stiffness: 360, damping: 32 },
    },
    easing: {
        enter: [0.22, 1, 0.36, 1] as const,
        exit: [0.4, 0, 1, 1] as const,
    },
} as const;
