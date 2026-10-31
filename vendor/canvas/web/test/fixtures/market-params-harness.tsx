import { useState } from "react";
import { createRoot } from "react-dom/client";

import { LorasField, MarketMediaField, ParamField } from "@/pages/toiv/market-page";
import {
    buildToivRunValues,
    marketRunValidation,
    normalizeToivAppParam,
    type ToivAppParam,
} from "@/services/toiv/market-run";

function HarnessField({
    raw,
    initial,
    testId,
}: {
    raw: Record<string, unknown>;
    initial: unknown;
    testId: string;
}) {
    const param: ToivAppParam = normalizeToivAppParam(raw);
    const [value, setValue] = useState<unknown>(initial);
    return (
        <div data-testid={testId} className="rounded-md border border-[var(--border)] p-3">
            <ParamField
                param={param}
                value={value}
                onChange={(_key, next) => setValue(next)}
                uploadKind="video"
            />
        </div>
    );
}

function LoraHarness({
    raw,
    testId,
}: {
    raw: Record<string, unknown>;
    testId: string;
}) {
    const param: ToivAppParam = normalizeToivAppParam(raw);
    const [value, setValue] = useState<unknown>(null);
    return (
        <div data-testid={testId} className="rounded-md border border-[var(--border)] p-3">
            <LorasField param={param} value={value} onChange={(_key, next) => setValue(next)} />
            <output data-testid={`${testId}-value`}>{JSON.stringify(value)}</output>
        </div>
    );
}

function MediaHarness({
    raw,
    testId,
}: {
    raw: Record<string, unknown>;
    testId: string;
}) {
    const param: ToivAppParam = normalizeToivAppParam(raw);
    const [value, setValue] = useState<unknown>(null);
    return (
        <div data-testid={testId} className="rounded-md border border-[var(--border)] p-3">
            <MarketMediaField
                param={param}
                value={value}
                onChange={(_key, next) => setValue(next)}
                uploadKind="video"
            />
        </div>
    );
}

const LORA_OPTIONS = [
    { value: "lora-a.safetensors", label: "LoRA A" },
    { value: "lora-b.safetensors", label: "LoRA B" },
    { value: "lora-c.safetensors", label: "LoRA C" },
    { value: "lora-d.safetensors", label: "LoRA D" },
    { value: "lora-e.safetensors", label: "LoRA E" },
];

/** 与 market-page onRun 同一前置校验 + 同一 buildToivRunValues 提交路径 */
function SubmitHarness() {
    const schema: ToivAppParam[] = [
        normalizeToivAppParam({
            key: "prompt",
            label: "提示词",
            type: "textarea",
            default: null,
            required: true,
            max_chars: 10,
        }),
        normalizeToivAppParam({
            key: "loras",
            label: "LoRA",
            type: "loras",
            default: [],
            max_items: 5,
            options: LORA_OPTIONS,
        }),
    ];
    const [values, setValues] = useState<Record<string, unknown>>({ prompt: "", loras: [] });
    const [submitted, setSubmitted] = useState<Record<string, unknown> | null>(null);
    const validation = marketRunValidation(schema, values);
    const onSubmit = () => {
        if (validation) return;
        setSubmitted(buildToivRunValues(schema, values));
    };
    return (
        <div data-testid="submit-harness" className="rounded-md border border-[var(--border)] p-3">
            <ParamField
                param={schema[0]}
                value={values.prompt}
                onChange={(_key, next) => setValues((prev) => ({ ...prev, prompt: next }))}
                uploadKind="video"
            />
            <LorasField
                param={schema[1]}
                value={values.loras}
                onChange={(_key, next) => setValues((prev) => ({ ...prev, loras: next }))}
            />
            {validation && (
                <p className="text-xs text-[var(--destructive)]" role="alert" data-testid="submit-error">
                    {validation.message}
                </p>
            )}
            <button
                type="button"
                data-testid="submit-run"
                disabled={!!validation}
                onClick={onSubmit}
                className="rounded-md border border-[var(--border)] px-3 py-1.5"
            >
                运行此应用
            </button>
            <output data-testid="submit-result">{submitted ? JSON.stringify(submitted) : ""}</output>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(
    <div className="flex flex-col gap-4 p-4 text-xs">
        <h1 className="text-sm font-medium">B1c 声明式上限 harness</h1>

        <section data-testid="section-text">
            <h2>文本（max_chars=10 已声明）</h2>
            <HarnessField
                testId="text-declared"
                raw={{ key: "prompt", label: "提示词", type: "textarea", default: "", max_chars: 10 }}
                initial=""
            />
            <h2>文本（未声明，保持旧行为）</h2>
            <HarnessField
                testId="text-fallback"
                raw={{ key: "note", label: "备注", type: "textarea", default: "" }}
                initial=""
            />
        </section>

        <section data-testid="section-media">
            <h2>视频（max_bytes=1MB 已声明）</h2>
            <MediaHarness
                testId="media-declared"
                raw={{ key: "video", label: "驱动视频", type: "video", default: null, max_bytes: 1024 * 1024 }}
            />
            <h2>视频（未声明，兼容回退 200MB）</h2>
            <MediaHarness
                testId="media-fallback"
                raw={{ key: "video2", label: "源视频", type: "video", default: null }}
            />
        </section>

        <section data-testid="section-loras">
            <h2>LoRA（max_items=5 已声明）</h2>
            <LoraHarness
                testId="loras-declared"
                raw={{ key: "loras", label: "LoRA", type: "loras", default: null, max_items: 5, options: LORA_OPTIONS }}
            />
            <h2>LoRA（未声明，兼容回退 cap=3）</h2>
            <LoraHarness
                testId="loras-fallback"
                raw={{ key: "loras2", label: "LoRA", type: "loras", default: null, options: LORA_OPTIONS }}
            />
            <h2>LoRA（max_items=2 + 强度区间 0.2~0.9）</h2>
            <LoraHarness
                testId="loras-strength"
                raw={{
                    key: "loras3",
                    label: "LoRA",
                    type: "loras",
                    default: null,
                    max_items: 2,
                    min: 0.2,
                    max: 0.9,
                    step: 0.05,
                    options: LORA_OPTIONS.slice(0, 3),
                }}
            />
        </section>
        <section data-testid="section-submit">
            <h2>提交校验（max_chars 阻断 + max_items=5 全量提交）</h2>
            <SubmitHarness />
        </section>
    </div>,
);
