"use client";

import { memo, useCallback } from "react";
import { useCanvasStore } from "@/lib/canvas/store";
import type { CanvasNodeData, LLMPayload } from "@/lib/canvas/types";

interface LLMNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

/** LLM 节点 body —— 输入框 + 回复展示,失焦回写 payload.text。 */
function LLMNodeBodyImpl({ data, nodeId }: LLMNodeBodyProps) {
  const updateNodePayload = useCanvasStore((s) => s.updateNodePayload);
  const payload = data.payload as LLMPayload;

  const onBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      if (next === payload.text) return;
      void updateNodePayload(nodeId, { text: next });
    },
    [nodeId, payload.text, updateNodePayload],
  );

  return (
    <>
      <div className="tn-field">
        <label className="tn-field-label">输入</label>
        <textarea
          className="tn-textarea"
          rows={3}
          defaultValue={payload.text}
          onBlur={onBlur}
          placeholder="向 LLM 提问…"
          spellCheck={false}
        />
      </div>
      <div className="tn-field">
        <label className="tn-field-label">回复</label>
        {payload.response ? (
          <div className="tn-response">{payload.response}</div>
        ) : (
          <div className="tn-response tn-response-empty">
            点击右上角 ▶ 运行,等待 LLM 回复
          </div>
        )}
      </div>
    </>
  );
}

// 只比较渲染用到的关键字段:payload.text / payload.response / status
export const LLMNodeBody = memo(LLMNodeBodyImpl, (prev, next) => {
  if (prev.nodeId !== next.nodeId || prev.data.status !== next.data.status) {
    return false;
  }
  const pp = prev.data.payload as LLMPayload;
  const np = next.data.payload as LLMPayload;
  return pp.text === np.text && pp.response === np.response;
});
