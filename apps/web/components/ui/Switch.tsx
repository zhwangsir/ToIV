"use client";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  ariaLabel?: string;
}

/** 开关:36×20 轨道,开启态 accent + 微光晕。 */
export function Switch({ checked, onChange, disabled, label, ariaLabel }: SwitchProps) {
  const toggle = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      disabled={disabled}
      className={`ui-switch${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-thumb" aria-hidden="true" />
    </button>
  );
  return (
    <span className="ui-switch-wrap">
      {toggle}
      {label && (
        <span
          className="ui-switch-label"
          onClick={() => !disabled && onChange(!checked)}
        >
          {label}
        </span>
      )}
      <style jsx global>{`
        .ui-switch-wrap {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
        }
        .ui-switch-label {
          font-size: var(--text-sm);
          color: var(--text-secondary);
          cursor: pointer;
        }
        .ui-switch {
          position: relative;
          width: 36px;
          height: 20px;
          padding: 0;
          border-radius: var(--radius-full);
          background: var(--bg-surface-3);
          border: 1px solid var(--border-subtle);
          cursor: pointer;
          flex-shrink: 0;
          transition: background-color var(--duration-fast) var(--ease-standard),
                      border-color var(--duration-fast) var(--ease-standard),
                      box-shadow var(--duration-fast) var(--ease-standard);
        }
        .ui-switch:hover:not(:disabled) {
          border-color: var(--border-strong);
        }
        .ui-switch.is-on {
          background: var(--accent);
          border-color: var(--accent);
          box-shadow: var(--accent-glow-shadow);
        }
        .ui-switch:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .ui-switch-thumb {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--text-secondary);
          transition: transform var(--duration-fast) var(--ease-standard),
                      background-color var(--duration-fast) var(--ease-standard);
        }
        .ui-switch.is-on .ui-switch-thumb {
          transform: translateX(16px);
          background: var(--text-primary);
        }
      `}</style>
    </span>
  );
}
