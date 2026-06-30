// 画布配方模板库:预置一批「一键铺好的节点图」,直击空画布不会连的上手门槛。
// 蓝图机械生成:source handle id 恰为 OUTPUT_KIND[type](text/image/video),target 恒 "in"。
import type { Edge, Node } from "@xyflow/react";

import { OUTPUT_KIND, defaultData, nextNodeId, type CanvasNodeType } from "./types";

/** 节点摆位:col=列(深度),row=行(并列输入用)。 */
interface NodeSpec {
  type: CanvasNodeType;
  col: number;
  row: number;
}

/** 边:用 specs 索引指代源/目标节点。 */
interface EdgeSpec {
  from: number;
  to: number;
}

export interface CanvasRecipe {
  id: string;
  name: string;
  icon: string;
  desc: string;
  /** 实例化为一组带唯一 id 的节点 + 边(每次调用 id 都新)。 */
  build(): { nodes: Node[]; edges: Edge[] };
}

const COL_W = 360;
const ROW_H = 210;
const X0 = 80;
const Y0 = 80;

/** 把 spec 编译成 build 函数:位置按 col/row 排,边的 sourceHandle 自动取 OUTPUT_KIND。 */
function recipe(
  meta: Omit<CanvasRecipe, "build">,
  specs: NodeSpec[],
  edgeSpecs: EdgeSpec[],
): CanvasRecipe {
  return {
    ...meta,
    build() {
      const ids = specs.map(() => nextNodeId());
      const nodes: Node[] = specs.map((s, i) => ({
        id: ids[i],
        type: s.type,
        position: { x: X0 + s.col * COL_W, y: Y0 + s.row * ROW_H },
        data: defaultData(s.type),
      }));
      const edges: Edge[] = edgeSpecs.map((e) => {
        const source = ids[e.from];
        const target = ids[e.to];
        return {
          id: `e-${source}-${target}`,
          source,
          target,
          sourceHandle: OUTPUT_KIND[specs[e.from].type] ?? undefined,
          targetHandle: "in",
        };
      });
      return { nodes, edges };
    },
  };
}

export const CANVAS_RECIPES: CanvasRecipe[] = [
  recipe(
    {
      id: "t2i-refine",
      name: "文生图 · 精修",
      icon: "✨",
      desc: "提示词 → 出图 → 高清放大,最常用的一条龙",
    },
    [
      { type: "text", col: 0, row: 0 },
      { type: "image", col: 1, row: 0 },
      { type: "upscale", col: 2, row: 0 },
    ],
    [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ],
  ),
  recipe(
    {
      id: "inpaint-edit",
      name: "改图 · 局部重绘",
      icon: "🎯",
      desc: "传一张图,说哪里改,文字定向重绘",
    },
    [
      { type: "image", col: 0, row: 0 },
      { type: "inpaint", col: 1, row: 0 },
    ],
    [{ from: 0, to: 1 }],
  ),
  recipe(
    {
      id: "upscale",
      name: "高清放大",
      icon: "🔍",
      desc: "传图 → 4× 放大,补回细节",
    },
    [
      { type: "image", col: 0, row: 0 },
      { type: "upscale", col: 1, row: 0 },
    ],
    [{ from: 0, to: 1 }],
  ),
  recipe(
    {
      id: "ipadapter-consistent",
      name: "角色一致 · 参考出图",
      icon: "🪞",
      desc: "参考图锁人物 + 提示词换场景,人物不崩",
    },
    [
      { type: "text", col: 0, row: 0 },
      { type: "image", col: 0, row: 1 },
      { type: "ipadapter", col: 1, row: 0 },
    ],
    [
      { from: 0, to: 2 },
      { from: 1, to: 2 },
    ],
  ),
  recipe(
    {
      id: "controlnet-pose",
      name: "构图控制 · 线稿上色",
      icon: "🧭",
      desc: "线稿/骨架锁构图 + 提示词,精准控形",
    },
    [
      { type: "text", col: 0, row: 0 },
      { type: "image", col: 0, row: 1 },
      { type: "controlnet", col: 1, row: 0 },
    ],
    [
      { from: 0, to: 2 },
      { from: 1, to: 2 },
    ],
  ),
  recipe(
    {
      id: "storyboard-batch",
      name: "剧情分镜 · 批量出图",
      icon: "📋",
      desc: "一句剧情 → 多镜剧本 → 逐镜出图",
    },
    [
      { type: "text", col: 0, row: 0 },
      { type: "storyboard", col: 1, row: 0 },
      { type: "image", col: 2, row: 0 },
    ],
    [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ],
  ),
];
