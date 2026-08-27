// kubestack-console: an open-source Kubernetes management platform
// (KubeSphere-style UX) with integrated sandbox management.
package main

import (
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"kubestack/console/internal/config"
	"kubestack/console/internal/kube"
	"kubestack/console/internal/sandbox"
	"kubestack/console/internal/server"
)

func main() {
	cfg := config.Load()
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	if _, err := kube.Get(); err != nil {
		log.Fatalf("kubernetes client init failed: %v", err)
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(recoveryLogger())
	r.MaxMultipartMemory = 8 << 20

	server.InitAuth(cfg.AdminPassword, cfg.SessionTTLHours)
	server.InitSandbox(cfg)
	if err := server.InitResources(); err != nil {
		log.Printf("WARN resource discovery incomplete: %v (continuing; CRDs may still work)", err)
	}
	sandbox.StartJanitor(60 * time.Second)

	if err := server.Register(r); err != nil {
		log.Fatalf("route registration failed: %v", err)
	}

	addr := ":" + cfg.Port
	log.Printf("kubestack-console listening on %s (auth=%v)", addr, cfg.AdminPassword != "")
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("http server: %v", err)
	}
}

func recoveryLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic on %s %s: %v", c.Request.Method, c.Request.URL.Path, rec)
				c.AbortWithStatus(500)
			}
		}()
		c.Next()
	}
}
