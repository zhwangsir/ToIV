package bootstrap

import (
	"time"

	"github.com/gin-gonic/gin"

	httptransport "infinite-canvas/backend/internal/transport/http"
)

type Profile string

const (
	ProfileServer  Profile = "server"
	ProfileDesktop Profile = "desktop"
)

type Config struct {
	Profile          Profile
	DataDir          string
	DatabaseDriver   string
	DatabaseURL      string
	ListenAddr       string
	LaunchToken      string
	AutoMigrate      bool
	ShutdownTimeout  time.Duration
	RouterMiddleware []gin.HandlerFunc
	// GateIdentity (server profile, gate-managed pool): every request except health and the
	// local assistant host's ops calls must carry an identity signed by the login gate.
	GateIdentity *httptransport.GateIdentity
	// ToivAuth (M4-4): accept ToIV bearer tokens (introspected against /api/auth/me) as an
	// alternative way in; the only guard when GateIdentity is nil (gate-retired end state).
	ToivAuth *httptransport.ToivJWTAuth
}

func (c Config) withDefaults() Config {
	if c.Profile == "" {
		c.Profile = ProfileServer
	}
	if c.DatabaseDriver == "" {
		c.DatabaseDriver = "sqlite"
	}
	if c.ListenAddr == "" {
		if c.Profile == ProfileDesktop {
			c.ListenAddr = "127.0.0.1:0"
		} else {
			c.ListenAddr = ":8080"
		}
	}
	if c.ShutdownTimeout <= 0 {
		c.ShutdownTimeout = 10 * time.Minute
	}
	return c
}
