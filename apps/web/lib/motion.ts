import type { Transition, Variants } from "framer-motion";

/**
 * ToIV 动效系统 —— 一处定义弹性物理与错峰节奏,全站复用。
 * 原则:克制、有意图、丝滑;只走 transform / opacity / clip-path / filter。
 * reduced-motion 由各处用 useReducedMotion + MotionConfig 统一降级。
 */

/** 主弹性:用于进场、悬停抬升、按压回弹 —— 温和有重量,不弹过头。 */
export const spring: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 36,
  mass: 0.9,
};

/** 软弹性:大块视图切换,慢半拍更从容。 */
export const springSoft: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 30,
  mass: 1,
};

/** 编辑式缓动:非弹性的精确过渡(clip-path 揭示等)。 */
export const easeEditorial: Transition = {
  duration: 0.55,
  ease: [0.16, 1, 0.3, 1],
};

/** 视图切换:整页错峰淡入上浮。 */
export const viewVariants: Variants = {
  initial: { opacity: 0, y: 10, filter: "blur(6px)" },
  enter: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { ...springSoft, filter: { duration: 0.4 } },
  },
  exit: {
    opacity: 0,
    y: -8,
    filter: "blur(4px)",
    transition: { duration: 0.22, ease: [0.4, 0, 1, 1] },
  },
};

/** 容器:让子项错峰登场。 */
export const staggerParent: Variants = {
  initial: {},
  enter: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } },
};

/** 子项:配合 staggerParent 的错峰单元。 */
export const staggerChild: Variants = {
  initial: { opacity: 0, y: 14 },
  enter: { opacity: 1, y: 0, transition: spring },
};

/**
 * 签名时刻 —— 结果「冲洗显影」揭示:
 * 由下而上擦除的 clip-path + 轻微去糊去暗,像照片在显影液里浮现。
 */
export const developVariants: Variants = {
  initial: {
    opacity: 0,
    clipPath: "inset(100% 0 0 0)",
    filter: "brightness(0.4) blur(8px)",
    scale: 1.04,
  },
  enter: {
    opacity: 1,
    clipPath: "inset(0% 0 0 0)",
    filter: "brightness(1) blur(0px)",
    scale: 1,
    transition: {
      clipPath: easeEditorial,
      filter: { duration: 0.7, ease: [0.16, 1, 0.3, 1] },
      opacity: { duration: 0.3 },
      scale: springSoft,
    },
  },
};

/** 悬停抬升预设(配 whileHover / whileTap)。 */
export const lift = {
  whileHover: { y: -4, transition: spring },
  whileTap: { scale: 0.985, transition: spring },
};
