package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"kubestack/console/internal/config"
	"kubestack/console/internal/sandbox"
)

var appConfig *config.Config

func InitSandbox(cfg *config.Config) { appConfig = cfg }

func handleSandboxTemplates(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"templates": sandbox.Templates()})
}

func handleSandboxCreate(c *gin.Context) {
	var req sandbox.CreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求参数错误: " + err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	ns, err := sandbox.Create(ctx, req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"namespace": ns, "ok": true})
}

func handleSandboxList(c *gin.Context) {
	items, err := sandbox.List(c.Request.Context())
	if err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

func handleSandboxStart(c *gin.Context) {
	if err := sandbox.SetReplicas(c.Request.Context(), c.Param("name"), 1); err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func handleSandboxStop(c *gin.Context) {
	if err := sandbox.SetReplicas(c.Request.Context(), c.Param("name"), 0); err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func handleSandboxRenew(c *gin.Context) {
	var req struct{ Hours float64 `json:"hours"` }
	_ = c.ShouldBindJSON(&req)
	if err := sandbox.Renew(c.Request.Context(), c.Param("name"), req.Hours); err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func handleSandboxDelete(c *gin.Context) {
	if err := sandbox.Delete(c.Request.Context(), c.Param("name")); err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// handleDiscoveredSandboxes surfaces foreign sandbox instances already running
// on the cluster: e2b-style sbx-* pods inside discovery namespaces plus any
// agents.x-k8s.io Sandbox CR objects.
func handleDiscoveredSandboxes(c *gin.Context) {
	out := []gin.H{}

	if appConfig != nil {
		kc, kerr := getKube()
		if kerr == nil {
			for _, nsName := range appConfig.DiscoveryNamespaces {
				pods, perr := kc.Typed.CoreV1().Pods(nsName).
					List(c.Request.Context(), metav1.ListOptions{})
				if perr != nil {
					continue
				}
				for i := range pods.Items {
					pod := &pods.Items[i]
					if !strings.HasPrefix(pod.Name, "sbx") || isControllerPod(pod) {
						continue
					}
					image := ""
					if len(pod.Spec.Containers) > 0 {
						image = pod.Spec.Containers[0].Image
					}
					out = append(out, gin.H{
						"source":    "opensandbox-pods",
						"namespace": pod.Namespace,
						"name":      pod.Name,
						"image":     image,
						"phase":     string(pod.Status.Phase),
						"node":      pod.Spec.NodeName,
						"startedAt": pod.Status.StartTime.Unix(),
						"labels":    pod.Labels,
					})
				}
			}
		}
	}

	list, err := sandbox.ListUnstructured(c.Request.Context(),
		sandbox.GVRFor("agents.x-k8s.io", "v1beta1", "sandboxes"), "")
	if err == nil && list != nil {
		for i := range list.Items {
			sb := &list.Items[i]
			nsn, _, _ := unstructured.NestedString(sb.Object, "metadata", "namespace")
			nmn, _, _ := unstructured.NestedString(sb.Object, "metadata", "name")
			var phase string
			if p, found, _ := unstructured.NestedString(sb.Object, "status", "phase"); found {
				phase = p
			}
			replicas := int64(0)
			if r, ok, _ := unstructured.NestedInt64(sb.Object, "spec", "replicas"); ok {
				replicas = r
			} else if r, ok, _ := unstructured.NestedInt64(sb.Object, "spec", "podTemplate",
				"spec", "replicas"); ok {
				replicas = r
			}
			out = append(out, gin.H{
				"source":    "agents-x-k8s-sandbox",
				"namespace": nsn,
				"name":      nmn,
				"phase":     phaseOf(phase, replicas),
				"replicas":  replicas,
				"startedAt": creationUnix(sb.Object),
			})
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out})
}

func isControllerPod(pod *corev1.Pod) bool {
	// platform console / e2b control-plane components are not sandboxes
	switch {
	case strings.HasPrefix(pod.Name, "sbx-") && len(pod.OwnerReferences) > 0:
		return false // actual sandbox instance owned by the orchestrator
	case strings.HasPrefix(pod.Name, "sbx"):
		return false
	default:
		return true
	}
}

func phaseOf(phase string, replicas int64) string {
	if phase != "" {
		return phase
	}
	if replicas > 0 {
		return "Running"
	}
	return "Stopped"
}

func creationUnix(obj map[string]any) int64 {
	s, found, _ := unstructured.NestedString(obj, "metadata", "creationTimestamp")
	if !found || s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0
	}
	return t.Unix()
}

var _ = strconv.Itoa
