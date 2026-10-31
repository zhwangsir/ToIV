import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { CreationStudioMediaPool } from "@/components/create/creation-studio-media-pool";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", !params.has("light"));

function textAsset(id: string, title: string, nsfw = false): Asset {
    return {
        id,
        kind: "text",
        title,
        coverUrl: "",
        tags: ["角色"],
        data: { content: title },
        metadata: nsfw ? { nsfw: true } : {},
        createdAt: "2026-10-27T00:00:00Z",
        updatedAt: "2026-10-27T00:00:00Z",
    };
}

const assets = params.has("empty")
    ? []
    : params.has("hidden")
        ? [{ ...textAsset("unrated", "未评级参考"), metadata: { content_rating: "unrated" } }]
        : [textAsset("normal", "雨夜天台"), textAsset("adult", "成人参考", true)];
await useAssetStore.persist.rehydrate();
useAssetStore.setState({ assets, hydrated: !params.has("loading") });

createRoot(document.getElementById("root")!).render(
    <MemoryRouter>
        <main style={{ width: 320, margin: "24px auto", padding: 16, background: "var(--toiv-surface)" }}>
            <CreationStudioMediaPool projectId={null} />
        </main>
    </MemoryRouter>,
);
