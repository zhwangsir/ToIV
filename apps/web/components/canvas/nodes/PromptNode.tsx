"use client";

import { memo, useCallback } from "react";
import { useCanvasStore } from "@/lib/canvas/store";
import type { CanvasNodeData, PromptPayload } from "@/lib/canvas/types";

interface PromptNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

/** 提示词节点 body —— 正向 / 负向 textarea,失焦回写。 */
function PromptNodeBodyImpl({ data, nodeId }: PromptNodeBodyProps) {
  const updateNodePayload = useCanvasStore((s) => s.updateNodePayload);
  const payload = data.payload as PromptPayload;

  const onPositiveBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      if (next === payload.text) return;
      void updateNodePayload(nodeId, { text: next });
    },
    [nodeId, payload.text, updateNodePayload],
  );

  const onNegativeBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      if (next === (payload.negative ?? "")) return;
      void updateNodePayload(nodeId, { negative: next });
    },
    [nodeId, payload.negative, updateNodePayload],
  );

  return (
    <>
      <div className="tn-field">
        <label className="tn-field-label">正向</label>
        <textarea
          className="tn-textarea"
          rows={3}
          defaultValue={payload.text}
          onBlur={onPositiveBlur}
          placeholder="masterpiece, best quality, …"
          spellCheck={false}
        />
      </div>
      <div className="tn-field">
        <label className="tn-field-label">负向</label>
        <textarea
          className="tn-textarea"
          rows={2}
          defaultValue={payload.negative ?? ""}
          onBlur={onNegativeBlur}
          placeholder="lowres, bad anatomy, …"
          spellCheck={false}
        />
      </div>
    </>
  );
}

// 只比较渲染用到的关键字段:payload.text / payload.negative / status
export const PromptNodeBody = memo(PromptNodeBodyImpl, (prev, next) => {
  if (prev.nodeId !== next.nodeId || prev.data.status !== next.data.status) {
    return false;
  }
  const pp = prev.data.payload as PromptPayload;
  const np = next.data.payload as PromptPayload;
  return pp.text === np.text && pp.negative === np.negative;
});
