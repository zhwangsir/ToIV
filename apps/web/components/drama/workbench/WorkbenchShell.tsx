"use client";

/**
 * LibTV 式短剧工作台 —— 壳组件。
 * 顶栏(48px,四步进器恒显:①剧本 ②资产 ③分镜 ④短片)
 * + 左栏 240px(场次统计/资产入口,点击跳对应阶段)+ 中央阶段工作区(children)
 * + 右栏检查器(320px,可收叠;≤1600px 视口改为覆盖式浮层不占栏宽)
 * + 底部胶片条(56px,仅短片阶段;FilmStrip 真实组件)。
 *
 * 组件契约见 ./types.ts(钉死);zone(浅/暗)由容器 DramaWorkbench 持有,
 * 本组件经 data-zone 落到 .wb-root,色值全部由 drama-workbench.css token 派生。
 */
import { useEffect, useMemo, useState } from "react";

import { Icon, type IconName } from "@/components/ui/Icon";
import { FilmStrip } from "./FilmStrip";
import type { Stage, WorkbenchShellProps } from "./types";

const STEPS: { key: Stage; label: string; icon: IconName }[] = [
  { key: "script", label: "剧本", icon: "file" },
  { key: "assets", label: "资产", icon: "package" },
  { key: "shots", label: "分镜", icon: "grid" },
  { key: "produce", label: "短片", icon: "film" },
];

function fmtTotal(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function WorkbenchShell({
  project: dp,
  stage,
  onStage,
  inspector,
  children,
  confirmedScript,
  confirmedShots,
  zone,
  onZone,
}: WorkbenchShellProps) {
  // <1600px 时检查器为覆盖式浮层,默认收起以免遮挡分镜表格右列(状态/时长/操作);
  // ≥1600px 固定栏,默认展开。
  // hydration 安全:首渲(SSR 与客户端水合)恒为展开,挂载后按实际视口校正,
  // 避免 useState 初始化读 window.innerWidth 导致服务端/客户端首渲不一致。
  const [inspectorOpen, setInspectorOpen] = useState(true);
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1600) setInspectorOpen(false);
  }, []);

  const shots = dp.shots;
  const totalSec = useMemo(
    () => shots.reduce((acc, s) => acc + (s.duration_sec || 0), 0),
    [shots],
  );
  const sceneCount = useMemo(
    () => new Set(shots.map((s) => s.scene).filter(Boolean)).size,
    [shots],
  );
  // 场景/道具资产数(资产库懒加载,未加载时仅展示入口不带计数)
  const scenePropCount = useMemo(() => {
    if (dp.assets === null) return null;
    return dp.assets.filter((a) => a.kind === "scene" || a.kind === "prop")
      .length;
  }, [dp.assets]);

  // 步进器可达性:剧本恒可达;资产/分镜需剧本已确认;短片需分镜已确认。
  // 完成步 ✓:剧本=已确认剧本;资产/分镜=已确认分镜(已通过);短片无完成态。
  const reachable = (key: Stage): boolean => {
    if (key === "script") return true;
    if (key === "produce") return confirmedShots;
    return confirmedScript;
  };
  const stepDone = (key: Stage): boolean => {
    if (key === "script") return confirmedScript;
    if (key === "assets" || key === "shots") return confirmedShots;
    return false;
  };

  return (
    <div className="wb-root" data-zone={zone}>
      {/* ── 顶栏:项目 + 四步进器 + 进度 + 浅/暗切换 ── */}
      <header className="wb-topbar">
        <div className="wb-topbar-title">
          <Icon name="clapperboard" size={16} />
          <span>{dp.current?.title ?? "短剧项目"}</span>
        </div>
        <nav className="wb-stepper" aria-label="创作阶段">
          {STEPS.map((s, i) => {
            const done = stepDone(s.key);
            const current = stage === s.key;
            return (
              <button
                key={s.key}
                type="button"
                className={`wb-step${current ? " is-current" : ""}${done ? " is-done" : ""}`}
                disabled={!reachable(s.key)}
                aria-current={current ? "step" : undefined}
                onClick={() => onStage(s.key)}
              >
                {done && !current ? (
                  <Icon name="check" size={13} />
                ) : (
                  <Icon name={s.icon} size={13} />
                )}
                {i + 1}·{s.label}
              </button>
            );
          })}
        </nav>
        <div className="wb-topbar-spacer" />
        <span className="wb-progress">
          {dp.doneCount}/{shots.length} 镜 · {fmtTotal(totalSec)}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title={zone === "darkroom" ? "切换浅色区" : "切换暗房"}
          aria-label={zone === "darkroom" ? "切换浅色区" : "切换暗房"}
          onClick={() => onZone(zone === "darkroom" ? "light" : "darkroom")}
        >
          <Icon name={zone === "darkroom" ? "sun" : "moon"} size={14} />
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title={inspectorOpen ? "收叠检查器" : "展开检查器"}
          aria-label={inspectorOpen ? "收叠检查器" : "展开检查器"}
          aria-expanded={inspectorOpen}
          onClick={() => setInspectorOpen((v) => !v)}
        >
          <Icon name="panel-right" size={14} />
        </button>
      </header>

      {/* ── 三栏:左栏 / 阶段工作区 / 检查器 ── */}
      <div className={`wb-main${inspectorOpen ? "" : " wb-main--inspector-closed"}`}>
        <aside className="wb-side">
          <div className="wb-side-section">
            <div className="wb-side-head">
              <Icon name="list-ordered" size={12} />
              剧集/场次
            </div>
            <button
              type="button"
              className="wb-side-item wb-side-link"
              disabled={shots.length === 0 || !reachable("shots")}
              title={
                shots.length === 0
                  ? "剧本确认后拆分镜,生成场次树"
                  : "查看分镜表"
              }
              onClick={() => onStage("shots")}
            >
              <Icon name="grid" size={13} />
              {shots.length > 0
                ? `${sceneCount} 场 · ${shots.length} 镜`
                : "尚未拆分镜"}
            </button>
          </div>
          <div className="wb-side-section">
            <div className="wb-side-head">
              <Icon name="package" size={12} />
              资产库
            </div>
            <button
              type="button"
              className="wb-side-item wb-side-link"
              disabled={!reachable("assets")}
              title="管理角色卡片墙"
              onClick={() => onStage("assets")}
            >
              <Icon name="users" size={13} />
              角色 {dp.characters.length}
            </button>
            <button
              type="button"
              className="wb-side-item wb-side-link"
              disabled={!reachable("assets")}
              title="管理场景/道具资产"
              onClick={() => onStage("assets")}
            >
              <Icon name="box" size={13} />
              场景/道具{scenePropCount !== null ? ` ${scenePropCount}` : ""}
            </button>
          </div>
        </aside>

        <section className="wb-stage">{children}</section>

        <aside className="wb-inspector" aria-hidden={!inspectorOpen}>
          <div className="wb-inspector-inner">{inspector}</div>
        </aside>
      </div>

      {/* ── 底部胶片条(仅短片阶段)── */}
      {stage === "produce" && (
        <footer className="wb-filmstrip">
          <FilmStrip
            shots={shots}
            currentSid={dp.selectedShotId}
            onPick={(sid) => dp.setSelectedShotId(sid)}
            onAssemble={() => void dp.assemble()}
          />
        </footer>
      )}
    </div>
  );
}
