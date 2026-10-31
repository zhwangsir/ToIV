import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GenerationFailureNotice } from "../src/components/generation/generation-failure-notice";
import { explainGenerationError } from "../src/lib/generation-error";

test("uncertain submission offers original task instead of resubmitting", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explainGenerationError({ code: "video_submission_unknown" })} onRetry={() => {}} onOpenDetails={() => {}} />);
    expect(html).toContain("查看原任务");
    expect(html).not.toContain("重新生成");
});

test("invalid reference explains limits without repeating unchanged input", () => {
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explainGenerationError("第 2 段参考音频时长为 0.90 秒，需要 2–30 秒；请裁剪或更换这段素材后再提交")} onRetry={() => {}} />);
    expect(html).toContain("第 2 段参考音频");
    expect(html).toContain("2–30 秒");
    expect(html).not.toContain("重新生成");
});

test("r18_context_required maps to route_guard_adult slot and adult CTA when normal mode", () => {
    const explanation = explainGenerationError({ code: "r18_context_required", message: "该操作为 R18 内容,须在 R18 上下文(X-NSFW)下使用" });
    expect(explanation.category).toBe("r18_context_required");
    expect(explanation.slot).toBe("route_guard_adult");
    expect(explanation.slotLabel).toBe("需成人");
    expect(explanation.guideEnableR18).toBe(true);
    expect(explanation.blockAutomaticRetry).toBe(true);
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} onRetry={() => {}} />);
    expect(html).toContain("需成人");
    expect(html).toContain("切换到成人模式");
    expect(html).toContain("请先修改提示词或参考");
    expect(html).toContain('data-testid="generation-failure-retry-blocked"');
});

test("quota failure never guides R18", () => {
    const explanation = explainGenerationError({ code: "insufficient_user_quota", message: "额度不足" });
    expect(explanation.slot).toBe("quota");
    expect(explanation.guideEnableR18).toBe(false);
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} onRetry={() => {}} />);
    expect(html).not.toContain("切换到成人模式");
    expect(html).toContain("额度");
});

test("throttled failure never guides R18", () => {
    const explanation = explainGenerationError({ code: "rate_limit_exceeded" });
    expect(explanation.slot).toBe("rate");
    expect(explanation.guideEnableR18).toBe(false);
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} />);
    expect(html).not.toContain("切换到成人模式");
});

test("fingerprint changed enables 新建尝试 for moderation", () => {
    const explanation = explainGenerationError({ code: "content_policy_violation", message: "opaque" });
    expect(explanation.moderation).toBe(true);
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} onRetry={() => {}} retryBlockedByFingerprint={false} />);
    expect(html).toContain("新建尝试");
    expect(html).toContain('data-testid="generation-failure-new-attempt"');
    expect(html).not.toContain("请先修改提示词或参考");
});

test("requestId secondary copy button is available", () => {
    const explanation = explainGenerationError({ code: "r18_context_required", message: "须在 R18 上下文", request_id: "req_r18_abc123" } as never);
    // also via context
    const withId = { ...explainGenerationError({ code: "r18_context_required" }), requestId: "req_r18_abc123" };
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={withId} context={{ providerRequestId: "req_r18_abc123" }} />);
    expect(html).toContain("复制 requestId");
});

test("r18 fingerprint prop enables 新建尝试 after unblock", () => {
    const explanation = explainGenerationError({ code: "r18_context_required", message: "须在 R18 上下文" });
    const blocked = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} onRetry={() => {}} retryBlockedByFingerprint={true} />);
    expect(blocked).toContain('data-testid="generation-failure-retry-blocked"');
    expect(blocked).toContain("请先修改提示词或参考");
    const open = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} onRetry={() => {}} retryBlockedByFingerprint={false} />);
    expect(open).toContain('data-testid="generation-failure-new-attempt"');
    expect(open).toContain("新建尝试");
    expect(open).not.toContain("请先修改提示词或参考");
});

test("route_guard_adult explicit category guides switch CTA", () => {
    const explanation = explainGenerationError({ code: "route_guard_adult" });
    expect(explanation.category).toBe("route_guard_adult");
    expect(explanation.slot).toBe("route_guard_adult");
    expect(explanation.slotLabel).toBe("需成人");
    expect(explanation.reason).toContain("普通模式");
    expect(explanation.guideEnableR18).toBe(true);
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} />);
    expect(html).toContain("切换到成人模式");
    expect(html).toContain('data-failure-slot="route_guard_adult"');
});

test("non-content 403 slots never render adult CTA", () => {
    for (const err of [
        { status: 403, data: { detail: "需要管理员权限" } },
        { status: 403, data: { detail: "请求过于频繁，请稍后再试" } },
        { status: 403, data: { detail: "账号额度不足，请充值后重试" } },
        { status: 403, data: { detail: "服务令牌无权访问该接口" } },
    ]) {
        const explanation = explainGenerationError(err);
        expect(explanation.guideEnableR18).toBe(false);
        const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} />);
        expect(html).not.toContain("切换到成人模式");
        expect(html).not.toContain('data-testid="generation-failure-enable-r18"');
    }
});

test("adult-gate 403 detail still renders switch CTA", () => {
    const explanation = explainGenerationError({
        status: 403,
        data: { detail: "该操作为 R18 内容,须在 R18 上下文(X-NSFW)下使用" },
    });
    expect(explanation.guideEnableR18).toBe(true);
    const html = renderToStaticMarkup(<GenerationFailureNotice explanation={explanation} />);
    expect(html).toContain("切换到成人模式");
    expect(html).toContain('data-failure-slot="route_guard_adult"');
});
