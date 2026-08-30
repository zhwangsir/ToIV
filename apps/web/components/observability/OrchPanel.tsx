"use client";

import { useCallback, useEffect, useState } from "react";

import "@/app/styles/observability.css";

import {
  fetchOrchServices,
  wakeOrchService,
  type OrchService,
} from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Empty } from "@/components/ui/Empty";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";

/** 与观测面板同一轮询节奏(12s)。 */
const POLL_MS = 12_000;

/* ─────────────────────────── 纯函数(可测) ─────────────────────────── */

export type OrchStatusTone = "ok" | "warn" | "neutral" | "err";

/** 状态 → Badge 音色:running 绿 / waking 黄 / sleeping 灰 / stopped 深灰 / error 红。 */
export function orchStatusTone(status: OrchService["status"]): OrchStatusTone {
  switch (status) {
    case "running":
      return "ok";
    case "waking":
      return "warn";
    case "error":
      return "err";
    case "sleeping":
    case "stopped":
    default:
      return "neutral";
  }
}

export function orchStatusLabel(status: OrchService["status"]): string {
  switch (status) {
    case "running":
      return "运行中";
    case "waking":
      return "唤醒中";
    case "sleeping":
      return "休眠";
    case "stopped":
      return "已停止";
    case "error":
      return "错误";
    default:
      return status;
  }
}

/** 相对时间:「2 分钟前」「1 小时前」;null → 「—」。 */
export function formatRelTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} 小时前`;
  return `${Math.floor(diffH / 24)} 天前`;
}

/** 闲置时长:「2 分钟」「1 小时」;null → 「—」。 */
export function formatIdle(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${Math.floor(sec)} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/** 截断错误文案:单行 64 字符,溢出省略。 */
export function truncateError(msg: string, max = 64): string {
  const s = msg.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 汇总计数:running / waking / total。 */
export function orchSummary(services: OrchService[]): {
  running: number;
  waking: number;
  total: number;
} {
  return {
    running: services.filter((s) => s.status === "running").length,
    waking: services.filter((s) => s.status === "waking").length,
    total: services.length,
  };
}

/* ─────────────────────────── 子组件 ─────────────────────────── */

function OrchCard({
  service,
  isAdmin,
  onWake,
}: {
  service: OrchService;
  isAdmin: boolean;
  onWake: (name: string) => Promise<void>;
}) {
  const [waking, setWaking] = useState(false);
  const tone = orchStatusTone(service.status);
  const canWake = isAdmin && (service.status === "sleeping" || service.status === "stopped" || service.status === "error");

  const handleWake = async () => {
    setWaking(true);
    try {
      await onWake(service.name);
    } finally {
      setWaking(false);
    }
  };

  return (
    <article className={`obs-orch-card obs-orch-card--${service.status}`} aria-label={`${service.name} 服务卡片`}>
      <header className="obs-orch-card-head">
        <Badge
          tone={tone}
          dot
          dotPulse={service.status === "running" || service.status === "waking"}
          className={`obs-orch-badge obs-orch-badge--${service.status}`}
        >
          {orchStatusLabel(service.status)}
        </Badge>
        <h3 className="obs-orch-name">{service.name}</h3>
      </header>
      <p className="obs-orch-unit" title={service.systemd_unit}>
        {service.systemd_unit}
      </p>
      <dl className="obs-orch-meta">
        <div className="obs-orch-meta-item">
          <dt>最近请求</dt>
          <dd>{formatRelTime(service.last_request_at)}</dd>
        </div>
        <div className="obs-orch-meta-item">
          <dt>闲置</dt>
          <dd>{formatIdle(service.idle_sec)}</dd>
        </div>
        <div className="obs-orch-meta-item">
          <dt>启 / 停</dt>
          <dd>
            {service.wake_count} / {service.stop_count}
          </dd>
        </div>
      </dl>
      {service.last_error && (
        <p className="obs-orch-error" title={service.last_error}>
          <Icon name="alert" size={14} aria-hidden="true" />
          <span>{truncateError(service.last_error)}</span>
        </p>
      )}
      <footer className="obs-orch-actions">
        {isAdmin ? (
          <Button
            size="sm"
            variant={canWake ? "primary" : "ghost"}
            disabled={!canWake || waking}
            loading={waking}
            icon={<Icon name="zap" size={14} />}
            onClick={handleWake}
            aria-label={`唤醒 ${service.name}`}
          >
            手动唤醒
          </Button>
        ) : (
          <span className="obs-orch-perm-hint" title="需要管理员权限">
            <Icon name="lock" size={14} aria-hidden="true" />
            唤醒需管理员
          </span>
        )}
      </footer>
    </article>
  );
}

/* ─────────────────────────── 主组件 ─────────────────────────── */

export function OrchPanel({ isAdmin = false }: { isAdmin?: boolean }) {
  const [services, setServices] = useState<OrchService[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    try {
      const payload = await fetchOrchServices();
      setServices(payload.services);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载编排服务失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const handleWake = async (name: string) => {
    try {
      const updated = await wakeOrchService(name);
      setServices((prev) =>
        prev ? prev.map((s) => (s.name === name ? updated : s)) : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "唤醒服务失败");
    }
  };

  const summary = services ? orchSummary(services) : null;

  return (
    <section className="obs-orch" aria-label="编排状态">
      {/* 汇总条 */}
      <div className="obs-orch-summary">
        {loading && !summary ? (
          <>
            <Skeleton width={80} height={24} className="obs-orch-summary-skel" />
            <Skeleton width={80} height={24} className="obs-orch-summary-skel" />
            <Skeleton width={80} height={24} className="obs-orch-summary-skel" />
          </>
        ) : summary ? (
          <>
            <span className="obs-orch-summary-item">
              <span className="obs-orch-summary-dot is-ok" aria-hidden="true" />
              运行 {summary.running}
            </span>
            <span className="obs-orch-summary-item">
              <span className="obs-orch-summary-dot is-warn" aria-hidden="true" />
              唤醒中 {summary.waking}
            </span>
            <span className="obs-orch-summary-item">
              <span className="obs-orch-summary-dot is-muted" aria-hidden="true" />
              共 {summary.total}
            </span>
          </>
        ) : null}
      </div>

      {error && <ErrorBar message={error} onClose={() => setError(null)} />}

      {loading && !services ? (
        <div className="obs-orch-grid" aria-label="编排服务加载中">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={180} className="obs-orch-skel" />
          ))}
        </div>
      ) : services && services.length === 0 ? (
        <Empty
          icon="box"
          title="暂无编排服务"
          desc="冷层服务未注册或已全部退役"
        />
      ) : services ? (
        <div className="obs-orch-grid">
          {services.map((s) => (
            <OrchCard key={s.name} service={s} isAdmin={isAdmin} onWake={handleWake} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
