package handler

import (
	"net/http"
	"strings"
	"sync"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/nasmodels"

	"github.com/gin-gonic/gin"
)

var (
	nasStoreOnce sync.Once
	nasStore     *nasmodels.Store
)

func nasModelsStore(svc *app.Service) *nasmodels.Store {
	nasStoreOnce.Do(func() {
		dir := "."
		if svc != nil && strings.TrimSpace(svc.DataDir()) != "" {
			dir = svc.DataDir()
		}
		nasStore = nasmodels.NewStore(dir)
	})
	return nasStore
}

// RegisterNasModelRoutes exposes Studio local NAS picker + bind progress.
// Gate already proxies /api/* to canvas-api; do not dual-write Python apps/api.
func RegisterNasModelRoutes(r *gin.RouterGroup, svc *app.Service) {
	store := nasModelsStore(svc)
	r.GET("/nas/models", func(c *gin.Context) {
		group := c.Query("group")
		inv, err := store.Inventory(group)
		if err != nil {
			fail(c, http.StatusNotFound, err)
			return
		}
		bindings, _ := store.ReadBindings()
		ok(c, gin.H{
			"inventory": inv,
			"bindings":  bindings,
			"defaults":  nasmodels.LocalDefaults(),
		})
	})
	r.GET("/nas/models/defaults", func(c *gin.Context) {
		ok(c, nasmodels.LocalDefaults())
	})
	r.POST("/nas/models/bind", func(c *gin.Context) {
		var body struct {
			RelPath string `json:"rel_path"`
			Group   string `json:"group"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		job, err := store.StartBind(body.RelPath, body.Group)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		ok(c, job)
	})
	r.GET("/nas/models/bind/:jobId", func(c *gin.Context) {
		job, found := store.Job(c.Param("jobId"))
		if !found {
			fail(c, http.StatusNotFound, errJobMissing)
			return
		}
		ok(c, job)
	})
}

var errJobMissing = errString("绑定任务不存在或已过期")

type errString string

func (e errString) Error() string { return string(e) }
