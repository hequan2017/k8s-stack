package server

import (
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"
)

func podLogOptions(c *gin.Context) (*corev1.PodLogOptions, error) {
	pod, err := getKubeTyped().CoreV1().Pods(c.Param("ns")).Get(
		c.Request.Context(), c.Param("name"), metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	container := c.Query("container")
	if container == "" {
		if len(pod.Spec.Containers) == 0 {
			return nil, fmt.Errorf("pod has no containers")
		}
		container = pod.Spec.Containers[0].Name
	}
	opts := &corev1.PodLogOptions{Container: container}
	if v := c.Query("tail"); v != "" {
		var t int64
		fmt.Sscanf(v, "%d", &t)
		opts.TailLines = &t
	}
	if c.Query("previous") == "true" {
		opts.Previous = true
	}
	if c.Query("follow") == "true" {
		opts.Follow = true
	}
	opts.Timestamps = c.Query("timestamps") == "true"
	return opts, nil
}

// handlePodLog returns the last N lines as plain text.
func handlePodLog(c *gin.Context) {
	opts, err := podLogOptions(c)
	if err != nil {
		httpKubeError(c, err)
		return
	}
	req := getKubeTyped().CoreV1().Pods(c.Param("ns")).GetLogs(c.Param("name"), opts)
	data, err := req.DoRaw(c.Request.Context())
	if err != nil {
		httpKubeError(c, err)
		return
	}
	c.Data(http.StatusOK, "text/plain; charset=utf-8", data)
}

// handlePodLogStream streams logs with follow=true, flushing chunks to the client.
func handlePodLogStream(c *gin.Context) {
	opts, err := podLogOptions(c)
	if err != nil {
		httpKubeError(c, err)
		return
	}
	ctx := c.Request.Context()
	stream, err := getKubeTyped().CoreV1().Pods(c.Param("ns")).GetLogs(c.Param("name"), opts).
		Stream(ctx)
	if err != nil {
		httpKubeError(c, err)
		return
	}
	defer stream.Close()

	c.Writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	flusher, _ := c.Writer.(http.Flusher)
	buf := make([]byte, 8192)
	for {
		n, rerr := stream.Read(buf)
		if n > 0 {
			if _, werr := c.Writer.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			if rerr == context.Canceled || rerr == io.EOF {
				return
			}
			return
		}
	}
}

// handleNamespacePodUsage feeds the workload list footer with live metrics.
func handleNamespacePodUsage(c *gin.Context) {
	dyn := getKubeDynamic()
	list, err := dyn.Resource(podMetricsGVR).Namespace(c.Param("ns")).
		List(c.Request.Context(), metav1.ListOptions{})
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"items": []gin.H{}, "error": err.Error()})
		return
	}
	items := []gin.H{}
	cpuTotal, memTotal := int64(0), int64(0)
	for i := range list.Items {
		p := &list.Items[i]
		name, _, _ := nestedString(p.Object, "metadata", "name")
		cpuQ := sumContainersMetric(p.Object, "cpu")
		memQ := sumContainersMetric(p.Object, "memory")
		if cpuQ != nil {
			cpuTotal += cpuQ.MilliValue()
		}
		if memQ != nil {
			memTotal += memQ.Value()
		}
		items = append(items, gin.H{
			"name":   name,
			"cpu":    milliCpu(cpuQ),
			"memory": humanBytesBinary(memOf(memQ)),
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"items":       items,
		"totalCpu":    fmt.Sprintf("%dm", cpuTotal),
		"totalMemory": humanBytesBinary(memTotal),
	})
}

func getKubeTyped() kubernetes.Interface {
	kc, err := getKube()
	if err != nil {
		return nil
	}
	return kc.Typed
}

var podMetricsGVR = schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods"}

func nestedString(obj map[string]interface{}, path ...string) (string, bool, error) {
	return unstructured.NestedString(obj, path...)
}

// sumContainersMetric sums usage.<metric> across containers of one metrics pod entry.
func sumContainersMetric(obj map[string]any, metric string) *resource.Quantity {
	total := resource.NewQuantity(0, resource.DecimalSI)
	foundAny := false
	cs, found, _ := unstructured.NestedSlice(obj, "containers")
	if !found {
		return nil
	}
	for _, ci := range cs {
		cm, ok := ci.(map[string]interface{})
		if !ok {
			continue
		}
		s, f, _ := unstructured.NestedString(cm, "usage", metric)
		if !f || s == "" {
			continue
		}
		q, err := resource.ParseQuantity(s)
		if err != nil {
			continue
		}
		if metric == "memory" {
			memTotal := resource.NewQuantity(total.Value(), resource.BinarySI)
			memTotal.Add(q)
			total = memTotal
		} else {
			total.Add(q)
		}
		foundAny = true
	}
	if !foundAny {
		return nil
	}
	return total
}

func qStr(q *resource.Quantity) string {
	if q == nil {
		return "-"
	}
	return q.String()
}

func memOf(q *resource.Quantity) int64 {
	if q == nil {
		return 0
	}
	return q.Value()
}
