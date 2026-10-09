package nasmodels

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Env vars for optional Comfy object_info refresh after bind.
// Canvas-api has no full Comfy client; this is a best-effort GET only.
const (
	EnvImageComfyBase = "TOIV_IMAGE_COMFY_BASE_URL" // e.g. http://100.68.100.90:8196
	EnvH3ComfyBase    = "TOIV_H3_BASE_URL"          // e.g. http://100.68.100.90:8264
	EnvObjectInfoURL  = "TOIV_COMFY_OBJECT_INFO_URL" // full URL override
)

// Forbidden as product image/H3 defaults (试验/禁碰口).
var forbiddenWorkerLabels = map[string]struct{}{
	":8195": {}, // H3 试验
	":8205": {},
	":8261": {},
	":8263": {},
}

func normalizeWorkerLabel(raw string) string {
	w := strings.TrimSpace(raw)
	if w == "" {
		return ""
	}
	if !strings.HasPrefix(w, ":") && strings.HasPrefix(w, "http") {
		// allow full URL to pass through as base, not label
		return w
	}
	if !strings.HasPrefix(w, ":") {
		w = ":" + strings.TrimPrefix(w, "port")
	}
	return w
}

func IsForbiddenWorker(label string) bool {
	_, ok := forbiddenWorkerLabels[normalizeWorkerLabel(label)]
	return ok
}

func DefaultWorkerForGroup(group string) string {
	switch strings.ToLower(strings.TrimSpace(group)) {
	case "h3":
		return DefaultH3Worker
	case "image", "main":
		return DefaultImageWorker
	default:
		return DefaultImageWorker
	}
}

func ResolveWorkerLabel(group, requested string) (string, error) {
	w := normalizeWorkerLabel(requested)
	if w == "" {
		w = DefaultWorkerForGroup(group)
	}
	if IsForbiddenWorker(w) {
		return "", fmt.Errorf("worker %s 禁止用于产品绑定（试验/禁碰口）", w)
	}
	// Image must stay on :8196 production gpu0-alt (LB :8188 入口映射到 :8196)；非试验床。
	if group == "image" || group == "main" {
		if w == ":8188" {
			w = DefaultImageWorker
		}
		if w != DefaultImageWorker {
			return "", fmt.Errorf("生图绑定仅允许 worker %s（LB :8188）；收到 %s", DefaultImageWorker, w)
		}
		return w, nil
	}
	if group == "h3" && w != DefaultH3Worker {
		return "", fmt.Errorf("H3 绑定仅允许 worker %s；收到 %s", DefaultH3Worker, w)
	}
	return w, nil
}

func objectInfoBaseForWorker(group, worker string) string {
	if u := strings.TrimSpace(os.Getenv(EnvObjectInfoURL)); u != "" {
		return strings.TrimRight(u, "/")
	}
	switch group {
	case "h3":
		if u := strings.TrimSpace(os.Getenv(EnvH3ComfyBase)); u != "" {
			return strings.TrimRight(u, "/")
		}
	default:
		if u := strings.TrimSpace(os.Getenv(EnvImageComfyBase)); u != "" {
			return strings.TrimRight(u, "/")
		}
	}
	_ = worker
	return ""
}

// tryObjectInfoRefresh best-effort GET /object_info. Returns refreshed=true only on HTTP 200.
// When no base URL is configured, refreshed=false and hint keeps 设备管家口径.
func tryObjectInfoRefresh(group, worker string) (refreshed bool, detail string) {
	base := objectInfoBaseForWorker(group, worker)
	if base == "" {
		return false, SwapHint
	}
	url := base
	if !strings.Contains(base, "/object_info") {
		url = strings.TrimRight(base, "/") + "/object_info"
	}
	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return false, SwapHint + "（refresh 构造失败）"
	}
	resp, err := client.Do(req)
	if err != nil {
		return false, SwapHint + "（object_info 不可达：" + err.Error() + "）"
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Sprintf("%s（object_info HTTP %d）", SwapHint, resp.StatusCode)
	}
	return true, "object_info 已刷新；若列表仍旧请重启该 worker " + worker
}
