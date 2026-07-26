"use client";

import { memo, useCallback } from "react";
import { useCanvasStore } from "@/lib/canvas/store";
import type { CanvasNodeData, TextPayload } from "@/lib/canvas/types";

interface TextNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

/** 文本笔记节点 body —— 单 textarea,失焦回写 payload.text。 */
function TextNodeBodyImpl({ data, nodeId }: TextNodeBodyProps) {
  const updateNodePayload = useCanvasStore((s) => s.updateNodePayload);
  const payload = data.payload as TextPayload;

  const onBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      if (next === payload.text) return;
      void updateNodePayload(nodeId, { text: next });
    },
    [nodeId, payload.text, updateNodePayload],
  );

  return (
    <div className="tn-field">
      <textarea
        className="tn-textarea"
        rows={5}
        defaultValue={payload.text}
        onBlur={onBlur}
        placeholder="输入笔记内容…"
        spellCheck={false}
      />
    </div>
  );
}

// 只比较渲染用到的关键字段:payload.text / status,其余 data 变化(如位置)不重渲染
export const TextNodeBody = memo(
  TextNodeBodyImpl,
  (prev, next) =>
    prev.nodeId === next.nodeId &&
    prev.data.status === next.data.status &&
    (prev.data.payload as TextPayload).text ===
      (next.data.payload as TextPayload).text,
);
