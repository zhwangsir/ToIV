"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchEngines, type EngineInfo, type EngineKind } from "@/lib/engines";
import { confirmAge, isAgeConfirmed, useR18Mode } from "@/lib/r18";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
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

/** 版本行数据源:/version.json(运行时读 .next/BUILD_ID 的部署指纹,
 *  格式 YYYYMMDD-HHmmss-<git短sha>;2026-08-30 批 D 替换硬编码 APP_VERSION,
 *  与部署侧实际构建一致,回滚后指纹同步回滚不撒谎)。拉取失败显示 —。 */
function useBuildVersion(): string | null {
  const [buildId, setBuildId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/version.json", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ buildId?: string | null }>) : null))
      .then((d) => {
        if (live) setBuildId(d?.buildId ?? null);
      })
      .catch(() => {
        if (live) setBuildId(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return buildId;
}

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
  const buildId = useBuildVersion();

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
      <div className="settings-grid">
        {/* ── 账户 ── */}
        <section className="settings-card" aria-labelledby="settings-account">
          <h2 className="settings-card-title" id="settings-account">
            <span className="settings-card-icon" aria-hidden="true">
              <Icon name="user" size={14} strokeWidth={1.8} />
            </span>
            账户
          </h2>
          {/* 横向紧凑行(2026-08-16 批 2):头像 + 邮箱 + 退出按钮一行,
              与界面卡视觉对齐,不再单行键值占半宽大卡 */}
          <div className="settings-account-row">
            <span className="settings-account-avatar" aria-hidden="true">
              <Icon name="user" size={16} strokeWidth={1.6} />
            </span>
            <span className="settings-account-mail" translate="no">
              {account ?? "—"}
            </span>
            {onLogout && (
              <Button
                variant="danger"
                size="sm"
                icon={<Icon name="close" size={13} />}
                onClick={onLogout}
              >
                退出登录
              </Button>
            )}
          </div>
          <p className="settings-account-desc">
            修改密码暂未开放;退出登录后可切换账户
          </p>
        </section>

        {/* ── 界面 ── */}
        <section className="settings-card" aria-labelledby="settings-ui">
          <h2 className="settings-card-title" id="settings-ui">
            <span className="settings-card-icon" aria-hidden="true">
              <Icon name="palette" size={14} strokeWidth={1.8} />
            </span>
            界面
          </h2>
          <p className="settings-ui-desc">
            模式与色板即时生效,并同步到所有已打开的标签页;自定义强调色优先级最高。
          </p>
          <ThemePicker />
        </section>

        {/* ── 内容偏好(R18 全局模式,M9 F4) ── */}
        <section className="settings-card at-card at-card--lift" aria-labelledby="settings-content-pref">
          <h2 className="settings-card-title" id="settings-content-pref">
            <span className="settings-card-icon" aria-hidden="true">
              <Icon name="eye" size={14} strokeWidth={1.8} />
            </span>
            内容偏好
          </h2>
          <div className="settings-r18-row">
            <p className="settings-r18-desc">
              开启后全站展示成人向(R18)生成引擎、作品与推荐模型;产物仅自己可见,请遵守当地法规
            </p>
            {/* 18+ 徽章与开关收拢(2026-08-16 批 2):同一行内,间距 --space-2 */}
            <span className="settings-r18-side">
              <span className="settings-r18-badge">18+</span>
              <span className="settings-r18-switch">
                <Switch
                  checked={r18}
                  onChange={handleR18Change}
                  ariaLabel="R18 成人内容模式"
                />
              </span>
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
            {/* 页头「刷新状态」收编至此(2026-09-02 W3 页头移除):标题行尾 ghost 图标钮 */}
            <button
              type="button"
              className="settings-title-action"
              aria-label="刷新引擎状态"
              title="刷新引擎状态"
              onClick={loadEngines}
            >
              <Icon name="refresh" size={13} />
            </button>
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
                            className={`at-badge settings-engine-state${
                              e.available ? " at-badge--ok" : " at-badge--err"
                            }`}
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
              <span className="settings-row-value">{buildId ?? "—"}</span>
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
