"use client";

import { createContext, useContext } from "react";

import type { CanvasNodeType } from "./types";

/** 节点与画布之间的桥:更新/删除/运行,以及取上游输入。 */
export interface CanvasApi {
  /** 不可变更新某节点的 data(浅合并)。 */
  patchNodeData: (id: string, patch: Record<string, unknown>) => void;
  /** 删除节点(连带其边)。 */
  deleteNode: (id: string) => void;
  /** 运行单个节点(从上游已连接节点取输入,跑生成)。 */
  runNode: (id: string) => Promise<void>;
  /** 可选模型列表(图片节点用)。 */
  ckpts: string[];
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
  return t === "text" || t === "image" || t === "video" || t === "audio";
}
