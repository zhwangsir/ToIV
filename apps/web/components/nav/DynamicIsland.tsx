"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, type Transition } from "framer-motion";

import { NavIcon } from "@/components/ui/NavIcon";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { useReducedMotion } from "@/hooks/useReducedMotion";

import { type ActivityKind, useActivity } from "./ActivityContext";

/** 单个视图项:与 page.tsx 的 View 切换一一对应。 */
export interface IslandView {
  key: string;
  /** 完整标签(悬停展开 / 当前态显示)。 */
  label: string;
  /** NavIcon 图标名。 */
  icon: string;
}

interface DynamicIslandProps<K extends string> {
  views: readonly IslandView[];
  /** 当前激活视图 key。 */
  current: K;
  /** 切换视图(沿用 page.tsx 现有 setView 行为)。 */
  onSelect: (key: K) => void;
  /** 账户邮箱(收进岛右端展示)。 */
  account?: string;
  /** 退出回调。 */
  onLogout: () => void;
}

/** 橡皮筋形变物理 —— 内容撑大边框,带一点过冲张力。 */
const ISLAND_SPRING: Transition = { type: "spring", stiffness: 380, damping: 30, mass: 0.9 };

/** 活动卡进出的轻量弹性。 */
const ACTIVITY_SPRING: Transition = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 };

/** 活动种类 → 文案。 */
const KIND_LABEL: Record<ActivityKind, string> = {
  image: "图像生成",
  video: "视频生成",
  model3d: "3D 生成",
  audio: "音频生成",
  canvas: "画布运算",
  manju: "漫剧合成",
};

/** 活动种类 → NavIcon 名(复用既有图标集)。 */
const KIND_ICON: Record<ActivityKind, string> = {
  image: "image",
  video: "video",
  model3d: "threed",
  audio: "audio",
  canvas: "image",
  manju: "video",
};

/** 提示词截断(避免活动卡过宽)。 */
function truncate(text: string, max = 42): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * 苹果灵动岛式悬浮导航胶囊。
 * 三态 + 完成脉冲:
 *  - 紧凑(静息):brand + 当前视图名 + 极小图标排 + 呼吸 GPU 负载点
 *  - 悬停展开:横向长大,图标展开成带文字的完整导航,品紫墨块 layoutId 滑移
 *  - 实时活动(生成中):向下长大成 live activity,模式图标 + spinner + 提示词 + 进度
 *  - 完成脉冲:任务结束品紫脉冲一下再弹性收回
 * reduced-motion → 降级纯 opacity 淡入淡出,不做 layout 形变。
 */
export function DynamicIsland<K extends string>({
  views,
  current,
  onSelect,
  account,
  onLogout,
}: DynamicIslandProps<K>) {
  const reduced = useReducedMotion();
  const { activity } = useActivity();

  const [expanded, setExpanded] = useState(false);
  // 完成脉冲:活动从 running → done 的瞬间触发一次,脉冲结束自动复位。
  const [pulse, setPulse] = useState(false);
  const prevPhase = useRef<string | null>(null);

  useEffect(() => {
    const phase = activity?.phase ?? null;
    if (prevPhase.current === "running" && phase === "done") {
      setPulse(true);
      const id = window.setTimeout(() => setPulse(false), 720);
      prevPhase.current = phase;
      return () => window.clearTimeout(id);
    }
    prevPhase.current = phase;
    return undefined;
  }, [activity?.phase]);

  const liveActive = activity?.phase === "running";
  const currentView = views.find((v) => v.key === current);

  // 进度百分比(value/max);不确定态 → null。
  const pct =
    activity && activity.value !== null && activity.max !== null && activity.max > 0
      ? Math.min(100, Math.round((activity.value / activity.max) * 100))
      : null;

  // reduced-motion 下统一关掉弹性 layout,只走 opacity。
  const layoutProps = reduced
    ? {}
    : ({ layout: true, transition: ISLAND_SPRING } as const);

  return (
    <div className="island-dock">
      <motion.nav
        {...layoutProps}
        className={`island${expanded ? " is-expanded" : ""}${liveActive ? " is-live" : ""}${
          pulse ? " is-pulse" : ""
        }`}
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        onFocusCapture={() => setExpanded(true)}
        onBlurCapture={(e) => {
          // 焦点完全离开岛时收回(键盘可达)。
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setExpanded(false);
        }}
        aria-label="模块导航"
      >
        {/* ── 顶行:brand + 视图 + GPU 点(三态共用) ── */}
        <motion.div {...layoutProps} className="island-bar">
          <motion.span {...layoutProps} className="island-brand" aria-hidden="true">
            To<span className="mark">IV</span>
          </motion.span>

          {/* 紧凑态显示当前视图名;悬停展开时由完整导航接管 */}
          {!expanded && currentView && (
            <motion.span
              className="island-current"
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduced ? undefined : { opacity: 0 }}
            >
              {currentView.label}
            </motion.span>
          )}

          {/* 视图项:紧凑=极小图标排,展开=图标+文字。当前态品紫墨块滑移。 */}
          <motion.div {...layoutProps} className="island-views" role="tablist" aria-label="切换模块">
            {views.map((v) => {
              const isActive = v.key === current;
              return (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-label={v.label}
                  title={v.label}
                  className={`island-view-btn${isActive ? " is-active" : ""}`}
                  onClick={() => onSelect(v.key as K)}
                >
                  {isActive && (
                    <motion.span
                      className="island-pill"
                      layoutId="island-pill"
                      aria-hidden="true"
                      transition={reduced ? { duration: 0 } : ISLAND_SPRING}
                    />
                  )}
                  <span className="island-view-ico">
                    <NavIcon name={v.icon} />
                  </span>
                  <AnimatePresence initial={false}>
                    {expanded && (
                      <motion.span
                        className="island-view-label"
                        initial={reduced ? false : { opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: "auto" }}
                        exit={reduced ? undefined : { opacity: 0, width: 0 }}
                        transition={reduced ? { duration: 0 } : { duration: 0.18 }}
                      >
                        {v.label}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>
              );
            })}
          </motion.div>

          {/* 账户操作:展开时浮现(主题切换 + 退出 + 邮箱) */}
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                className="island-account"
                initial={reduced ? false : { opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: "auto" }}
                exit={reduced ? undefined : { opacity: 0, width: 0 }}
                transition={reduced ? { duration: 0 } : { duration: 0.2 }}
              >
                {account && (
                  <span className="island-user" title={account}>
                    {account}
                  </span>
                )}
                <ThemeToggle />
                <button type="button" className="island-logout" onClick={onLogout}>
                  退出
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>

        {/* ── 活动行:生成中向下长大成 live activity ── */}
        <AnimatePresence initial={false}>
          {liveActive && activity && (
            <motion.div
              className="island-activity"
              initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={reduced ? { duration: 0.18 } : ACTIVITY_SPRING}
              role="status"
              aria-live="polite"
            >
              <span className="island-activity-row">
                <span className="island-activity-ico" aria-hidden="true">
                  <NavIcon name={KIND_ICON[activity.kind]} />
                </span>
                {!reduced && <span className="island-spinner" aria-hidden="true" />}
                <span className="island-activity-label">
                  <em>{KIND_LABEL[activity.kind]}</em>
                  {activity.label && <span>{truncate(activity.label)}</span>}
                </span>
                <span className="island-activity-meta">
                  {activity.shot
                    ? `镜 ${activity.shot.index}/${activity.shot.total}`
                    : pct !== null
                      ? `${pct}%`
                      : "排队中"}
                </span>
              </span>
              {/* 品紫细进度条:确定态用真实百分比,不确定态走流动 */}
              <span className="island-progress" aria-hidden="true">
                <span
                  className={`island-progress-fill${pct === null ? " is-indeterminate" : ""}`}
                  style={pct !== null ? { width: `${pct}%` } : undefined}
                />
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.nav>
    </div>
  );
}
