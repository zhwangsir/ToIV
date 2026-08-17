"use client";

/**
 * LibTV 式短剧工作台 —— 阶段③:分镜表格页(Team C)。
 *
 * 形态核心:表格(镜号│资产│画面描述│故事板│状态│时长│操作)+ 顶部工具条
 * (模型选择 / 宫格分镜 / 批量生成 dry-run Modal)+ 可收叠宫格预览(点击格子
 * 滚动定位到行)+ 底部恒显「确认分镜,进入短片制作 →」确认门。
 * 全部数据/动作来自 dp(useDramaProject),零新 API;确认门状态由 props 下发
 * (缺省从 project.status 推导:generating/ready 视为已确认)。
 */
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";

import { imageUrl } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import type { DramaShotApi, StageShotsProps } from "./types";
import { ShotTableRow, type ShotRowEditPatch } from "./ShotTableRow";

// 与 DramaWorkbench 容器同一阶梯:generating/ready 视为分镜已确认
const SHOTS_CONFIRMED_STATUSES = new Set(["generating", "ready"]);

function fmtTotal(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function StageShots({
  dp,
  onOpenProduce,
  confirmedShots: confirmedProp,
  onConfirmShots,
}: StageShotsProps) {
  const shots = dp.shots;
  const confirmed =
    confirmedProp ?? SHOTS_CONFIRMED_STATUSES.has(dp.current?.status ?? "");
  const [batchOpen, setBatchOpen] = useState(false);
  const [gridOpen, setGridOpen] = useState(true);

  const availableGenerators = dp.videoGenerators.filter((g) => g.available);
  // 待生成集合与 dp.generateAllShots 内部口径一致(非 done 且非 generating)
  const pendingShots = useMemo(
    () =>
      shots.filter((s) => {
        const st = (s.video_status || "").toLowerCase();
        return st !== "done" && st !== "generating";
      }),
    [shots],
  );
  const pendingSec = useMemo(
    () => pendingShots.reduce((acc, s) => acc + (s.duration_sec || 0), 0),
    [pendingShots],
  );
  const totalSec = useMemo(
    () => shots.reduce((acc, s) => acc + (s.duration_sec || 0), 0),
    [shots],
  );
  // dry-run ETA:与 hook 内批量提示同口径(1.5 min/镜经验值)
  const etaMin = Math.max(1, Math.ceil(pendingShots.length * 1.5));

  // ── 宫格点击定位(复用旧 DramaView 逻辑:格子行列 → 分镜序号 → 滚动到行)──
  const handleGridClick = (e: ReactMouseEvent<HTMLImageElement>) => {
    if (shots.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const cols = shots.length <= 9 ? 3 : 5;
    const rows = Math.ceil(shots.length / cols);
    const col = Math.min(cols - 1, Math.max(0, Math.floor(fx * cols)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(fy * rows)));
    const shot = shots[row * cols + col];
    if (!shot) return;
    dp.setSelectedShotId(shot.id);
    document
      .getElementById(`wb-shot-${shot.id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // P2 阶段B grounding 徽章:同次宫格生成的全部 shot 状态一致,取首个带标记的
  const groundingStatus = useMemo(
    () =>
      shots.find((s) => s.detected_colors?.grounding_status)?.detected_colors
        ?.grounding_status ?? "",
    [shots],
  );

  const handleSaveRow = (shot: DramaShotApi, patch: ShotRowEditPatch) => {
    void dp.saveShot(shot, {
      prompt: patch.prompt,
      dialogue: shot.dialogue,
      scene: shot.scene,
      mood: patch.mood,
      beat: patch.beat,
      seam_to_next: patch.seam_to_next,
      seam_anchor: patch.seam_anchor,
    });
  };

  const handleRegenerate = (shot: DramaShotApi) => {
    // 重生成换 seed(设计文档 2.3 操作列语义)
    dp.generateVideoV2(shot.id, {
      model: dp.videoModel,
      steps: 20,
      cfg: 1.0,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
  };

  const handleConfirm = () => {
    if (onConfirmShots) {
      onConfirmShots();
      return;
    }
    // props 未下发时的兜底:直写 status 阶梯(与容器确认门一致)
    void dp.patchProject({ status: "generating" }).catch(() => {});
  };

  const runBatch = () => {
    setBatchOpen(false);
    dp.generateAllShots();
  };

  return (
    <div className="wb-shots">
      {/* ── 工具条:模型选择 / 宫格分镜 / 批量生成 ── */}
      <div className="wb-shots-toolbar">
        <span className="wb-shots-count">{shots.length} 镜</span>
        <div className="wb-topbar-spacer" />
        {availableGenerators.length > 0 && (
          <select
            className="wb-select"
            aria-label="视频生成模型"
            value={dp.videoModel}
            onChange={(e) => dp.setVideoModel(e.target.value)}
          >
            {availableGenerators.map((g) => (
              <option key={g.name} value={g.name}>
                {g.display_name || g.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={dp.gridBusy || !(dp.current?.script ?? "").trim()}
          title="按剧本一次性生成 9/25 张分镜并拼宫格预览图(会清掉旧分镜)"
          onClick={() => dp.setShowGridPicker(!dp.showGridPicker)}
        >
          <Icon name="grid" size={14} />
          {dp.gridBusy ? "宫格生成中…" : "宫格分镜"}
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!confirmed || pendingShots.length === 0}
          title={
            !confirmed
              ? "请先在分镜页确认分镜"
              : pendingShots.length === 0
                ? "全部镜头已就绪"
                : `批量生成 ${pendingShots.length} 个待生成镜头(先 dry-run 预估)`
          }
          onClick={() => setBatchOpen(true)}
        >
          <Icon name="video" size={14} />
          批量生成({pendingShots.length})
        </button>
      </div>

      {/* ── 宫格规格选择 ── */}
      {dp.showGridPicker && !dp.gridBusy && (
        <div className="wb-gridpicker">
          <span className="wb-dim">选择宫格规格:</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void dp.gridStoryboard(9)}
          >
            9 宫格(3×3)
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void dp.gridStoryboard(25)}
          >
            25 宫格(5×5)
          </button>
        </div>
      )}
      {dp.gridError && (
        <div className="wb-errline">
          <Icon name="error" size={13} />
          {dp.gridError}
        </div>
      )}

      {/* ── 宫格预览(可收叠;点击格子定位到行)── */}
      {dp.gridImage && !dp.gridBusy && (
        <div className="wb-gridpanel">
          <div className="wb-gridpanel-head">
            <span>宫格预览(点击格子定位到分镜行)</span>
            {groundingStatus === "grounded" && (
              <span
                className="wb-badge is-done"
                title="阶段B:VLM 已逐格观察实际宫格,各镜提示词按实际成图据实改写"
              >
                已按实图改写
              </span>
            )}
            {groundingStatus === "fallback" && (
              <span
                className="wb-badge"
                title="阶段B:VLM 观察不可用,各镜提示词保持 LLM 原稿(未按实图改写)"
              >
                未按实图改写·已回落
              </span>
            )}
            <button
              type="button"
              className="wb-icon-btn"
              title={gridOpen ? "收起宫格预览" : "展开宫格预览"}
              aria-expanded={gridOpen}
              onClick={() => setGridOpen((v) => !v)}
            >
              <Icon name={gridOpen ? "chevron-up" : "chevron-down"} size={13} />
            </button>
          </div>
          {gridOpen && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="wb-gridpanel-img"
              src={imageUrl(dp.gridImage)}
              alt="宫格分镜预览"
              width={960}
              height={960}
              onClick={handleGridClick}
            />
          )}
        </div>
      )}

      {/* ── 分镜表格 ── */}
      {shots.length === 0 ? (
        <div className="wb-empty-hint">
          还没有分镜,请先在剧本页保存剧本并拆分镜,或用「宫格分镜」生成
        </div>
      ) : (
        <table className="wb-shot-table">
          <thead>
            <tr>
              <th className="wb-col-idx">镜号</th>
              <th className="wb-col-assets">资产</th>
              <th className="wb-col-prompt">画面描述</th>
              <th className="wb-col-board">故事板</th>
              <th className="wb-col-status">状态</th>
              <th className="wb-col-dur">时长</th>
              <th className="wb-col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            {shots.map((s) => (
              <ShotTableRow
                key={s.id}
                shot={s}
                selected={dp.selectedShotId === s.id}
                characters={dp.characters}
                busyVideo={dp.busyShot === s.id}
                busyContinue={dp.busyContinue === s.id}
                busyLipsync={dp.busyLipsync === s.id}
                onSelect={() => dp.setSelectedShotId(s.id)}
                onOpenProduce={onOpenProduce}
                onSave={(patch) => handleSaveRow(s, patch)}
                onRegenerate={() => handleRegenerate(s)}
                onContinue={() => dp.continueVideo(s)}
                onLipsync={() => void dp.generateLipsync(s.id)}
                onStoryboard={() => dp.setShowGridPicker(true)}
              />
            ))}
          </tbody>
        </table>
      )}

      {/* ── 底部恒显:确认门 ── */}
      <div className="wb-shots-foot">
        <span className="wb-dim">
          共 {shots.length} 镜 · 总时长 {fmtTotal(totalSec)} · 已完成{" "}
          {dp.doneCount}
        </span>
        <div className="wb-topbar-spacer" />
        <button
          type="button"
          className="btn btn-primary"
          disabled={confirmed || shots.length === 0}
          title={confirmed ? "分镜已确认" : "确认后解锁短片制作与批量生成"}
          onClick={handleConfirm}
        >
          <Icon name="check" size={14} />
          {confirmed ? "分镜已确认" : "确认分镜,进入短片制作 →"}
        </button>
      </div>

      {/* ── 批量生成 dry-run 预估 Modal ── */}
      <Modal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        title="批量生成 · 预估"
        footer={
          <>
            <Button variant="secondary" onClick={() => setBatchOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              icon={<Icon name="video" size={14} />}
              onClick={runBatch}
            >
              确认生成 {pendingShots.length} 镜
            </Button>
          </>
        }
      >
        <dl className="wb-dryrun">
          <div className="wb-inspect-kv">
            <dt>待生成镜头</dt>
            <dd>{pendingShots.length} 镜</dd>
          </div>
          <div className="wb-inspect-kv">
            <dt>镜头总时长</dt>
            <dd>
              {pendingSec.toFixed(1)}s(均{" "}
              {pendingShots.length > 0
                ? (pendingSec / pendingShots.length).toFixed(1)
                : "0.0"}
              s/镜)
            </dd>
          </div>
          <div className="wb-inspect-kv">
            <dt>生成模型</dt>
            <dd>
              {availableGenerators.find((g) => g.name === dp.videoModel)
                ?.display_name || dp.videoModel}
            </dd>
          </div>
          <div className="wb-inspect-kv">
            <dt>预计耗时</dt>
            <dd>约 {etaMin} 分钟(1.5 min/镜经验值)</dd>
          </div>
        </dl>
        <p className="wb-dim wb-dryrun-note">
          确认后逐镜提交生成任务,进度见各镜头状态与任务日志;已完成镜头不受影响。
        </p>
      </Modal>
    </div>
  );
}
