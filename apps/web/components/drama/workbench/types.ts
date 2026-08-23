/**
 * LibTV 式短剧工作台 —— 组件契约(钉死,团队并行依据)。
 *
 * Team B(阶段①剧本/②资产)、Team C(阶段③分镜表格/④短片+胶片条/检查器)
 * 实现各自 Stage 组件时,props 形状以本文件为准,零新 API(全部数据/动作
 * 来自 useDramaProject 返回的 dp 对象)。
 */
import type { ReactNode } from "react";

import type { useDramaProject } from "@/hooks/useDramaProject";
import type { DramaShotItem } from "@/lib/api";

/** 四步进器阶段:①剧本 ②资产 ③分镜 ④短片 */
export type Stage = "script" | "assets" | "shots" | "produce";

/** 工作台主题区:暗房(默认,长时作业)/ 浅色(即时切换,不动全局主题偏好) */
export type WorkbenchZone = "darkroom" | "light";

/** useDramaProject 返回值(工作台全部数据/动作来源,不改其对外 API) */
export type DramaProjectApi = ReturnType<typeof useDramaProject>;

/** 镜头数据(含 2026-08-16 新增 mood 情绪标签 / beat 节拍注记) */
export type DramaShotApi = DramaShotItem;

/** 壳组件:顶栏(四步进器恒显)+ 左栏 + 中央阶段工作区 + 右栏检查器 + 底部胶片条 */
export interface WorkbenchShellProps {
  project: DramaProjectApi;
  stage: Stage;
  onStage: (s: Stage) => void;
  inspector: ReactNode;
  children: ReactNode; // children = 阶段工作区
  // ── 双确认门状态(由 DramaWorkbench 容器持有并持久化到 project.status)──
  confirmedScript: boolean;
  confirmedShots: boolean;
  onConfirmScript: () => void;
  onConfirmShots: () => void;
  // ── 浅/暗区切换(设计文档 2.0:顶栏内嵌即时切换;容器持有,不动全局主题)──
  zone: WorkbenchZone;
  onZone: (z: WorkbenchZone) => void;
}

/** 底部镜头胶片条(仅短片阶段显示;Team C 实现) */
export interface FilmStripProps {
  shots: DramaShotApi[];
  currentSid: string | null;
  onPick: (sid: string) => void;
  onAssemble: () => void;
}

/** 阶段③分镜表格(Team C 实现) */
export interface StageShotsProps {
  dp: DramaProjectApi;
  onOpenProduce: (sid: string) => void;
  // ── Team C 追加(可选;由 DramaWorkbench 确认门下发,缺省时从 project.status 推导)──
  confirmedShots?: boolean;
  onConfirmShots?: () => void;
}

/**
 * 阶段占位组件(骨架期)props。Team B/C 的真实 Stage 组件仅需依赖
 * dp + 确认门状态/回调,不新增 API。onOpenProduce 供分镜行/胶片条跳转短片阶段。
 */
export interface StageStubProps {
  dp: DramaProjectApi;
  confirmedScript: boolean;
  confirmedShots: boolean;
  onConfirmScript: () => void;
  onConfirmShots: () => void;
  onOpenProduce: (sid: string) => void;
}

/**
 * 右栏检查器(Team C 实现,2026-08-16 追加)。
 * 三态:选中镜头(dp.selectedShot)→ 镜头摘要;选中角色 → 角色摘要;否则项目摘要。
 * selectedCharacterId 为可选外部受控角色选中;缺省时检查器内部自管理
 * (项目摘要的角色列表点击进入角色摘要)。
 */
export interface InspectorProps {
  dp: DramaProjectApi;
  onOpenProduce: (sid: string) => void;
  selectedCharacterId?: string | null;
}
