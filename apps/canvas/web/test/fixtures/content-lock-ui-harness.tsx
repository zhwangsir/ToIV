import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { App, ConfigProvider } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LightCurtainPaddle } from "@/components/content-mode/light-curtain-paddle";
import { CreationStudioInspector } from "@/components/create/creation-studio-inspector";
import { CreationStudioMediaPool } from "@/components/create/creation-studio-media-pool";
import { PoseGallerySurface } from "@/components/pose/pose-gallery-surface";
import { WsCreationDock } from "@/components/toiv/ws-creation-dock";
import { GenerationFailureNotice } from "@/components/generation/generation-failure-notice";
import { explainGenerationError, unchangedModeratedPrompt } from "@/lib/generation-error";
import { canvasFailureRetryBlockedByFingerprint, canvasGenerationFailureMetadata, canvasGenerationRetryBlocked } from "@/pages/canvas/canvas-generation-failure";
import { taskRetryBlocked } from "@/lib/task-shared";
import { R18SettingsPane } from "@/pages/settings/r18-settings-pane";
import MarketPage from "@/pages/toiv/market-page";
import { useAssetStore } from "@/stores/use-asset-store";

await useAssetStore.persist.rehydrate();
useAssetStore.getState().replaceAssets([{
    id: "classified-reference",
    kind: "text",
    title: "Classified reference",
    coverUrl: "",
    tags: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    metadata: { content_rating: "nsfw" },
    data: { content: "Fixture reference" },
}]);

function AssetDestination() {
    return <output data-testid="asset-destination">{useLocation().search}</output>;
}

function RetryProbe() {
    const [code, setCode] = useState("moderation_input");
    const [prompt, setPrompt] = useState("original prompt");
    const [reference, setReference] = useState("resource:original");
    const [stage, setStage] = useState("");
    const [disabled, setDisabled] = useState(false);
    const [attempts, setAttempts] = useState(0);
    const [details, setDetails] = useState(0);
    const submitted = { mode: "image" as const, prompt: "original prompt", referenceImages: [{ storageKey: "resource:original" }] };
    const input = { ...submitted, prompt, referenceImages: [{ storageKey: reference }] };
    const error = { code, message: "opaque" };
    const metadata = { ...canvasGenerationFailureMetadata(error, submitted), taskStage: stage };
    const explanation = explainGenerationError(error, { stage });
    const blocked = canvasGenerationRetryBlocked(metadata, input);
    return <section aria-label="Retry probe">
        <label htmlFor="retry-code">Failure code</label>
        <select id="retry-code" aria-label="Failure code" value={code} onChange={(event) => setCode(event.target.value)}>
            {["moderation_input", "moderation_reference", "moderation_output", "r18_context_required", "route_guard_adult", "throttled", "invalid_params", "auth", "quota_user", "submission_uncertain", "timeout", "download_failed", "canvas_conflict"].map((value) => <option key={value}>{value}</option>)}
        </select>
        <label htmlFor="retry-prompt">Prompt</label>
        <input id="retry-prompt" aria-label="Prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        <label htmlFor="retry-reference">Reference</label>
        <input id="retry-reference" aria-label="Reference" value={reference} onChange={(event) => setReference(event.target.value)} />
        <label htmlFor="retry-stage">Unconfirmed submission</label>
        <input id="retry-stage" aria-label="Unconfirmed submission" type="checkbox" checked={Boolean(stage)} onChange={(event) => setStage(event.target.checked ? "submission_unknown" : "")} />
        <label htmlFor="retry-disabled">Disable retry</label>
        <input id="retry-disabled" aria-label="Disable retry" type="checkbox" checked={disabled} onChange={(event) => setDisabled(event.target.checked)} />
        <output data-testid="retry-guards">{JSON.stringify({
            code,
            prompt,
            reference,
            stage,
            disabled,
            metadataCode: metadata.generationErrorCode,
            metadataStage: metadata.taskStage,
            blocked,
            bulkBlocked: canvasGenerationRetryBlocked(metadata),
            taskBlocked: taskRetryBlocked({ id: "retry-fixture", type: "canvas_image", status: "failed", prompt, attempts: 1, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", errorCode: code, error: "opaque", stage }),
            fingerprintBlocked: canvasFailureRetryBlockedByFingerprint(metadata, input),
            missingInputBlocked: canvasFailureRetryBlockedByFingerprint(metadata),
            unchangedBlocked: unchangedModeratedPrompt(metadata, prompt, input.referenceImages),
            category: explanation.category,
            retryable: explanation.retryable,
            automaticBlocked: explanation.blockAutomaticRetry,
        })}</output>
        <GenerationFailureNotice
            explanation={explanation}
            context={{ stage }}
            retryBlockedByFingerprint={canvasFailureRetryBlockedByFingerprint(metadata, input)}
            retryDisabled={disabled}
            onRetry={() => { if (!blocked) setAttempts((value) => value + 1); }}
            onOpenDetails={() => setDetails((value) => value + 1)}
        />
        <output data-testid="retry-attempts">{attempts}</output>
        <output data-testid="retry-details">{details}</output>
    </section>;
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
    <ConfigProvider>
        <App>
            <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/create?debug=1"]}>
                    <LightCurtainPaddle />
                    <nav>
                        <Link to="/toiv/market">Open catalog</Link>
                        <Link to="/gallery">Open gallery</Link>
                        <Link to="/retry">Open retry</Link>
                    </nav>
                    <Routes>
                        <Route path="/create" element={<>
                            <CreationStudioInspector projectId={null} />
                            <WsCreationDock projectId="policy-fixture" />
                            <GenerationFailureNotice explanation={explainGenerationError({ code: "r18_context_required" })} />
                        </>} />
                        <Route path="/settings" element={<R18SettingsPane />} />
                        <Route path="/toiv/market" element={<MarketPage />} />
                        <Route path="/gallery" element={<>
                            <CreationStudioMediaPool projectId={null} />
                            <PoseGallerySurface mode="browse" />
                        </>} />
                        <Route path="/assets" element={<AssetDestination />} />
                        <Route path="/retry" element={<RetryProbe />} />
                    </Routes>
                </MemoryRouter>
            </QueryClientProvider>
        </App>
    </ConfigProvider>,
);
