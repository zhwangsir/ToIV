"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchEngines, type EngineInfo, type EngineKind } from "@/lib/engines";
import { confirmAge, isAgeConfirmed, useR18Mode } from "@/lib/r18";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { PageHeader } from "@/components/ui/PageHeader";
import { Switch } from "@/components/ui/Switch";
import { AgeGateModal } from "@/components/ui/AgeGateModal";
import { ThemePicker } from "@/components/ui/ThemePicker";
import "@/app/styles/settings.css";

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
 * 页头走全局 .page-header*(大标题 + 描述 + 右侧操作区);四张分区卡:账户 / 界面 /
 * 引擎状态(只读,走查 #17 GPU worker 状态卡落点,横排分组)/ 关于(通栏三列)。
 * 样式全部在 app/styles/settings.css;修改密码后端无现成端点,按方案只展示账户信息 + 登出。
 */
export function SettingsView({ account, onLogout }: SettingsViewProps) {
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  // R18 全局内容模式(M9 F4):开关状态 + 18+ 年龄确认弹层显隐
  const [r18, setR18Mode] = useR18Mode();
  const [ageGateOpen, setAgeGateOpen] = useState(false);

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

  // 开启前须过年龄确认(仅首次);取消不动,关闭直接生效
  const handleR18Change = useCallback((on: boolean) => {
    if (!on) {
      setR18Mode(false);
      return;
    }
    if (isAgeConfirmed()) {
      setR18Mode(true);
      return;
    }
    setAgeGateOpen(true);
  }, [setR18Mode]);

  const handleAgeConfirm = useCallback(() => {
    confirmAge();
    setR18Mode(true);
    setAgeGateOpen(false);
  }, [setR18Mode]);

  return (
    <div className="single-view settings-view">
      <PageHeader
        title="设置"
        desc="账户、界面主题与推理引擎状态总览"
        icon="settings"
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="refresh" size={13} />}
            onClick={loadEngines}
          >
            刷新状态
          </Button>
        }
      />

      <div className="settings-grid">
        {/* ── 账户 ── */}
        <section className="settings-card" aria-labelledby="settings-account">
          <h2 className="settings-card-title" id="settings-account">
            <span className="settings-card-icon" aria-hidden="true">
              <Icon name="user" size={14} strokeWidth={1.8} />
            </span>
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
            <span className="settings-card-icon" aria-hidden="true">
              <Icon name="palette" size={14} strokeWidth={1.8} />
            </span>
            界面
          </h2>
          <ThemePicker />
        </section>

        {/* ── 内容偏好(R18 全局模式,M9 F4) ── */}
        <section className="settings-card" aria-labelledby="settings-content-pref">
          <h2 className="settings-card-title" id="settings-content-pref">
            <span className="settings-card-icon" aria-hidden="true">
              <Icon name="eye" size={14} strokeWidth={1.8} />
            </span>
            内容偏好
            <span className="settings-r18-badge">18+</span>
          </h2>
          <div className="settings-r18-row">
            <p className="settings-r18-desc">
              开启后全站展示成人向(R18)生成引擎、作品与推荐模型;产物仅自己可见,请遵守当地法规
            </p>
            <span className="settings-r18-switch">
              <Switch
                checked={r18}
                onChange={handleR18Change}
                ariaLabel="R18 成人内容模式"
              />
            </span>
          </div>
        </section>

        {/* ── 引擎状态(只读) ── */}
        <section
          className="settings-card settings-card--wide"
          aria-labelledby="settings-engines"
        >
          <h2 className="settings-card-title" id="settings-engines">
            <span className="settings-card-icon" aria-hidden="true">
              <Icon name="cpu" size={14} strokeWidth={1.8} />
            </span>
            引擎状态
          </h2>
          {enginesError ? (
            <div className="settings-engines-error">
              {/* 错误态(UI-A ErrorBar):role=alert + 可关闭;重试保留在条外 */}
              <ErrorBar message={enginesError} onClose={() => setEnginesError(null)} />
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
            /* 加载态(UI-A LoadingBlock):行骨架;role=status 保留在容器上 */
            <div role="status" aria-label="引擎状态加载中">
              <LoadingBlock variant="line" count={3} />
            </div>
          ) : engines.length === 0 ? (
            <div className="settings-engines-empty">
              <Icon name="cpu" size={18} strokeWidth={1.6} />
              <p>暂无已注册引擎</p>
            </div>
          ) : (
            <div className="settings-engine-groups">
              {KIND_ORDER.map((kind) => {
                const list = engines.filter((e) => e.kind === kind);
                if (list.length === 0) return null;
                return (
                  <div key={kind} className="settings-engine-group">
                    <div className="settings-engine-group-head">
                      <span className="settings-engine-kind">{KIND_LABEL[kind]}</span>
                      <span className="settings-engine-count">{list.length}</span>
                    </div>
                    <ul className="settings-engine-list">
                      {list.map((e) => (
                        <li key={e.id} className="settings-engine-item">
                          <span
                            className={`settings-engine-dot${e.available ? " is-ok" : " is-err"}`}
                            aria-hidden="true"
                          />
                          <span className="settings-engine-label">{e.label}</span>
                          <span
                            className={`settings-engine-state${e.available ? " is-ok" : " is-err"}`}
                          >
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
        <section
          className="settings-card settings-card--wide"
          aria-labelledby="settings-about"
        >
          <h2 className="settings-card-title" id="settings-about">
            <span className="settings-card-icon" aria-hidden="true">
              <Icon name="info" size={14} strokeWidth={1.8} />
            </span>
            关于
          </h2>
          <div className="settings-about-grid">
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
          </div>
        </section>
      </div>

      <AgeGateModal
        open={ageGateOpen}
        onConfirm={handleAgeConfirm}
        onCancel={() => setAgeGateOpen(false)}
      />
    </div>
  );
}
