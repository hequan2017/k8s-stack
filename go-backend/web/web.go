// Package web embeds the built Vue frontend into the binary.
package web

import (
	"embed"
	"io/fs"
	"net/http"

	"github.com/gin-gonic/gin"
)

//go:embed all:dist
var distFS embed.FS

func StaticAssets() (index gin.HandlerFunc, assets gin.HandlerFunc, err error) {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil, nil, err
	}
	fileServer := http.FileServer(http.FS(sub))

	indexHandler := func(c *gin.Context) {
		data, rerr := fs.ReadFile(sub, "index.html")
		if rerr != nil {
			c.String(http.StatusNotFound, "frontend not built")
			return
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", data)
	}
	assetsHandler := func(c *gin.Context) {
		fileServer.ServeHTTP(c.Writer, c.Request)
	}
	return indexHandler, assetsHandler, nil
}
