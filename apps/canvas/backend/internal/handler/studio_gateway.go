package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"infinite-canvas/backend/internal/operations"
)

const studioGatewayMaxBody = 4 << 20

type studioGateway struct {
	baseURL string
	tokens  *uiSessionStore
	client  *http.Client
}

func newStudioGateway(baseURL string, tokens *uiSessionStore) *studioGateway {
	return &studioGateway{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"), tokens: tokens,
		client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
}

func configuredStudioGateway(tokens *uiSessionStore) *studioGateway {
	baseURL := strings.TrimSpace(os.Getenv("CANVAS_TOIV_AUTH_BASE"))
	if baseURL == "" {
		return nil
	}
	return newStudioGateway(baseURL, tokens)
}

func (g *studioGateway) Project(ctx context.Context, userID, projectID string) (map[string]any, error) {
	return g.request(ctx, userID, http.MethodGet, "/api/studio/projects/"+url.PathEscape(projectID), nil)
}

func (g *studioGateway) Estimate(ctx context.Context, userID, projectID, shotID string) (map[string]any, error) {
	path := "/api/studio/projects/" + url.PathEscape(projectID) + "/render-estimate"
	if strings.TrimSpace(shotID) != "" {
		detail, err := g.Project(ctx, userID, projectID)
		if err != nil {
			return nil, err
		}
		if !studioProjectOwnsShot(detail, shotID) {
			return nil, operations.NotFound("studio_shot_not_in_project", "镜头不属于本次显式授权的 Studio 项目")
		}
		path = "/api/studio/shots/" + url.PathEscape(shotID) + "/render-estimate"
	}
	return g.request(ctx, userID, http.MethodPost, path, []byte("{}"))
}

func studioProjectOwnsShot(detail map[string]any, shotID string) bool {
	shots, _ := detail["shots"].([]any)
	for _, rawShot := range shots {
		shot, _ := rawShot.(map[string]any)
		id, _ := shot["id"].(string)
		if strings.TrimSpace(id) == strings.TrimSpace(shotID) {
			return true
		}
	}
	return false
}

func (g *studioGateway) request(ctx context.Context, userID, method, path string, body []byte) (map[string]any, error) {
	token, ok := g.tokens.delegatedStudioToken(userID)
	if !ok {
		return nil, operations.PermissionDenied("studio_delegation_required", "需要有效的 Studio 只读委托，请重新签发助手会话")
	}
	base, err := url.Parse(g.baseURL)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, operations.Unsupported("studio_gateway_unavailable", "Studio 只读网关配置不可用")
	}
	request, err := http.NewRequestWithContext(ctx, method, g.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, operations.Unsupported("studio_gateway_unavailable", "Studio 只读请求无法构造")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := g.client.Do(request)
	if err != nil {
		return nil, operations.Unsupported("studio_upstream_unavailable", "Studio 只读服务暂不可用")
	}
	defer response.Body.Close()
	payload, readErr := io.ReadAll(io.LimitReader(response.Body, studioGatewayMaxBody+1))
	if readErr != nil {
		return nil, operations.Unsupported("studio_upstream_unavailable", "Studio 只读响应无法读取")
	}
	if len(payload) > studioGatewayMaxBody {
		return nil, operations.Unsupported("studio_response_too_large", "Studio 只读响应超过限制")
	}
	if response.StatusCode/100 != 2 {
		return nil, studioUpstreamStatusError(response.StatusCode)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, operations.Unsupported("studio_invalid_response", "Studio 只读服务返回了无效响应")
	}
	return decoded, nil
}

func studioUpstreamStatusError(status int) error {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return operations.PermissionDenied("studio_delegation_required", "Studio 委托无效或已过期")
	case http.StatusNotFound:
		return operations.NotFound("studio_project_not_found", "Studio 项目或镜头不存在，或不属于当前用户")
	case http.StatusConflict, http.StatusUnprocessableEntity:
		return operations.Conflict("studio_estimate_blocked", "Studio 成本预估被当前生产状态阻止", nil)
	default:
		return operations.Unsupported("studio_upstream_unavailable", "Studio 只读服务拒绝了请求")
	}
}

var _ operations.StudioGateway = (*studioGateway)(nil)
