package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	v1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true }, // same-origin UI; dev tools only
}

// wsAuth adapts bearer-token auth for websocket endpoints (token travels in the query string).
func wsAuth(next gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !AuthEnabled() {
			next(c)
			return
		}
		tok := bearer(c)
		if tok == "" || !auth.valid(tok) {
			c.String(http.StatusUnauthorized, "unauthorized")
			return
		}
		next(c)
	}
}

// wsPty bridges a gorilla websocket to client-go's remotecommand stream.
type wsPty struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
	sizeCh  chan remotecommand.TerminalSize
	ctx     context.Context
	cancel  context.CancelFunc
	doneCh  chan struct{}
}

func (p *wsPty) Read(buf []byte) (int, error) {
	for {
		msgType, data, err := p.conn.ReadMessage()
		if err != nil {
			return 0, err
		}
		switch msgType {
		case websocket.TextMessage:
			// control frames are JSON; stdin payload arrives as plain text
			var ctrl struct {
				Type   string `json:"type"`
				Cols   int    `json:"cols"`
				Rows   int    `json:"rows"`
			}
			if json.Unmarshal(data, &ctrl) == nil && ctrl.Type != "" {
				if ctrl.Type == "resize" && ctrl.Cols > 0 && ctrl.Rows > 0 {
					select {
					case p.sizeCh <- remotecommand.TerminalSize{Width: uint16(ctrl.Cols), Height: uint16(ctrl.Rows)}:
					default:
					}
				}
				continue
			}
		case websocket.BinaryMessage:
			// some clients send binary stdin directly
		case websocket.CloseMessage:
			return 0, fmt.Errorf("client closed")
		}
		n := copy(buf, data)
		return n, nil
	}
}

func (p *wsPty) Write(buf []byte) (int, error) {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.conn.WriteMessage(websocket.BinaryMessage, buf); err != nil {
		return 0, err
	}
	return len(buf), nil
}

// Next satisfies remotecommand.TerminalSizeQueue.
func (p *wsPty) Next() *remotecommand.TerminalSize {
	select {
	case size := <-p.sizeCh:
		return &size
	case <-p.ctx.Done():
		return nil
	}
}

// handleExec upgrades GET /ws/exec/:namespace/:podname?container=&shell= into a PTY session.
func handleExec(c *gin.Context) {
	ns := c.Param("namespace")
	podName := c.Param("podname")
	container := c.Query("container")
	// try bash first, fall back to any available shell inside the container
	shell := c.Query("shell")
	if shell == "" {
		shell = `command -v bash >/dev/null 2>&1 && exec bash --login || exec sh`
	} else {
		shell = "exec " + shell
	}

	kc, err := getKube()
	if err != nil {
		httpKubeError(c, err)
		return
	}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pty := &wsPty{
		conn:   conn,
		sizeCh: make(chan remotecommand.TerminalSize, 4),
		ctx:    ctx,
		cancel: cancel,
		doneCh: make(chan struct{}),
	}

	req := kc.Typed.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(ns).Name(podName).SubResource("exec").
		VersionedParams(&v1.PodExecOptions{
			Command:   []string{"sh", "-c", shell},
			Container: container,
			Stdin:     true,
			Stdout:    true,
			Stderr:    true,
			TTY:       true,
		}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(kc.RestConfig, http.MethodPost, req.URL())
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("executor init failed: "+err.Error()))
		return
	}

	go func() {
		defer cancel()
		err := executor.StreamWithContext(ctx, remotecommand.StreamOptions{
			Stdin:             pty,
			Stdout:            pty,
			Stderr:            pty,
			Tty:               true,
			TerminalSizeQueue: pty,
		})
		if err != nil && ctx.Err() == nil {
			pty.writeMu.Lock()
			conn.WriteMessage(websocket.TextMessage, []byte("\r\n[会话结束] "+err.Error()+"\r\n"))
			pty.writeMu.Unlock()
		}
		close(pty.doneCh)
	}()

	// block until either side goes away
	select {
	case <-pty.doneCh:
	case <-c.Request.Context().Done():
	}
	cancel()
	conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(2*time.Second))
}
