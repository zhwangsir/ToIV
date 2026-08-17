"use client";

/**
 * LibTV 式短剧工作台 —— 容器组件(2026-08-16 重构骨架)。
 *
 * 接收 useDramaProject 的 dp 对象(零新 API),持有:
 *   - stage 阶段路由(①剧本 ②资产 ③分镜 ④短片)
 *   - 双确认门 confirmedScript/confirmedShots(初始值从 project.status 推导;
 *     确认时经 dp.patchProject 回写 status,阶梯 draft→storyboard→generating→ready,
 *     与后端既有写入点一致:拆分镜置 storyboard、合成置 ready)
 *   - 浅/暗 zone(默认暗房,顶栏即时切换,仅改 .wb-root data-zone)
 *
 * 阶段工作区为 Team B/C 交付的真实组件(StageScript/StageAssets/StageShots/
 * StageProduce/FilmStrip/Inspector),契约见 ./types.ts。
 * 在 DramaView 中以 key=project.id 挂载,切项目即重挂载、状态按新项目重新推导。
 */
import { useState } from "react";

import "@/app/styles/drama-workbench.css";

import type {
  DramaProjectApi,
  Stage,
  StageStubProps,
  WorkbenchZone,
} from "./types";
import { WorkbenchShell } from "./WorkbenchShell";
import { StageScript } from "./StageScript";
import { StageAssets } from "./StageAssets";
import { StageShots } from "./StageShots";
import { StageProduce } from "./StageProduce";
import { Inspector } from "./Inspector";

// 确认门推导(任务钉死):storyboard/generating/ready 视为剧本已确认;
// generating/ready 视为分镜已确认。与后端 status 阶梯一致。
export const SCRIPT_CONFIRMED_STATUSES = new Set(["storyboard", "generating", "ready"]);
export const SHOTS_CONFIRMED_STATUSES = new Set(["generating", "ready"]);

export function initialStage(status: string, shotCount: number): Stage {
  if (SHOTS_CONFIRMED_STATUSES.has(status)) return "produce";
  if (SCRIPT_CONFIRMED_STATUSES.has(status)) {
    return shotCount > 0 ? "shots" : "assets";
  }
  return "script";
}

export function DramaWorkbench({ dp }: { dp: DramaProjectApi }) {
  const status = dp.current?.status ?? "draft";
  const [stage, setStage] = useState<Stage>(() =>
    initialStage(status, dp.shots.length),
  );
  const [confirmedScript, setConfirmedScript] = useState(() =>
    SCRIPT_CONFIRMED_STATUSES.has(status),
  );
  const [confirmedShots, setConfirmedShots] = useState(() =>
    SHOTS_CONFIRMED_STATUSES.has(status),
  );
  const [zone, setZone] = useState<WorkbenchZone>("darkroom");

  // 确认门:本地状态 + 回写 project.status(设计文档 2.1;失败不阻断本地推进,
  // 错误由 patchProject 抛出——这里吞掉仅保本地态,真实保存由 Team B/C 阶段内重试)
  const onConfirmScript = () => {
    setConfirmedScript(true);
    if (!SCRIPT_CONFIRMED_STATUSES.has(status)) {
      void dp.patchProject({ status: "storyboard" }).catch(() => {});
    }
    setStage("assets");
  };
  const onConfirmShots = () => {
    setConfirmedShots(true);
    if (!SHOTS_CONFIRMED_STATUSES.has(status)) {
      void dp.patchProject({ status: "generating" }).catch(() => {});
    }
    setStage("produce");
  };
  const onOpenProduce = (sid: string) => {
    dp.setSelectedShotId(sid);
    setStage("produce");
  };

  const stubProps: StageStubProps = {
    dp,
    confirmedScript,
    confirmedShots,
    onConfirmScript,
    onConfirmShots,
    onOpenProduce,
  };

  return (
    <WorkbenchShell
      project={dp}
      stage={stage}
      onStage={setStage}
      inspector={<Inspector dp={dp} onOpenProduce={onOpenProduce} />}
      confirmedScript={confirmedScript}
      confirmedShots={confirmedShots}
      onConfirmScript={onConfirmScript}
      onConfirmShots={onConfirmShots}
      zone={zone}
      onZone={setZone}
    >
      {stage === "script" && <StageScript {...stubProps} />}
      {stage === "assets" && <StageAssets {...stubProps} />}
      {stage === "shots" && (
        <StageShots
          dp={dp}
          onOpenProduce={onOpenProduce}
          confirmedShots={confirmedShots}
          onConfirmShots={onConfirmShots}
        />
      )}
      {stage === "produce" && <StageProduce {...stubProps} />}
    </WorkbenchShell>
  );
}
