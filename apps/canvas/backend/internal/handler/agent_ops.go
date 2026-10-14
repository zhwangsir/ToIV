package handler

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/gin-gonic/gin"

	"infinite-canvas/backend/internal/agentops"
	"infinite-canvas/backend/internal/app"
	httptransport "infinite-canvas/backend/internal/transport/http"
)

// agentOpsMaxBody 与画布 PUT 上限对齐：文档提交会带上整份画布，1MB 不够。
const agentOpsMaxBody = 5 << 20

// RegisterAgentOpsRoutes 暴露统一操作层：CLI、MCP 与内置 pi 都调用同一组端点，
// 不各自打开数据库或另起 worker。
func RegisterAgentOpsRoutes(r gin.IRouter, svc *app.Service, store *agentops.Store, clients *agentops.ClientRegistry) *agentops.Registry {
	registry := agentops.NewRegistry(svc, store)
	agentops.RegisterDefaultOps(registry)

	r.GET("/ops", func(c *gin.Context) {
		if !isTrustedOpsSource(c.Request) {
			opsSourceDenied(c, "操作层只接受本机请求")
			fail(c, http.StatusForbidden, app.BadAuthRequest("操作层只接受本机请求"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		caller, clientLabel, authErr := resolveCaller(c, svc, clients)
		if authErr != nil {
			fail(c, http.StatusForbidden, app.BadAuthRequest(authErr.Error()))
			return
		}
		// 能力发现只按调用者身份过滤可见集合；内置宿主在回合之外没有画布范围。
		scope, _, scopeErr := assistantScopeForRequest(c, svc, user.ID, isAssistantHostRequest(c, svc))
		if scopeErr != nil {
			fail(c, http.StatusForbidden, app.BadAuthRequest(scopeErr.Error()))
			return
		}
		caller = withRequestScope(caller, scope)
		ok(c, gin.H{"ops": registry.List(caller), "readOnly": caller.ReadOnly, "client": clientLabel, "caller": caller.Kind})
	})

	r.POST("/ops/clients", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, app.BadAuthRequest("客户端登记只接受本机请求"))
			return
		}
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return
		}
		if !requireOwner(c, svc) {
			return
		}
		var req struct {
			Label string `json:"label"`
			Mode  string `json:"mode"`
			Kind  string `json:"kind"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体无效"))
			return
		}
		reg, token, err := clients.RegisterKind(req.Kind, req.Label, agentops.ClientMode(req.Mode))
		if err != nil {
			opErr := agentops.AsError(err)
			c.JSON(agentops.HTTPStatus(opErr.Code), gin.H{"code": agentops.HTTPStatus(opErr.Code), "reason": opErr.Reason, "msg": opErr.Message})
			return
		}
		// token 只在本次响应返回一次，服务端只保存哈希。
		ok(c, gin.H{"client": gin.H{"id": reg.ID, "label": reg.Label, "kind": reg.Kind, "mode": reg.Mode}, "token": token})
	})

	r.GET("/ops/clients", func(c *gin.Context) {
		if !isLoopbackRequest(c.Request) {
			fail(c, http.StatusForbidden, app.BadAuthRequest("客户端登记只接受本机请求"))
			return
		}
		if !requireOwner(c, svc) {
			return
		}
		ok(c, gin.H{"clients": clients.List()})
	})

	r.POST("/ops/:op", func(c *gin.Context) {
		// 来源准入：本机回环沿用原语义；Web 入口经反向代理时要求 Origin
		// 与 CANVAS_OPS_TRUSTED_ORIGINS 精确匹配（见 isTrustedOpsSource）。
		if !isTrustedOpsSource(c.Request) {
			opsSourceDenied(c, "操作层只接受本机请求")
			fail(c, http.StatusForbidden, app.BadAuthRequest("操作层只接受本机请求"))
			return
		}
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		body, err := io.ReadAll(io.LimitReader(c.Request.Body, agentOpsMaxBody+1))
		if err != nil {
			fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体读取失败"))
			return
		}
		if int64(len(body)) > agentOpsMaxBody {
			fail(c, http.StatusRequestEntityTooLarge, app.BadAuthRequest("请求体超过 5MB 限制"))
			return
		}
		// 只读能力只由客户端身份（登记模式）决定：请求体不接受 readOnly，
		// 免得调用方误以为声明一个字段就能改能力模式。
		var req struct {
			OpID   string          `json:"opId"`
			Params json.RawMessage `json:"params"`
		}
		if len(strings.TrimSpace(string(body))) > 0 {
			if err := json.Unmarshal(body, &req); err != nil {
				fail(c, http.StatusBadRequest, app.BadAuthRequest("请求体不是合法 JSON"))
				return
			}
		}
		caller, clientLabel, authErr := resolveCaller(c, svc, clients)
		if authErr != nil {
			fail(c, http.StatusForbidden, app.BadAuthRequest(authErr.Error()))
			return
		}
		_ = clientLabel
		// 回合归属只认内置宿主：外部客户端出示 turn 头会被明确拒绝，而不是静默忽略后
		// 让一次外部写入被误当成助手的改动（撤销会因此抹掉外部修改）。
		scope, turnID, scopeErr := assistantScopeForRequest(c, svc, user.ID, isAssistantHostRequest(c, svc))
		if scopeErr != nil {
			fail(c, http.StatusForbidden, app.BadAuthRequest(scopeErr.Error()))
			return
		}
		caller = withRequestScope(caller, scope)
		result, execErr := registry.Execute(agentops.Request{
			Context: c.Request.Context(),
			OpID:    req.OpID, Op: c.Param("op"), UserID: user.ID, Caller: caller, Params: req.Params,
			TurnID: turnID,
		})
		if execErr != nil {
			opErr := agentops.AsError(execErr)
			c.JSON(agentops.HTTPStatus(opErr.Code), gin.H{
				"code": agentops.HTTPStatus(opErr.Code), "reason": opErr.Reason, "msg": opErr.Message,
				"details": opErr.Details,
			})
			return
		}
		ok(c, result)
	})
	return registry
}

// resolveCaller 决定本次调用的身份与能力模式。
// 已登记的客户端：模式完全由服务端登记决定，请求体/请求头都不能自行提升或改变。
// 内置助手宿主：凭自己那份后端注入的宿主凭据拿到读写；页面的 UI 会话凭据不在这里。
// owner 通道是手工 UI 与本机直连的身份。
func resolveCaller(c *gin.Context, svc *app.Service, clients *agentops.ClientRegistry) (agentops.Caller, string, error) {
	if isAssistantHostRequest(c, svc) {
		return agentops.Caller{Kind: agentops.CallerAssistant}, "assistant-host", nil
	}
	clientID := strings.TrimSpace(c.GetHeader("X-Beeftv-Client"))
	if clientID != "" {
		token := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
		reg, found := clients.Lookup(clientID, token)
		if !found {
			return agentops.Caller{}, "", errUnknownClient
		}
		return agentops.Caller{Kind: agentops.CallerExternal, ReadOnly: reg.Mode == agentops.ClientReadOnly}, reg.Label, nil
	}
	if agentops.OwnerTokenMatches(svc.DataDir(), strings.TrimSpace(c.GetHeader("X-Beeftv-Owner"))) {
		return agentops.Caller{Kind: agentops.CallerManual}, "owner", nil
	}
	if trustedDesktopUI(c) {
		return agentops.Caller{Kind: agentops.CallerManual}, "desktop-ui", nil
	}
	// B1 (ProfileServer): DesktopTrust is unset; a workspace session that already
	// passed layer A (ToIV/gate/user identity) is CallerManual — same hosted
	// policy as requireTrustedDesktopWritePrincipal when DesktopTrust == nil.
	if hostedWorkspaceSession(c) {
		return agentops.Caller{Kind: agentops.CallerManual}, "hosted-workspace", nil
	}
	return agentops.Caller{}, "", errUnidentified
}

func trustedDesktopUI(c *gin.Context) bool {
	if c == nil || c.Request == nil || !isLoopbackRequest(c.Request) {
		return false
	}
	dependencies, ok := runtimeDependencies(c)
	if !ok || dependencies.DesktopTrust == nil {
		return false
	}
	return dependencies.DesktopTrust(c.Request)
}

// hostedWorkspaceSession reports ProfileServer / hosted ops callers that already
// cleared layer A. Desktop profiles keep DesktopTrust set and never take this path.
func hostedWorkspaceSession(c *gin.Context) bool {
	if c == nil {
		return false
	}
	dependencies, ok := runtimeDependencies(c)
	if !ok || dependencies.DesktopTrust != nil {
		return false
	}
	if multiTenantRequest(c) {
		return true
	}
	if c.Request == nil {
		return false
	}
	if _, ok := httptransport.IdentityFrom(c.Request); ok {
		return true
	}
	return httptransport.ToivAuthenticated(c.Request) || httptransport.GateAuthenticated(c.Request)
}

// requireTrustedDesktopWritePrincipal is the creation.write principal check.
// Registered client tokens only skip the launch token on /api/ops; they cannot
// take these writes even when a launch token is also present.
// Hosted runtimes leave DesktopTrust unset and still allow the workspace owner.
func requireTrustedDesktopWritePrincipal(c *gin.Context, message string) bool {
	if strings.TrimSpace(c.GetHeader("X-Beeftv-Client")) != "" {
		fail(c, http.StatusForbidden, app.Forbidden(message))
		return false
	}
	dependencies, ok := runtimeDependencies(c)
	if !ok || dependencies.DesktopTrust == nil {
		return true
	}
	if !trustedDesktopUI(c) {
		fail(c, http.StatusForbidden, app.Forbidden(message))
		return false
	}
	return true
}

func resolveClientMode(c *gin.Context, svc *app.Service, clients *agentops.ClientRegistry) (bool, string, error) {
	caller, label, err := resolveCaller(c, svc, clients)
	return caller.ReadOnly, label, err
}

func withRequestScope(caller agentops.Caller, scope *agentops.AssistantScope) agentops.Caller {
	if scope != nil {
		caller.Scope = scope
	}
	return caller
}

type clientAuthError struct{ message string }

func (e clientAuthError) Error() string { return e.message }

var (
	errUnknownClient = clientAuthError{"未登记或凭据无效的 Agent 客户端"}
	errUnidentified  = clientAuthError{"缺少可信身份：需要已登记的客户端凭据、owner 凭据或受信任的桌面界面"}
)

// loopbackHosts 是允许访问本机操作层的主机名；后续 Wails 正式 origin 也在这里登记。
var loopbackHosts = map[string]bool{"127.0.0.1": true, "localhost": true, "::1": true}

func isLoopbackHost(host string) bool {
	name, _, err := net.SplitHostPort(host)
	if err != nil {
		name = host // 无端口时按主机名处理
	}
	name = strings.Trim(name, "[]")
	return loopbackHosts[strings.ToLower(name)]
}

// isLoopbackRequest 精确校验来源：Host、Origin 与 RemoteAddr 都必须是本机。
// 不用子串匹配，避免 localhost.attacker.example 或任意 loopback 端口被误当成同源。
func isLoopbackRequest(r *http.Request) bool {
	if !isLoopbackHost(r.Host) {
		return false
	}
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteHost = r.RemoteAddr
	}
	if !isLoopbackHost(remoteHost) {
		return false
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if httptransport.DesktopAuthenticated(r) && (origin == "wails://wails" || origin == "http://wails.localhost" || origin == "https://wails.localhost") {
		return true
	}
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	// 同源必须 host 与端口都一致：仅“是 loopback”不够，任意 loopback 端口都不算同源。
	if strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	// 反向代理（Web 入口）转发后 Host 是后端自身地址、Origin 是前端入口地址，
	// 同源判断永远不成立；这种情况由显式配置的可信 Origin 兜底。
	if matchTrustedOpsOrigin(origin) {
		return true
	}
	for _, allowed := range allowedOrigins() {
		if strings.EqualFold(strings.TrimRight(allowed, "/"), strings.TrimRight(origin, "/")) {
			return true
		}
	}
	return false
}

// opsTrustedOriginsEnv 显式登记 Web 入口（反向代理）的正式 Origin，逗号分隔。
// 例：CANVAS_OPS_TRUSTED_ORIGINS=http://192.168.71.47:3100,https://toiv.wineryz.top
// 只接受精确的 http/https Origin（协议+主机+端口完全一致），不支持通配符；
// 未配置时非回环请求一律维持原有安全行为。
const opsTrustedOriginsEnv = "CANVAS_OPS_TRUSTED_ORIGINS"

// opsOrigin 是归一化后的 Origin：小写 scheme + 小写 host（含端口，默认端口已省略）。
type opsOrigin struct {
	scheme string
	host   string
}

// normalizeOpsOrigin 解析并归一化一个 Origin 字符串；不是纯 http/https 来源
// （带路径/查询/碎片/用户信息、其他协议、空主机）一律不通过。
func normalizeOpsOrigin(raw string) (opsOrigin, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return opsOrigin{}, false
	}
	if parsed.User != nil || parsed.Opaque != "" ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return opsOrigin{}, false
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" || strings.ContainsAny(hostname, "*?") {
		return opsOrigin{}, false
	}
	host := hostname
	if strings.Contains(hostname, ":") { // IPv6 字面量补回方括号
		host = "[" + hostname + "]"
	}
	if port := parsed.Port(); port != "" {
		if !((parsed.Scheme == "http" && port == "80") || (parsed.Scheme == "https" && port == "443")) {
			host += ":" + port
		}
	}
	return opsOrigin{scheme: strings.ToLower(parsed.Scheme), host: host}, true
}

// trustedOpsOrigins 读取并解析配置；非法条目跳过（不 panic、不整表失效）。
func trustedOpsOrigins() []opsOrigin {
	raw := strings.TrimSpace(os.Getenv(opsTrustedOriginsEnv))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]opsOrigin, 0, len(parts))
	for _, item := range parts {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		if origin, ok := normalizeOpsOrigin(trimmed); ok {
			out = append(out, origin)
		}
	}
	return out
}

// matchTrustedOpsOrigin 报告 Origin 是否与配置的可信来源精确匹配（协议/主机/端口）。
func matchTrustedOpsOrigin(origin string) bool {
	if strings.TrimSpace(origin) == "" {
		return false
	}
	normalized, ok := normalizeOpsOrigin(origin)
	if !ok {
		return false
	}
	for _, trusted := range trustedOpsOrigins() {
		if trusted == normalized {
			return true
		}
	}
	return false
}

// isTrustedOpsSource 是操作层与内置助手入口的统一来源准入：
//   - 回环请求沿用 isLoopbackRequest 原语义（桌面/CLI/同机宿主子进程不变）；
//   - Host 非回环（反向代理保留外部 Host 的形态）仅当「Origin 与
//     CANVAS_OPS_TRUSTED_ORIGINS 精确匹配」且「来源仍是本机进程（回环 RemoteAddr，
//     即同机代理转发）」时放行；
//   - 未配置可信 Origin 时非回环请求一律拒绝，不自动放开。
func isTrustedOpsSource(r *http.Request) bool {
	if isLoopbackRequest(r) {
		return true
	}
	if len(trustedOpsOrigins()) == 0 {
		return false
	}
	remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteHost = r.RemoteAddr
	}
	if !isLoopbackHost(remoteHost) {
		return false
	}
	return matchTrustedOpsOrigin(r.Header.Get("Origin"))
}

// opsSourceDenied 记录被拒请求的来源画像（方法/路径/Host/Origin/远端地址），
// 不含任何凭据头，用于排查代理链路与可信 Origin 配置。
func opsSourceDenied(c *gin.Context, reason string) {
	if c == nil || c.Request == nil {
		return
	}
	r := c.Request
	log.Printf("ops_source_denied reason=%q method=%s path=%s host=%q origin=%q remote=%s",
		reason, r.Method, r.URL.Path, r.Host, strings.TrimSpace(r.Header.Get("Origin")), r.RemoteAddr)
}

// allowedOrigins 允许显式配置的正式前端 Origin（例如 Wails 宿主页面）。
func allowedOrigins() []string {
	raw := strings.TrimSpace(os.Getenv("BEEFTV_ALLOWED_ORIGINS"))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, item := range parts {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
