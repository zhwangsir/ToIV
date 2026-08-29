"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { Popover } from "@/components/ui/Popover";
import { useToast } from "@/components/ui/Toast";
import {
  cancelJob,
  fetchActiveJobs,
  invalidateJobs,
  lookupJob,
  rerunJob,
  type ActiveJobItem,
} from "@/lib/api";
import { fmtDuration, fmtEta, kindLabel, statusLineOf } from "./taskCenterUtils";

/** 轮询节奏:5s(进度强时效,后端查询本身轻量)。 */
const POLL_MS = 5_000;
/** 失败条目保留上限(会话级,不持久化)。 */
const FAILED_CAP = 5;

export { fmtDuration, fmtEta, kindLabel, statusLineOf };

/** 单条目(展示 + 中止入口;onCancel 由容器注入,缺省纯展示供单测)。 */
export function TaskCenterItem({
  item,
  onCancel,
  canceling = false,
}: {
  item: ActiveJobItem;
  onCancel?: (item: ActiveJobItem) => void;
  canceling?: boolean;
}) {
  const pct = item.progress.pct;
  return (
    <div className="taskcenter-item">
      <div className="taskcenter-item-head">
        <span className="taskcenter-item-kind">{kindLabel(item.kind)}</span>
        {onCancel && (
          <button
            type="button"
            className="taskcenter-item-cancel"
            disabled={canceling}
            onClick={() => onCancel(item)}
            aria-label={`中止任务:${item.prompt || item.kind}`}
            title="中止该任务"
          >
            {canceling ? "中止中…" : "中止"}
          </button>
        )}
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

/** 刚结束的失败条目(带重试入口;重试成功/手动移除后消失,关页不持久)。 */
interface FailedEntry {
  /** 作品库 job id(rerun 寻址用)。 */
  jobId: string;
  promptId: string;
  kind: string;
  prompt: string;
  /** 失败原因(Wave-1 起落库的 job.error;无值兜底「生成出错」)。 */
  error: string;
  /** 有参数快照才能精确重生(旧数据无快照不重试)。 */
  canRetry: boolean;
}

/**
 * 右上角任务中心(全量进度体系,2026-08-29):
 * 常驻触发器(layers 图标 + 在跑数徽标),点击弹层列出全部在跑作业
 * (排队位/step 进度/已等待/ETA);5s 轮询;任务从清单消失(完成/失败/中止)
 * → 先 lookup 查终态再通知:done=成功 toast / error=错误 toast(透出落库原因)
 * + 失败条目(可重试)/ canceled=中止提示;浏览器通知仅在已授权时追加。
 * 每条目带「中止」按钮:确认门走 ui/Modal(2026-08-30,替代原生确认弹窗)。
 */
export function TaskCenter() {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActiveJobItem[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  /** 正在中止中的作业 id(防连点;按钮显示「中止中…」)。 */
  const [cancelingIds, setCancelingIds] = useState<ReadonlySet<string>>(new Set());
  /** 中止确认门目标(非 null 时 Modal 打开;确认后才真正调 cancel)。 */
  const [confirmItem, setConfirmItem] = useState<ActiveJobItem | null>(null);
  /** 最近失败条目(带重试入口)。 */
  const [failed, setFailed] = useState<FailedEntry[]>([]);
  /** 正在重试中的 job id(防连点)。 */
  const [retryingIds, setRetryingIds] = useState<ReadonlySet<string>>(new Set());
  const toast = useToast();
  /** 上一轮在跑的 prompt_id → 状态行(完成检测基准;首轮不通知,避免进页误报)。 */
  const prevRef = useRef<Map<string, string> | null>(null);

  /** 从清单消失的 prompt_id:逐个 lookup 查终态,按 done/error/canceled 分流通知。 */
  const notifyGone = useCallback(
    async (gone: string[]) => {
      // 作品库刷新后能直接看到结果
      invalidateJobs();
      // allSettled:单条查询抖动不影响其余终态判定(2026-08-30)
      const results = await Promise.allSettled(gone.map((pid) => lookupJob(pid)));
      let doneCount = 0;
      let canceledCount = 0;
      let unknownCount = 0;
      const failedNow: FailedEntry[] = [];
      results.forEach((r, i) => {
        const job = r.status === "fulfilled" ? r.value : null;
        if (job?.status === "done") {
          doneCount += 1;
          return;
        }
        if (job?.status === "error") {
          failedNow.push({
            jobId: job.id,
            promptId: gone[i],
            kind: job.kind,
            prompt: job.prompt ?? "",
            error: typeof job.error === "string" && job.error.trim() ? job.error.trim() : "生成出错",
            canRetry: job.has_params !== false,
          });
          return;
        }
        if (job?.status === "canceled") {
          canceledCount += 1;
          return;
        }
        // 查询失败/查不到:不冒报成功或失败,记 unknown 兜底通知
        unknownCount += 1;
      });
      if (doneCount > 0) {
        const msg =
          doneCount === 1
            ? "1 个生成任务已完成,作品库已更新"
            : `${doneCount} 个生成任务已完成,作品库已更新`;
        toast.success(msg);
        if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
          new Notification("ToIV 生成任务", { body: msg });
        }
      }
      // 失败用错误色(2026-08-30:不再一律绿色成功),原因透出 job.error
      for (const f of failedNow) {
        toast.error(`${kindLabel(f.kind)}生成失败:${f.error}`);
      }
      if (canceledCount > 0) {
        toast.info(canceledCount === 1 ? "1 个任务已中止" : `${canceledCount} 个任务已中止`);
      }
      if (unknownCount > 0 && doneCount === 0 && failedNow.length === 0 && canceledCount === 0) {
        // 终态查不到(抖动/已回收):中性兜底,不误报
        toast.info(
          unknownCount === 1
            ? "1 个生成任务已结束,请到作品库查看结果"
            : `${unknownCount} 个生成任务已结束,请到作品库查看结果`,
        );
      }
      if (failedNow.length > 0) {
        setFailed((prev) => {
          const seen = new Set(prev.map((f) => f.promptId));
          return [...failedNow.filter((f) => !seen.has(f.promptId)), ...prev].slice(0, FAILED_CAP);
        });
      }
    },
    [toast],
  );

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
        if (gone.length > 0) void notifyGone(gone);
      }
      prevRef.current = now;
    } catch {
      setLoadErr(true); // 保留旧数据,下轮自愈;失败不清空 prev(防误报完成)
    }
  }, [notifyGone]);

  useEffect(() => {
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(t);
  }, [tick]);

  /** 中止在跑作业:先开确认门(Modal);确认后 POST cancel → 立刻刷新面板与作品库。 */
  const onCancelItem = useCallback((item: ActiveJobItem) => {
    setConfirmItem(item);
  }, []);

  const doCancel = useCallback(() => {
    const item = confirmItem;
    if (!item) return;
    const label = kindLabel(item.kind);
    setConfirmItem(null);
    setCancelingIds((prev) => new Set(prev).add(item.id));
    void (async () => {
      try {
        await cancelJob(item.id);
        toast.success(`已中止:${label}`);
        invalidateJobs();
        // 从完成检测基准摘掉,避免下一轮 tick 再报「任务已结束」
        prevRef.current?.delete(item.prompt_id);
        await tick();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "中止失败");
        await tick(); // 409 等场景同步最新状态
      } finally {
        setCancelingIds((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    })();
  }, [confirmItem, tick, toast]);

  /** 失败条目重试:rerun 精确重生(参数快照);成功后从失败清单移除。 */
  const onRetryFailed = useCallback(
    (f: FailedEntry) => {
      if (retryingIds.has(f.jobId)) return;
      setRetryingIds((prev) => new Set(prev).add(f.jobId));
      void (async () => {
        try {
          await rerunJob(f.jobId, { seed_mode: "random" });
          toast.success(`已重新提交:${kindLabel(f.kind)}`);
          setFailed((prev) => prev.filter((x) => x.jobId !== f.jobId));
          invalidateJobs();
          await tick();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "重试失败");
        } finally {
          setRetryingIds((prev) => {
            const next = new Set(prev);
            next.delete(f.jobId);
            return next;
          });
        }
      })();
    },
    [retryingIds, tick, toast],
  );

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
          {!loadErr && count === 0 && failed.length === 0 && (
            <div className="taskcenter-empty">当前没有在跑的任务</div>
          )}
          {items.map((item) => (
            <TaskCenterItem
              key={item.id}
              item={item}
              onCancel={onCancelItem}
              canceling={cancelingIds.has(item.id)}
            />
          ))}
          {failed.length > 0 && (
            <>
              <div className="taskcenter-pop-title">最近失败({failed.length})</div>
              {failed.map((f) => (
                <div className="taskcenter-item is-failed" key={f.jobId}>
                  <div className="taskcenter-item-head">
                    <span className="taskcenter-item-kind">{kindLabel(f.kind)}</span>
                    {f.canRetry && (
                      <button
                        type="button"
                        className="taskcenter-item-retry"
                        disabled={retryingIds.has(f.jobId)}
                        onClick={() => onRetryFailed(f)}
                        aria-label={`重试任务:${f.prompt || f.kind}`}
                        title="按原参数重新生成(换新随机种子)"
                      >
                        {retryingIds.has(f.jobId) ? "重试中…" : "重试"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="taskcenter-item-dismiss"
                      onClick={() => setFailed((prev) => prev.filter((x) => x.jobId !== f.jobId))}
                      aria-label={`移除失败记录:${f.prompt || f.kind}`}
                      title="移除该记录"
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                  <div className="taskcenter-item-prompt" title={f.prompt}>
                    {f.prompt || "(无提示词)"}
                  </div>
                  <div className="taskcenter-item-error">{f.error}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </Popover>

      {/* 中止确认门(2026-08-30:全站确认门收敛到 ui/Modal,替代原生确认弹窗) */}
      <Modal
        open={confirmItem !== null}
        onClose={() => setConfirmItem(null)}
        title="中止任务"
        danger
        width={400}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmItem(null)}>
              再想想
            </button>
            <button type="button" className="btn btn-danger" onClick={doCancel}>
              确认中止
            </button>
          </>
        }
      >
        {confirmItem && (
          <p className="taskcenter-confirm-text">
            确认中止「{kindLabel(confirmItem.kind)}」任务吗?已产生的进度不会保留。
          </p>
        )}
      </Modal>
    </div>
  );
}
