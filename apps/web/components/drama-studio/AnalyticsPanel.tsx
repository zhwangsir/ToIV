"use client";

import { Icon } from "@/components/ui/Icon";
import { usePlaybackInsights } from "@/hooks/usePlaybackInsights";

interface AnalyticsPanelProps {
  projectId: string;
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function percent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function heatClass(score: number): string {
  if (score >= 75) return "hot";
  if (score >= 45) return "warm";
  return "cold";
}

export function AnalyticsPanel({ projectId }: AnalyticsPanelProps) {
  const { data, loading, error, refresh } = usePlaybackInsights(projectId);

  if (loading) {
    return (
      <div className="ds-analytics-empty">
        <Icon name="loading" size={20} className="ds-spin" />
        <span>正在分析播放数据…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ds-analytics-empty">
        <Icon name="error" size={20} />
        <span>{error}</span>
        <button type="button" className="btn btn-sm" onClick={refresh}>
          <Icon name="refresh" size={12} /> 重试
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="ds-analytics-empty">
        <Icon name="barchart" size={32} strokeWidth={1.2} />
        <span>暂无播放洞察数据</span>
      </div>
    );
  }

  const { project, shots } = data;
  const lowConfidence = project.sessions < 10;

  return (
    <div className="ds-analytics-section">
      <div className="ds-section-head">
        <h3 className="ds-section-title">
          <Icon name="barchart" size={16} />
          播放洞察
        </h3>
        <span className="ds-section-hint">
          基于 {project.sessions} 次播放 · {new Date(data.generated_at).toLocaleString("zh-CN")}
        </span>
        <button type="button" className="btn btn-sm" onClick={refresh}>
          <Icon name="refresh" size={12} /> 刷新
        </button>
      </div>

      {lowConfidence && (
        <div className="ds-analytics-card" style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <Icon name="info" size={14} />
          <span style={{ fontSize: "0.75rem", color: "var(--ink2)" }}>
            当前样本量较少，累计更多播放后建议会更稳定。
          </span>
        </div>
      )}

      <div className="ds-analytics-summary">
        <div className="ds-analytics-card">
          <span className="ds-analytics-value">{project.sessions}</span>
          <span className="ds-analytics-label">播放会话</span>
        </div>
        <div className="ds-analytics-card">
          <span className="ds-analytics-value">{percent(project.completion_rate)}</span>
          <span className="ds-analytics-label">完播率</span>
        </div>
        <div className="ds-analytics-card">
          <span className="ds-analytics-value">{formatDuration(project.avg_watch_sec)}</span>
          <span className="ds-analytics-label">平均观看</span>
        </div>
        <div className="ds-analytics-card">
          <span className="ds-analytics-value">{percent(project.engagement_rate)}</span>
          <span className="ds-analytics-label">互动率</span>
        </div>
      </div>

      {shots.length === 0 ? (
        <div className="ds-empty">该项目还没有分镜，拆解后可见数据。</div>
      ) : (
        <div className="ds-analytics-list">
          {shots.map((shot) => (
            <div key={shot.shot_id} className={`ds-analytics-shot ${heatClass(shot.heat_score)}`}>
              <div className="ds-analytics-shot-main">
                <div className="ds-analytics-shot-head">
                  <span className="ds-analytics-idx">#{shot.idx + 1}</span>
                  <span className="ds-analytics-scene" title={shot.scene}>
                    {shot.scene || "未命名分镜"}
                  </span>
                  <span className="ds-analytics-time">
                    {formatDuration(shot.start_sec)} -{" "}
                    {formatDuration(shot.start_sec + shot.duration_sec)}
                  </span>
                </div>
                <div className="ds-analytics-heat">
                  <div className="ds-analytics-heat-bar">
                    <div
                      className="ds-analytics-heat-fill"
                      style={{ width: `${Math.min(100, Math.max(0, shot.heat_score))}%` }}
                    />
                  </div>
                  <span className="ds-analytics-heat-score">{shot.heat_score.toFixed(1)}</span>
                </div>
              </div>

              <div className="ds-analytics-metrics">
                <span title="进入该镜的会话数">
                  <Icon name="eye" size={11} /> {shot.enters}
                </span>
                <span title="留存率">↳ {percent(shot.retention)}</span>
                <span title="完播率">▶ {percent(shot.completion_rate)}</span>
                <span title="重播">
                  <Icon name="refresh" size={11} /> {shot.replay_count}
                </span>
                <span title="点赞">
                  <Icon name="success" size={11} /> {shot.like_count}
                </span>
                {shot.drop_offs > 0 && (
                  <span className="ds-analytics-drop" title="该镜流失数">
                    <Icon name="alert" size={11} /> {shot.drop_offs}
                  </span>
                )}
              </div>

              {shot.suggestions.length > 0 && (
                <ul className="ds-analytics-suggestions">
                  {shot.suggestions.map((s, i) => (
                    <li key={i}>
                      <Icon name="info" size={11} />
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
