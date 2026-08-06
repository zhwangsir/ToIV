"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchEngines, type EngineInfo, type EngineKind } from "@/lib/engines";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { ThemePicker } from "@/components/ui/ThemePicker";

const KIND_ORDER: EngineKind[] = ["image", "video", "audio"];
const KIND_LABEL: Record<EngineKind, string> = {
  image: "图像",
  video: "视频",
  audio: "音频",
};

/** 产品版本(与 apps/web/package.json 同步;package.json 不在 tsconfig include 内,无法直接 import)。 */
const APP_VERSION = "0.0.1";

interface SettingsViewProps {
  account?: string | null;
  onLogout?: () => void;
}

/**
 * 设置视图(重构方案 §4.9):工作台版版型(页标题 + max-width 1200,走 .single-view)。
 * 四组卡片:账户 / 界面 / 引擎状态(只读,走查 #17 GPU worker 状态卡落点)/ 关于。
 * 样式全部在 app/styles/settings.css;修改密码后端无现成端点,按方案只展示账户信息 + 登出。
 */
export function SettingsView({ account, onLogout }: SettingsViewProps) {
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [enginesError, setEnginesError] = useState<string | null>(null);

  const loadEngines = useCallback(() => {
    setEnginesError(null);
    fetchEngines()
      .then(setEngines)
      .catch((err) =>
        setEnginesError(err instanceof Error ? err.message : "加载引擎状态失败"),
      );
  }, []);

  useEffect(() => {
    loadEngines();
  }, [loadEngines]);

  return (
    <div className="single-view settings-view">
      <header className="settings-header">
        <h1 className="settings-title">设置</h1>
      </header>

      <div className="settings-grid">
        {/* ── 账户 ── */}
        <section className="settings-card" aria-labelledby="settings-account">
          <h2 className="settings-card-title" id="settings-account">
            <Icon name="user" size={15} strokeWidth={1.8} />
            账户
          </h2>
          <div className="settings-row">
            <span className="settings-row-label">当前邮箱</span>
            <span className="settings-row-value" translate="no">
              {account ?? "—"}
            </span>
          </div>
          {onLogout && (
            <div className="settings-actions">
              <Button
                variant="danger"
                size="sm"
                icon={<Icon name="close" size={13} />}
                onClick={onLogout}
              >
                退出登录
              </Button>
            </div>
          )}
        </section>

        {/* ── 界面 ── */}
        <section className="settings-card" aria-labelledby="settings-ui">
          <h2 className="settings-card-title" id="settings-ui">
            <Icon name="palette" size={15} strokeWidth={1.8} />
            界面
          </h2>
          <ThemePicker />
        </section>

        {/* ── 引擎状态(只读) ── */}
        <section
          className="settings-card settings-card--wide"
          aria-labelledby="settings-engines"
        >
          <h2 className="settings-card-title" id="settings-engines">
            <Icon name="cpu" size={15} strokeWidth={1.8} />
            引擎状态
          </h2>
          {enginesError ? (
            <div className="settings-engines-error" role="alert">
              <span>{enginesError}</span>
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="refresh" size={13} />}
                onClick={loadEngines}
              >
                重试
              </Button>
            </div>
          ) : engines === null ? (
            <p className="settings-engines-loading">加载中…</p>
          ) : engines.length === 0 ? (
            <p className="settings-engines-loading">暂无已注册引擎</p>
          ) : (
            <div className="settings-engine-groups">
              {KIND_ORDER.map((kind) => {
                const list = engines.filter((e) => e.kind === kind);
                if (list.length === 0) return null;
                return (
                  <div key={kind} className="settings-engine-group">
                    <div className="settings-engine-kind">{KIND_LABEL[kind]}</div>
                    <ul className="settings-engine-list">
                      {list.map((e) => (
                        <li key={e.id} className="settings-engine-item">
                          <span
                            className={`settings-engine-dot${e.available ? " is-ok" : " is-err"}`}
                            aria-hidden="true"
                          />
                          <span className="settings-engine-label">{e.label}</span>
                          <span className="settings-engine-state">
                            {e.available ? "可用" : "不可用"}
                          </span>
                          {!e.available && e.unavailable_reason && (
                            <span className="settings-engine-reason" title={e.unavailable_reason}>
                              {e.unavailable_reason}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── 关于 ── */}
        <section className="settings-card" aria-labelledby="settings-about">
          <h2 className="settings-card-title" id="settings-about">
            <Icon name="info" size={15} strokeWidth={1.8} />
            关于
          </h2>
          <div className="settings-row">
            <span className="settings-row-label">产品</span>
            <span className="settings-row-value">ToIV — AI 创作平台</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">版本</span>
            <span className="settings-row-value">v{APP_VERSION}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">部署环境</span>
            <span className="settings-row-value">私有化部署 · 本地推理集群</span>
          </div>
        </section>
      </div>
    </div>
  );
}
