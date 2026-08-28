"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { Popover } from "@/components/ui/Popover";
import { useToast } from "@/components/ui/Toast";
import {
  fetchActiveJobs,
  invalidateJobs,
  type ActiveJobItem,
} from "@/lib/api";
import { fmtDuration, fmtEta, kindLabel, statusLineOf } from "./taskCenterUtils";

/** 轮询节奏:5s(进度强时效,后端查询本身轻量)。 */
const POLL_MS = 5_000;

export { fmtDuration, fmtEta, kindLabel, statusLineOf };

/** 单条目(纯展示,供单测)。 */
export function TaskCenterItem({ item }: { item: ActiveJobItem }) {
  const pct = item.progress.pct;
  return (
    <div className="taskcenter-item">
      <div className="taskcenter-item-head">
        <span className="taskcenter-item-kind">{kindLabel(item.kind)}</span>
        <span className="taskcenter-item-wait">已等待 {fmtDuration(item.wait_sec)}</span>
      </div>
      <div className="taskcenter-item-prompt" title={item.prompt}>
        {item.prompt || "(无提示词)"}
      </div>
      <div className="taskcenter-item-status">{statusLineOf(item)}</div>
      <div
        className={`taskcenter-bar${pct === null ? " is-indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct !== null ? { "aria-valuenow": pct } : {})}
      >
        <div
          className="taskcenter-bar-fill"
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
      <div className="taskcenter-item-eta">
        {item.eta_sec !== null ? `预计剩余 ${fmtEta(item.eta_sec)}` : "等资源释放后开始"}
      </div>
    </div>
  );
}

/**
 * 右上角任务中心(全量进度体系,2026-08-29):
 * 常驻触发器(layers 图标 + 在跑数徽标),点击弹层列出全部在跑作业
 * (排队位/step 进度/已等待/ETA);5s 轮询;任务从清单消失(完成/失败)
 * → toast 通知 + 失效作品库缓存;浏览器通知仅在已授权时追加(不主动打扰)。
 */
export function TaskCenter() {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActiveJobItem[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const toast = useToast();
  /** 上一轮在跑的 prompt_id → 状态行(完成检测基准;首轮不通知,避免进页误报)。 */
  const prevRef = useRef<Map<string, string> | null>(null);

  const tick = useCallback(async () => {
    try {
      const res = await fetchActiveJobs();
      setLoadErr(false);
      setItems(res.items);
      const now = new Map(res.items.map((i) => [i.prompt_id, statusLineOf(i)]));
      const prev = prevRef.current;
      if (prev !== null) {
        const gone: string[] = [];
        for (const pid of prev.keys()) {
          if (!now.has(pid)) gone.push(pid);
        }
        if (gone.length > 0) {
          // 消失 = 已终态(完成/失败/回收);作品库刷新后能直接看到结果
          invalidateJobs();
          const msg =
            gone.length === 1 ? "1 个生成任务已结束,作品库已更新" : `${gone.length} 个生成任务已结束,作品库已更新`;
          toast.success(msg);
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification("ToIV 生成任务", { body: msg });
          }
        }
      }
      prevRef.current = now;
    } catch {
      setLoadErr(true); // 保留旧数据,下轮自愈;失败不清空 prev(防误报完成)
    }
  }, [toast]);

  useEffect(() => {
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(t);
  }, [tick]);

  // 首次打开面板时礼貌申请浏览器通知权限(一次性;拒绝/已授权不再弹)
  useEffect(() => {
    if (!open || typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "default") return;
    if (localStorage.getItem("toiv_taskcenter_notif_asked")) return;
    localStorage.setItem("toiv_taskcenter_notif_asked", "1");
    void Notification.requestPermission().catch(() => undefined);
  }, [open]);

  const count = items.length;
  return (
    <div className="taskcenter">
      <button
        ref={btnRef}
        type="button"
        className="taskcenter-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={count > 0 ? `任务中心,${count} 个任务进行中` : "任务中心"}
        title="任务中心"
      >
        <Icon name="layers" size={15} />
        {count > 0 && (
          <span className="taskcenter-badge" aria-hidden="true">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      <Popover
        open={open}
        anchorRef={btnRef}
        onClose={() => setOpen(false)}
        width={320}
        role="dialog"
        ariaLabel="任务中心"
      >
        <div className="taskcenter-pop">
          <div className="taskcenter-pop-title">
            在跑任务{count > 0 ? `(${count})` : ""}
          </div>
          {loadErr && (
            <div className="taskcenter-empty">进度刷新失败,重试中…</div>
          )}
          {!loadErr && count === 0 && (
            <div className="taskcenter-empty">当前没有在跑的任务</div>
          )}
          {items.map((item) => (
            <TaskCenterItem key={item.prompt_id} item={item} />
          ))}
        </div>
      </Popover>
    </div>
  );
}
