"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ParamField } from "@/components/generate/ParamField";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import {
  appCategoryLabel,
  buildImportOverrides,
  confirmImport,
  importWorkflow,
  type AppImportDraft,
  type AppItem,
  type AppOutputKind,
  type AppParam,
} from "@/lib/apps";

/* 样式与 AppMarketView 同文件:app/styles/apps.css(apps- 前缀;ParamField 等子组件
   不受 styled-jsx 哈希类覆盖,文件级样式同范式,见 AppMarketView 注释) */

/**
 * 智能导入(M5):粘贴/上传工作流 JSON → POST /api/apps/import(LLM 包装草稿)
 * → 草稿预览(左侧 params_schema 经 generate/ParamField 实时预览;右侧信息卡可改
 *   名称/描述/图标 = confirm overrides,category/output_kind 展示,warnings 黄条)
 * → POST /api/apps/import/confirm 上架为我的应用 → toast + 回调刷新市场。
 *
 * 三步流转:input(粘贴/拖拽上传,JSON.parse 失败即时红字)→ parsing(分步提示
 * 「解析节点 → AI 包装中…」,LLM 10-30s;503/429 错误态展示后端归一文案 + 重试)
 * → preview(确认上架;confirm 404 草稿过期给「重新导入」回第一步)。
 */

type Step = "input" | "parsing" | "preview";

const OUTPUT_KIND_LABEL: Record<AppOutputKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

interface AppImportModalProps {
  open: boolean;
  onClose: () => void;
  /** 上架成功回调(AppMarketView 刷新「我的应用」区) */
  onImported: (app: AppItem) => void;
}

/** 草稿参数初值:default 优先;switch 兜底 false,其余空串(与 AppRunnerView 同规则)。 */
function draftValues(schema: AppParam[]): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const p of schema) v[p.key] = p.default ?? (p.type === "switch" ? false : "");
  return v;
}

export function AppImportModal({ open, onClose, onImported }: AppImportModalProps) {
  const toast = useToast();
  const [step, setStep] = useState<Step>("input");
  const [jsonText, setJsonText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  // parsing 分步提示:0=解析节点,1=AI 包装中(LLM 10-30s)
  const [phase, setPhase] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AppImportDraft | null>(null);
  // 可改元数据(confirm overrides 候选;仅与草稿不同的键会上送)
  const [edits, setEdits] = useState({ name: "", description: "", icon: "" });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  /** 全量重置(关闭/重新导入);重开后从第一步开始。 */
  const reset = useCallback(() => {
    setStep("input");
    setJsonText("");
    setFileName(null);
    setDragOver(false);
    setParseError(null);
    setPhase(0);
    setSubmitError(null);
    setDraft(null);
    setEdits({ name: "", description: "", icon: "" });
    setValues({});
    setConfirming(false);
    setConfirmError(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // 分步进度:进入解析且未出错时,1.5s 后从「解析节点」推进到「AI 包装中」
  useEffect(() => {
    if (step !== "parsing" || submitError) return;
    setPhase(0);
    const t = window.setTimeout(() => setPhase(1), 1500);
    return () => window.clearTimeout(t);
  }, [step, submitError]);

  /** JSON 文本落库 + 即时校验(Field error 红字);空文本视为未填(无错误)。 */
  const applyText = useCallback((text: string, name?: string) => {
    setJsonText(text);
    setFileName(name ?? null);
    if (!text.trim()) {
      setParseError(null);
      return;
    }
    try {
      JSON.parse(text);
      setParseError(null);
    } catch (e) {
      setParseError(`JSON 解析失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  /** 读取 .json 文件(拖拽/点选共用);非 JSON 文件直接红字拒绝。 */
  async function readFile(f: File | undefined | null) {
    if (!f) return;
    if (!/\.json$/i.test(f.name) && f.type !== "application/json") {
      setParseError("仅支持 .json 工作流文件");
      return;
    }
    applyText(await f.text(), f.name);
  }

  /** 第一步提交:本地 parse 兜底 → importWorkflow(LLM 包装)→ 成功进预览。 */
  async function startImport() {
    let workflow: unknown;
    try {
      workflow = JSON.parse(jsonText);
    } catch (e) {
      setParseError(`JSON 解析失败:${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) {
      setParseError("工作流须为 JSON 对象");
      return;
    }
    setStep("parsing");
    setSubmitError(null);
    try {
      const d = await importWorkflow(workflow);
      setDraft(d);
      setEdits({ name: d.name, description: d.description, icon: d.icon });
      setValues(draftValues(d.params_schema));
      setStep("preview");
    } catch (e) {
      // 503「AI 包装服务暂不可用」/429 限流等由 lib/apps 归一为可读文案,直接展示
      setSubmitError(e instanceof Error ? e.message : "智能导入失败");
    }
  }

  /** 第三步确认:confirmImport(仅差异 overrides)→ toast + 关闭 + 回调刷新市场。 */
  async function publish() {
    if (!draft || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const app = await confirmImport(draft.draft_id, buildImportOverrides(draft, edits));
      toast.success(`已上架到我的应用「${app.name}」`);
      handleClose();
      onImported(app);
    } catch (e) {
      // 404 草稿过期/不存在:保留预览供查看,「重新导入」回第一步
      setConfirmError(e instanceof Error ? e.message : "确认上架失败");
    } finally {
      setConfirming(false);
    }
  }

  const onParamChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const busy = step === "parsing" && !submitError;
  const canSubmit = jsonText.trim() !== "" && !parseError;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="智能导入工作流"
      width={step === "preview" ? 880 : 560}
      preventClose={busy || confirming}
      footer={
        step === "input" ? (
          <>
            <Button variant="ghost" onClick={handleClose}>
              取消
            </Button>
            <Button
              variant="primary"
              icon={<Icon name="wand" size={14} />}
              disabled={!canSubmit}
              onClick={() => void startImport()}
            >
              开始解析
            </Button>
          </>
        ) : step === "preview" ? (
          <>
            {confirmError && (
              <>
                <span className="apps-import-confirm-error" role="alert">
                  {confirmError}
                </span>
                <Button variant="ghost" size="sm" onClick={reset}>
                  重新导入
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={handleClose} disabled={confirming}>
              取消
            </Button>
            <Button
              variant="primary"
              icon={<Icon name="check" size={14} />}
              loading={confirming}
              disabled={!edits.name.trim()}
              onClick={() => void publish()}
            >
              确认上架
            </Button>
          </>
        ) : undefined
      }
    >
      {step === "input" && (
        <div className="apps-import-input">
          <div
            className={`apps-import-drop${dragOver ? " is-over" : ""}`}
            role="button"
            tabIndex={0}
            aria-label="上传工作流 JSON 文件"
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void readFile(e.dataTransfer.files?.[0]);
            }}
          >
            <Icon name="filejson" size={20} />
            <span>拖拽 .json 工作流文件到此处,或点击选择文件</span>
            {fileName && <span className="apps-import-file">{fileName}</span>}
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                e.target.value = ""; // 清空以支持同文件二次选择
              }}
            />
          </div>
          <Field label="或粘贴工作流 JSON" error={parseError ?? undefined}>
            <Textarea
              className="apps-import-json"
              rows={8}
              value={jsonText}
              placeholder='{"1": {"class_type": "CheckpointLoaderSimple", "inputs": {…}}, …}'
              spellCheck={false}
              onChange={(e) => applyText(e.target.value)}
            />
          </Field>
        </div>
      )}

      {step === "parsing" && (
        <div className="apps-import-progress" role="status">
          {submitError ? (
            <>
              <p className="apps-import-error" role="alert">
                <Icon name="alert" size={14} />
                <span>{submitError}</span>
              </p>
              <div className="apps-import-actions">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Icon name="refresh" size={13} />}
                  onClick={() => void startImport()}
                >
                  重试
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setStep("input")}>
                  返回修改
                </Button>
              </div>
            </>
          ) : (
            <>
              <Icon name="loading" size={22} />
              <ol className="apps-import-steps">
                <li className={phase === 0 ? "is-on" : ""}>解析节点…</li>
                <li className={phase >= 1 ? "is-on" : ""}>
                  AI 包装中…(LLM 可能需要 10-30 秒)
                </li>
              </ol>
            </>
          )}
        </div>
      )}

      {step === "preview" && draft && (
        <div className="apps-import-preview">
          {/* 左:参数表单实时预览(复用 generate/ParamField,与运行页同渲染) */}
          <div className="apps-import-form">
            {draft.params_schema.length === 0 ? (
              <p className="apps-import-noparams">该工作流未识别出可调参数</p>
            ) : (
              draft.params_schema.map((p) => (
                <ParamField
                  key={p.key}
                  param={p}
                  value={values[p.key]}
                  onChange={onParamChange}
                />
              ))
            )}
          </div>
          {/* 右:信息卡(名称/描述/图标可改 = confirm overrides;分类/产出展示;warnings 黄条) */}
          <aside className="apps-import-info">
            <span className="apps-import-icon" aria-hidden="true">
              <Icon name={(edits.icon || "package") as IconName} size={18} />
            </span>
            <Field label="名称">
              <Input
                value={edits.name}
                onChange={(e) => setEdits((p) => ({ ...p, name: e.target.value }))}
              />
            </Field>
            <Field label="描述">
              <Textarea
                rows={3}
                value={edits.description}
                onChange={(e) => setEdits((p) => ({ ...p, description: e.target.value }))}
              />
            </Field>
            <Field label="图标(lucide 名)" hint="未知名将显示占位图标">
              <Input
                value={edits.icon}
                onChange={(e) => setEdits((p) => ({ ...p, icon: e.target.value }))}
              />
            </Field>
            <div className="apps-import-meta">
              <span className="apps-tag">{appCategoryLabel(draft.category)}</span>
              <span className="apps-tag">产出 {OUTPUT_KIND_LABEL[draft.output_kind]}</span>
              <span className="apps-tag">{draft.params_schema.length} 个参数</span>
            </div>
            {draft.warnings.length > 0 && (
              <div className="apps-import-warnings" role="alert" aria-label="包装警告">
                {draft.warnings.map((w, i) => (
                  <p key={i} className="apps-import-warning">
                    <Icon name="alert" size={13} />
                    <span>{w}</span>
                  </p>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}
    </Modal>
  );
}
