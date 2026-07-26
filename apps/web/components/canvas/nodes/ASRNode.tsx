"use client";

import { memo, useCallback } from "react";
import { Icon } from "@/components/ui/Icon";
import { imageUrl } from "@/lib/api";
import { useCanvasStore } from "@/lib/canvas/store";
import type { CanvasNodeData, ASRPayload } from "@/lib/canvas/types";

interface ASRNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

/** ASR 听写节点 body —— 音频文件展示 + 听写结果,失焦回写 payload.audio_url。 */
function ASRNodeBodyImpl({ data, nodeId }: ASRNodeBodyProps) {
  const updateNodePayload = useCanvasStore((s) => s.updateNodePayload);
  const payload = data.payload as ASRPayload;

  const onUrlBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      const next = e.target.value.trim();
      if (next === (payload.audio_url ?? "")) return;
      void updateNodePayload(nodeId, { audio_url: next });
    },
    [nodeId, payload.audio_url, updateNodePayload],
  );

  return (
    <>
      <div className="tn-field">
        <label className="tn-field-label">音频路径</label>
        <input
          className="tn-input"
          type="text"
          defaultValue={payload.audio_url ?? ""}
          onBlur={onUrlBlur}
          placeholder="/uploads/asr/xxx.wav"
          spellCheck={false}
        />
      </div>
      {payload.audio_url && (
        <div className="tn-media" style={{ minHeight: 40, padding: "0.3rem" }}>
          <audio
            src={imageUrl(payload.audio_url)}
            controls
            preload="metadata"
            style={{ width: "100%" }}
          />
        </div>
      )}
      <div className="tn-field">
        <label className="tn-field-label">听写结果</label>
        {payload.text ? (
          <div className="tn-response">{payload.text}</div>
        ) : (
          <div className="tn-response tn-response-empty">
            <Icon name="audio" size={11} strokeWidth={1.6} /> 点击右上角 ▶ 开始听写
          </div>
        )}
      </div>
    </>
  );
}

// 只比较渲染用到的关键字段:payload.audio_url / payload.text / status
export const ASRNodeBody = memo(ASRNodeBodyImpl, (prev, next) => {
  if (prev.nodeId !== next.nodeId || prev.data.status !== next.data.status) {
    return false;
  }
  const pp = prev.data.payload as ASRPayload;
  const np = next.data.payload as ASRPayload;
  return pp.audio_url === np.audio_url && pp.text === np.text;
});
