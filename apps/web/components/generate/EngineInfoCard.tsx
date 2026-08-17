"use client";

import type { EngineInfo } from "@/lib/engines";

interface EngineInfoCardProps {
  engine: EngineInfo;
}

/**
 * 引擎说明卡(T2,2026-08-17):「所有模型要有说明」的 UI 承载。
 * 内容全部来自引擎注册表响应(EngineInfo):description + source(name/url/author/note)
 * + 参数个数概览。由 GenerateView 引擎行的 ⓘ 按钮经 ui/Popover 弹出(点击展开,移动端同可用)。
 * 纯展示无 hooks,单测可直接调用/静态渲染。
 */
export function EngineInfoCard({ engine }: EngineInfoCardProps) {
  const src = engine.source;
  return (
    <div className="engine-info-card">
      <div className="engine-info-head">
        <span className="engine-info-name">{engine.label}</span>
        <span className="engine-info-count">{engine.params.length} 项参数</span>
      </div>
      {engine.description && <p className="engine-info-desc">{engine.description}</p>}
      {src && (
        <div className="engine-info-source">
          <span className="engine-info-source-line">
            出处:
            {src.url ? (
              <a href={src.url} target="_blank" rel="noopener noreferrer">
                {src.name}
              </a>
            ) : (
              <span>{src.name}</span>
            )}
            <span> · {src.author}</span>
          </span>
          {src.note && <p className="engine-info-note">{src.note}</p>}
        </div>
      )}
    </div>
  );
}
