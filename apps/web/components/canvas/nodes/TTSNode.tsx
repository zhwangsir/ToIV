"use client";

import { memo, useCallback } from "react";
import { Icon } from "@/components/ui/Icon";
import { imageUrl } from "@/lib/api";
import { useCanvasStore } from "@/lib/canvas/store";
import type { CanvasNodeData, TTSPayload } from "@/lib/canvas/types";

interface TTSNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

/** TTS 节点 body —— text / emo_text / ref_audio 输入 + 合成结果音频播放。 */
function TTSNodeBodyImpl({ data, nodeId }: TTSNodeBodyProps) {
  const updateNodePayload = useCanvasStore((s) => s.updateNodePayload);
  const payload = data.payload as TTSPayload;

  const onTextBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      if (next === payload.text) return;
      void updateNodePayload(nodeId, { text: next });
    },
    [nodeId, payload.text, updateNodePayload],
  );

  const onEmoBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      if (next === (payload.emo_text ?? "")) return;
      void updateNodePayload(nodeId, { emo_text: next });
    },
    [nodeId, payload.emo_text, updateNodePayload],
  );

  return (
    <>
      <div className="tn-field">
        <label className="tn-field-label">文本</label>
        <textarea
          className="tn-textarea"
          rows={3}
          defaultValue={payload.text}
          onBlur={onTextBlur}
          placeholder="要朗读的文本…"
          spellCheck={false}
        />
      </div>
      <div className="tn-field">
        <label className="tn-field-label">情感文本(可选)</label>
        <textarea
          className="tn-textarea"
          rows={2}
          defaultValue={payload.emo_text ?? ""}
          onBlur={onEmoBlur}
          placeholder="参考情感文本…"
          spellCheck={false}
        />
      </div>
      {payload.ref_audio && (
        <div className="tn-file-row">
          <Icon name="audio" size={11} strokeWidth={1.6} />
          <span className="tn-file-name" title={payload.ref_audio}>
            {payload.ref_audio.split("/").pop() ?? payload.ref_audio}
          </span>
        </div>
      )}
      {payload.url ? (
        <div className="tn-media" style={{ minHeight: 40, padding: "0.3rem" }}>
          <audio
            src={imageUrl(payload.url)}
            controls
            preload="metadata"
            style={{ width: "100%" }}
          />
        </div>
      ) : (
        <div className="tn-response tn-response-empty">
          点击右上角 ▶ 合成语音
        </div>
      )}
    </>
  );
}

// 只比较渲染用到的关键字段:payload.text / emo_text / ref_audio / url / status
export const TTSNodeBody = memo(TTSNodeBodyImpl, (prev, next) => {
  if (prev.nodeId !== next.nodeId || prev.data.status !== next.data.status) {
    return false;
  }
  const pp = prev.data.payload as TTSPayload;
  const np = next.data.payload as TTSPayload;
  return (
    pp.text === np.text &&
    pp.emo_text === np.emo_text &&
    pp.ref_audio === np.ref_audio &&
    pp.url === np.url
  );
});
