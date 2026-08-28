package server

import (
	"github.com/gin-gonic/gin"

	"kubestack/console/web"
)

// Register wires every HTTP route onto the gin engine.
// The generic /api/res engine plus the dedicated endpoints together expose
// the full surface a KubeSphere-style console needs.
func Register(r *gin.Engine) error {
	indexH, assetsH, err := web.StaticAssets()
	if err != nil {
		return err
	}

	r.GET("/", indexH)
	r.GET("/index.html", indexH)
	noCache := func(c *gin.Context) { c.Writer.Header().Set("Cache-Control", "no-store") }
	r.GET("/static/*path", func(c *gin.Context) {
		noCache(c)
		assetsH(c)
	})
	r.GET("/favicon.ico", func(c *gin.Context) { c.Status(204) })

	r.POST("/api/login", handleLogin)
	r.GET("/api/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })

	api := r.Group("/api", requireAuth)
	{
		api.GET("/overview", handleOverview)
		api.GET("/events", handleEvents)
		api.GET("/resources", listDiscovery)
		api.GET("/version", handleVersion)
		api.POST("/apply", handleApply)

		// generic resource engine: works for every core + grouped + CRD kind
		res := api.Group("/res")
		res.GET("/*path", listResources)
		res.POST("/*path", createResource)
		res.PUT("/*path", replaceResource)
		res.PATCH("/*path", patchResource)
		res.DELETE("/*path", deleteResource)

		pods := api.Group("")
		pods.GET("/pods/:ns/:name/log", handlePodLog)
		pods.GET("/pods/:ns/:name/log/stream", handlePodLogStream)
		pods.GET("/namespaces/:ns/pod-usage", handleNamespacePodUsage)

		sbx := api.Group("/sandboxes")
		sbx.GET("", handleSandboxList)
		sbx.GET("/templates", handleSandboxTemplates)
		sbx.GET("/discovered", handleDiscoveredSandboxes)
		sbx.POST("", handleSandboxCreate)
		sbx.POST("/:name/start", handleSandboxStart)
		sbx.POST("/:name/stop", handleSandboxStop)
		sbx.POST("/:name/renew", handleSandboxRenew)
		sbx.PATCH("/:name/description", handleSandboxDescription)
		sbx.DELETE("/:name", handleSandboxDelete)
	}

	wsGroup := r.Group("/ws", wsAuth(requireAuth))
	{
		wsGroup.GET("/exec/:namespace/:podname", handleExec)
	}
	return nil
}
