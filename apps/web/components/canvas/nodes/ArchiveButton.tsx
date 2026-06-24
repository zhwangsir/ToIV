"use client";

import { useState } from "react";

import { useCanvas } from "../CanvasContext";

interface ArchiveButtonProps {
  /** 节点 id(用于读取其当前产物 url 归档)。 */
  nodeId: string;
  /** 当前产物 url(null = 无产物,按钮禁用)。 */
  outputUrl: string | null;
}

/** 「归档到作品库」动作:把节点产物 url 标记进客户端作品库清单(去重幂等)。
 *  产物本身经 /api/generate/* 已落库;归档是用户主动收藏的标记。 */
export function ArchiveButton({ nodeId, outputUrl }: ArchiveButtonProps) {
  const { archiveOutput, isOutputArchived } = useCanvas();
  const [flash, setFlash] = useState<string | null>(null);

  const archived = isOutputArchived(outputUrl);
  const disabled = !outputUrl;

  const onClick = () => {
    const outcome = archiveOutput(nodeId);
    const msg =
      outcome === "done"
        ? "已归档 ✓"
        : outcome === "exists"
          ? "已在库中"
          : outcome === "empty"
            ? "暂无产物"
            : "归档失败";
    setFlash(msg);
    setTimeout(() => setFlash(null), 1600);
  };

  return (
    <button
      type="button"
      className={`cv-archive nodrag${archived ? " is-archived" : ""}`}
      disabled={disabled}
      onClick={onClick}
      title={archived ? "已归档到作品库" : "归档到作品库"}
    >
      {flash ?? (archived ? "★ 已归档" : "☆ 归档")}
    </button>
  );
}
