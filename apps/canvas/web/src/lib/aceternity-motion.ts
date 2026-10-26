/**
 * 动效配置 — 对齐 Freezone `--toiv-motion-*`（R12 TL：base **220ms**）。
 *
 * JS duration（秒）↔ CSS token（毫秒）：
 *   instant  0.15s = --toiv-motion-fast   (150ms)
 *   state    0.15s = --toiv-motion-fast   (150ms) · 微态
 *   panel    0.22s = --toiv-motion-base   (220ms) · 面板/入场裁判
 *   slow     0.32s = --toiv-motion-slow   (320ms) · 备档
 *
 * easing：
 *   enter  [0.22, 1, 0.36, 1] = --toiv-motion-ease / cubic-bezier(0.22,1,0.36,1)
 *   exit   [0.4, 0, 1, 1]     ≈ ease-in 出场
 *
 * prefers-reduced-motion 由组件层 useReducedMotion() 控制。
 * spring 仅用于 dock/手势；面板入场优先 duration.panel + easing.enter。
 */
export const aceternityMotion = {
    duration: {
        instant: 0.15,
        state: 0.15,
        panel: 0.22,
        slow: 0.32,
    },
    spring: {
        // Keep springs for docks; stiffness tuned so settle ≈ motion-base feel.
        dock: { mass: 0.12, stiffness: 280, damping: 22 },
        surface: { mass: 0.28, stiffness: 300, damping: 28 },
        panel: { mass: 0.36, stiffness: 320, damping: 30 },
    },
    easing: {
        enter: [0.22, 1, 0.36, 1] as const,
        exit: [0.4, 0, 1, 1] as const,
    },
} as const;
