import { http } from "@/services/api/request";
import type { ModelCatalogResponse } from "@/lib/system-channel-catalog";

// GET /api/model-catalog（backend/internal/handler/model_catalog.go）。
// Source=frontend 时读 models；Source=system 时读 channels；失败必须抛错，不能伪造空目录。
export async function fetchModelCatalog(signal?: AbortSignal): Promise<ModelCatalogResponse> {
    return http.get<ModelCatalogResponse>("/model-catalog", { signal });
}
