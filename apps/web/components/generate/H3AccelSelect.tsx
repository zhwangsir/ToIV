"use client";

/**
 * H3 智能加速选择器(2026-09-12):关闭 / 无损加速 / 甜点位 / 极限。
 * 应用运行台(AppRunnerView)与引擎工作台(EngineStudioView)复用;
 * 倍率经 lib/h3Accel 拉后端实测规格,缺失时回落社区参考值并注明。
 * 样式:styled-jsx global + h3accel- 前缀(多组件文件纪律,P-2b)。
 */

import { useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import {
  fetchH3AccelProfiles,
  h3AccelOptions,
  type H3AccelLevel,
  type H3AccelProfileInfo,
} from "@/lib/h3Accel";

const TOOLTIP =
  "智能加速在提交前改写 H3 采样图换取速度:无损加速质量基本无损;甜点位为速度/质量平衡;" +
  "极限加速最快但质量可能有可见损失。倍率来自集群实测(标注「实测」)或社区参考值(标注「参考」)。";

export function H3AccelSelect({
  value,
  onChange,
  disabled,
}: {
  value: H3AccelLevel;
  onChange: (level: H3AccelLevel) => void;
  disabled?: boolean;
}) {
  const [profiles, setProfiles] = useState<readonly H3AccelProfileInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchH3AccelProfiles().then((p) => {
      if (alive) setProfiles(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const options = h3AccelOptions(profiles ?? []);
  const active = options.find((o) => o.value === value);

  return (
    <div className="h3accel-field">
      <span className="h3accel-label" title={TOOLTIP}>
        <Icon name="zap" size={12} />
        智能加速
        <Icon name="info" size={11} />
      </span>
      <select
        className="h3accel-select"
        aria-label="智能加速"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as H3AccelLevel)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.hint} disabled={o.unavailable}>
            {o.label}
          </option>
        ))}
      </select>
      {value !== "off" && active && (
        <span className="h3accel-hint" role="note">
          {active.hint}
        </span>
      )}
      <style jsx global>{`
        .h3accel-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 4px 0 2px;
        }
        .h3accel-label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 12px;
          font-weight: 500;
          color: var(--text-secondary, #9aa3af);
          cursor: help;
        }
        .h3accel-select {
          width: 100%;
          height: 34px;
          padding: 0 10px;
          border-radius: 8px;
          border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
          background: var(--bg-secondary, rgba(255, 255, 255, 0.04));
          color: var(--text-primary, #e5e7eb);
          font-size: 13px;
          outline: none;
        }
        .h3accel-select:focus-visible {
          border-color: var(--accent-color, #c9f24f);
        }
        .h3accel-select:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .h3accel-hint {
          font-size: 11px;
          line-height: 1.5;
          color: var(--text-tertiary, #6b7280);
        }
      `}</style>
    </div>
  );
}
