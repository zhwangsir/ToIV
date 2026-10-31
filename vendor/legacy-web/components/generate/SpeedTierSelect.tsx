"use client";

/**
 * 速度分档段控(INTENT e):快速 | 精细。
 * 应用运行台 / 引擎工作台复用;少字、图标优先;localStorage 由调用方读写。
 */

import { Icon } from "@/components/ui/Icon";
import { labelSpeedTier, type SpeedTier } from "@/lib/speedTier";

const OPTIONS: { value: SpeedTier; icon: "zap" | "sparkles" }[] = [
  { value: "fast", icon: "zap" },
  { value: "quality", icon: "sparkles" },
];

export function SpeedTierSelect({
  value,
  onChange,
  disabled,
}: {
  value: SpeedTier;
  onChange: (tier: SpeedTier) => void;
  disabled?: boolean;
}) {
  return (
    <div className="speed-tier-field" role="group" aria-label="速度">
      <span className="speed-tier-label">
        <Icon name="sliders" size={12} />
        速度
      </span>
      <div className="speed-tier-seg">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`speed-tier-btn${value === o.value ? " is-active" : ""}`}
            aria-pressed={value === o.value}
            disabled={disabled}
            onClick={() => onChange(o.value)}
          >
            <Icon name={o.icon} size={13} />
            {labelSpeedTier(o.value)}
          </button>
        ))}
      </div>
      <style jsx global>{`
        .speed-tier-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 4px 0 2px;
        }
        .speed-tier-label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 12px;
          font-weight: 500;
          color: var(--text-secondary, #9aa3af);
        }
        .speed-tier-seg {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0;
          border-radius: var(--radius-control);
          border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
          overflow: hidden;
          background: var(--bg-secondary, rgba(255, 255, 255, 0.04));
        }
        .speed-tier-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          height: 34px;
          border: 0;
          background: transparent;
          color: var(--text-secondary, #9aa3af);
          font-size: 13px;
          cursor: pointer;
        }
        .speed-tier-btn + .speed-tier-btn {
          border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
        }
        .speed-tier-btn.is-active {
          background: rgba(201, 242, 79, 0.14);
          color: var(--text-primary, #e5e7eb);
          font-weight: 600;
        }
        .speed-tier-btn:hover:not(:disabled):not(.is-active) {
          background: rgba(255, 255, 255, 0.04);
        }
        .speed-tier-btn:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
