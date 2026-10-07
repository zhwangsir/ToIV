package handler

import (
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/model"
	httptransport "infinite-canvas/backend/internal/transport/http"
	"infinite-canvas/backend/internal/workspace"

	"github.com/gin-gonic/gin"
)

const identityContextKey = "canvas.identity"

// IdentityWorkspaceResolver maps verified identities to the workspace that owns their rows.
type IdentityWorkspaceResolver interface {
	EnsureIdentityWorkspace(subject string) (string, error)
	AssistantTurnWorkspace(turnID string) (string, error)
	DefaultWorkspaceID() (string, error)
}

// MultiTenantWorkspaceMiddleware replaces the single shared WorkspaceMiddleware scope when
// multi-tenant mode is on (M7). Every request must carry an identity attached by
// httptransport.RequireIdentity; its workspace becomes the owner scope for every
// list/read/update/delete below, because all handlers resolve the owner via currentUser.
func MultiTenantWorkspaceMiddleware(resolver IdentityWorkspaceResolver, dataDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.URL.Path == "/api/health/live" {
			// Liveness carries no tenant data and stays open, as in the gate era.
			c.Next()
			return
		}
		identity, ok := httptransport.IdentityFrom(c.Request)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"code": http.StatusUnauthorized, "reason": "toiv_identity_required", "msg": "请求未通过身份校验"})
			return
		}
		var (
			workspaceID string
			err         error
		)
		switch identity.Kind {
		case httptransport.IdentityAssistantHost:
			// The assistant child acts for the user who opened the turn it presents.
			if turnID := strings.TrimSpace(c.GetHeader(assistantTurnHeader)); turnID != "" {
				if !app.ValidAssistantTurnID(turnID) {
					c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "assistant_turn_invalid", "msg": "回合标识非法"})
					return
				}
				workspaceID, err = resolver.AssistantTurnWorkspace(turnID)
				if err != nil {
					c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "assistant_turn_unknown", "msg": "这一轮对话不存在或已经结束"})
					return
				}
			} else {
				// Outside a turn the host only discovers capabilities; assistantScopeForRequest
				// denies every execution without a turn scope.
				workspaceID, err = resolver.DefaultWorkspaceID()
			}
		default:
			workspaceID, err = resolver.EnsureIdentityWorkspace(identity.UID)
		}
		if err != nil || strings.TrimSpace(workspaceID) == "" {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"code": http.StatusServiceUnavailable, "reason": "workspace_unavailable", "msg": "无法初始化当前用户的工作区"})
			return
		}
		c.Set(workspaceContextKey, workspace.Context{ID: workspaceID, DataDir: dataDir})
		c.Set(identityContextKey, identity)
		if !identity.IsAdmin() && PlatformAdminOnlyRoute(c.Request.Method, c.Request.URL.Path) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": http.StatusForbidden, "reason": "platform_admin_only", "msg": "该功能仅平台管理员可用"})
			return
		}
		c.Next()
	}
}

func requestIdentity(c *gin.Context) (httptransport.Identity, bool) {
	if value, exists := c.Get(identityContextKey); exists {
		if identity, ok := value.(httptransport.Identity); ok {
			return identity, true
		}
	}
	return httptransport.Identity{}, false
}

// multiTenantRequest reports whether the request went through the multi-tenant door.
func multiTenantRequest(c *gin.Context) bool {
	_, ok := requestIdentity(c)
	return ok
}

// platformSecretsVisible: only the platform (gate-signed ops) identity may read stored
// channel credentials. ToIV users — admins included — get the redacted view; the server
// injects platform credentials into their tasks itself.
func platformSecretsVisible(c *gin.Context) bool {
	identity, ok := requestIdentity(c)
	return !ok || identity.Kind == httptransport.IdentityPlatform
}

func applyIdentityRole(c *gin.Context, user *model.User) *model.User {
	if user == nil {
		return nil
	}
	identity, ok := requestIdentity(c)
	if !ok || identity.IsAdmin() {
		return user
	}
	scoped := *user
	scoped.Role = model.UserRoleUser
	return &scoped
}

// PlatformAdminOnlyRoute lists instance-level surfaces that act on state shared by every
// tenant (provider/channel credentials, the single assistant host process, external client
// registry, diagnostics bundles, the host machine's Eagle library, skill installation).
// Non-admin tenants get 403 there; everything else is owner-scoped data.
func PlatformAdminOnlyRoute(method, path string) bool {
	path = strings.TrimSuffix(path, "/")
	if !strings.HasPrefix(path, "/api/") {
		return false
	}
	rel := strings.TrimPrefix(path, "/api")
	switch {
	case rel == "/workspace/model-config":
		return method != http.MethodGet && method != http.MethodHead
	case strings.HasPrefix(rel, "/assistant/host/"):
		return true
	case strings.HasPrefix(rel, "/beefapi/connection"):
		return method != http.MethodGet && method != http.MethodHead
	case rel == "/ops/clients" || strings.HasPrefix(rel, "/ops/clients/"):
		return true
	case rel == "/agent-clients" || strings.HasPrefix(rel, "/agent-clients/"):
		return true
	case strings.HasPrefix(rel, "/diagnostics/"):
		return true
	case rel == "/eagle" || strings.HasPrefix(rel, "/eagle/"):
		return true
	case strings.HasPrefix(rel, "/skills/install"):
		return true
	}
	return false
}
