/**
 * 设定卡门禁失败感知：人话原因 + 拒图预览 + 软保留（本地学习）。
 * 与后端 apps/api/.../character_sheet/ux.py 字段对齐。
 */

export type SheetGateFailure = {
    code: string;
    title: string;
    detail: string;
    panel?: string | null;
    preview_url?: string | null;
};

export type SheetJobFailureResult = {
    status: "error";
    error?: string;
    reason_code?: string;
    reason_zh?: string;
    technical_detail?: string;
    rejected_preview_url?: string | null;
    rejected_panel?: string | null;
    gate_failures?: SheetGateFailure[];
    soft_keep_available?: boolean;
    style?: string;
};

export type SheetFailureView = {
    reasonZh: string;
    technicalDetail: string;
    previewUrl: string | null;
    softKeepAvailable: boolean;
    style: string;
    reasonCode: string;
};

/** 从 poll 错误结果抽出抽屉展示态 */
export function sheetFailureFromJobResult(
    r: Partial<SheetJobFailureResult> & { error?: string },
    fallbackStyle = "",
): SheetFailureView {
    const first = Array.isArray(r.gate_failures) ? r.gate_failures[0] : undefined;
    const reasonZh =
        (r.reason_zh && String(r.reason_zh).trim()) ||
        (first?.title && String(first.title).trim()) ||
        (r.error && String(r.error).trim()) ||
        "设定卡质检未通过";
    const technicalDetail =
        (r.technical_detail && String(r.technical_detail).trim()) ||
        (first?.detail && String(first.detail).trim()) ||
        (r.error && String(r.error).trim()) ||
        "";
    const previewUrl =
        (r.rejected_preview_url && String(r.rejected_preview_url)) ||
        (first?.preview_url && String(first.preview_url)) ||
        null;
    return {
        reasonZh,
        technicalDetail,
        previewUrl,
        softKeepAvailable: Boolean(r.soft_keep_available && previewUrl),
        style: (r.style && String(r.style)) || fallbackStyle,
        reasonCode: (r.reason_code && String(r.reason_code)) || first?.code || "other",
    };
}

/** 兼容旧版只有 error 字符串的 Job 结果 */
export function sheetFailureFromCaughtError(error: unknown, fallbackStyle = ""): SheetFailureView {
    if (error && typeof error === "object" && "sheetFailure" in error) {
        const sf = (error as { sheetFailure?: SheetFailureView }).sheetFailure;
        if (sf) return sf;
    }
    const msg = error instanceof Error ? error.message : String(error || "设定卡生成失败");
    return {
        reasonZh: msg,
        technicalDetail: msg,
        previewUrl: null,
        softKeepAvailable: false,
        style: fallbackStyle,
        reasonCode: "other",
    };
}

export class SheetGateJobError extends Error {
    sheetFailure: SheetFailureView;
    constructor(view: SheetFailureView) {
        super(view.reasonZh);
        this.name = "SheetGateJobError";
        this.sheetFailure = view;
    }
}
