"use client";

import { createContext, useContext } from "react";

import type { CanvasModels } from "./models";
import type { CanvasNodeType } from "./types";

/** 节点把产物归档到作品库的结果。 */
export type ArchiveOutcome = "done" | "exists" | "empty" | "failed";

/** 节点与画布之间的桥:更新/删除/运行/归档,以及取上游输入与模型。 */
export interface CanvasApi {
  /** 不可变更新某节点的 data(浅合并)。 */
  patchNodeData: (id: string, patch: Record<string, unknown>) => void;
  /** 删除节点(连带其边)。 */
  deleteNode: (id: string) => void;
  /** 运行单个节点(从上游已连接节点取输入,跑生成)。 */
  runNode: (id: string) => Promise<void>;
  /** 把某节点当前产物 url 归档到作品库(客户端标记)。 */
  archiveOutput: (id: string) => ArchiveOutcome;
  /** 某 url 是否已归档(节点按钮态)。 */
  isOutputArchived: (url: string | null) => boolean;
  /** 可选模型列表(图片/角色节点用;向后兼容,等价 models.all 的名称)。 */
  ckpts: string[];
  /** NSFW 档感知的解析模型集(含 nsfw/vpred 标记 + 是否有标记)。 */
  models: CanvasModels;
  /** 是否有「运行全部」在进行(禁用单节点重复触发)。 */
  pipelineBusy: boolean;
}

const Ctx = createContext<CanvasApi | null>(null);

export const CanvasProvider = Ctx.Provider;

export function useCanvas(): CanvasApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCanvas 必须在 CanvasProvider 内使用");
  return v;
}

/** 节点类型守卫(给运行逻辑做收窄)。 */
export function isType(t: unknown): t is CanvasNodeType {
  return (
    t === "text" ||
    t === "image" ||
    t === "video" ||
    t === "audio" ||
    t === "storyboard" ||
    t === "character" ||
    t === "lighting" ||
    t === "threed"
  );
}
