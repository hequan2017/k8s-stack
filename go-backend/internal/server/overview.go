package server

import (
	"context"
	"math/big"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/api/resource"
)

func handleLogin(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad request"})
		return
	}
	if !AuthEnabled() {
		c.JSON(http.StatusOK, gin.H{"token": "", "authEnabled": false})
		return
	}
	if req.Password != adminPassword() || req.Username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码错误"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": auth.issue(), "authEnabled": true})
}

func handleVersion(c *gin.Context) {
	kc, err := getKube()
	if err != nil {
		httpKubeError(c, err)
		return
	}
	sv, _ := kc.Discovery.ServerVersion()
	c.JSON(http.StatusOK, gin.H{
		"platform":        "kubestack-console",
		"platformVersion": "v0.1.0",
		"kubernetes":      sv.GitVersion,
		"authEnabled":     AuthEnabled(),
	})
}

// handleOverview powers the KubeSphere-style dashboard: cluster counts,
// live usage from metrics-server and node health.
func handleOverview(c *gin.Context) {
	kc, err := getKube()
	if err != nil {
		httpKubeError(c, err)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), timeout20s())
	defer cancel()

	counts := gin.H{}
	var wg waitGroup

	wg.Go(func() {
		l, e := kc.Typed.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
		countVal(counts, "namespaces", len(l.Items), e)
	})
	wg.Go(func() {
		l, e := kc.Typed.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
		countVal(counts, "nodes", len(l.Items), e)
	})
	wg.Go(func() {
		l, e := kc.Typed.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
		countVal(counts, "deployments", len(l.Items), e)
	})
	wg.Go(func() {
		l, e := kc.Typed.AppsV1().StatefulSets("").List(ctx, metav1.ListOptions{})
		countVal(counts, "statefulsets", len(l.Items), e)
	})
	wg.Go(func() {
		l, e := kc.Typed.AppsV1().DaemonSets("").List(ctx, metav1.ListOptions{})
		countVal(counts, "daemonsets", len(l.Items), e)
	})
	wg.Go(func() {
		pods, e := kc.Typed.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
		if e != nil {
			countVal(counts, "pods", 0, e)
			return
		}
		running := 0
		for _, p := range pods.Items {
			if p.Status.Phase == corev1.PodRunning {
				running++
			}
		}
		counts["pods"] = len(pods.Items)
		counts["podsRunning"] = running
	})
	wg.Go(func() {
		l, e := kc.Typed.CoreV1().Services("").List(ctx, metav1.ListOptions{})
		countVal(counts, "services", len(l.Items), e)
	})
	wg.Go(func() {
		l, e := kc.Typed.NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{})
		countVal(counts, "ingresses", len(l.Items), e)
	})
	wg.Go(func() {
		l, e := kc.Typed.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
		countVal(counts, "persistentVolumes", len(l.Items), e)
	})
	wg.Go(func() {
		l, e := kc.Typed.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
		countVal(counts, "persistentVolumeClaims", len(l.Items), e)
	})
	wg.Go(func() {
		l, e := kc.Typed.BatchV1().Jobs("").List(ctx, metav1.ListOptions{})
		countVal(counts, "jobs", len(l.Items), e)
	})
	wg.Go(func() {
		l, e := kc.Typed.BatchV1().CronJobs("").List(ctx, metav1.ListOptions{})
		countVal(counts, "cronjobs", len(l.Items), e)
	})

	nodesDetail, usage, topPods := collectUsage(ctx, kc)

	wg.Wait()
	c.JSON(http.StatusOK, gin.H{
		"counts": counts,
		"usage":  usage,
		"nodes":  nodesDetail,
		"topPods": topPods,
	})
}

func countVal(m gin.H, key string, n int, err error) {
	if err != nil {
		m[key] = -1
		return
	}
	m[key] = n
}

// collectUsage gathers node allocatable vs live usage (metrics.k8s.io) and pod ranking.
func collectUsage(ctx context.Context, kc *kubeClients) (nodes []gin.H, usage gin.H, topPods []gin.H) {
	nodeList, err := kc.Typed.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nodes, gin.H{}, topPods
	}

	// usage per node and total
	nodeCPU := map[string]*resource.Quantity{}
	nodeMem := map[string]*resource.Quantity{}
	totalCPU := resource.NewQuantity(0, resource.DecimalSI)
	totalMem := resource.NewQuantity(0, resource.BinarySI)
	if ml, merr := kc.Dynamic.Resource(schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodes"}).
		List(ctx, metav1.ListOptions{}); merr == nil {
		for i := range ml.Items {
			n := &ml.Items[i]
			name, _, _ := unstructured.NestedString(n.Object, "metadata", "name")
			cpuQ := nestedQuantity(n.Object, "usage", "cpu")
			memQ := nestedQuantity(n.Object, "usage", "memory")
			nodeCPU[name] = cpuQ
			nodeMem[name] = memQ
			totalCPU.Add(*cpuQ)
			totalMem.Add(*memQ)
		}
	}

	nodes = []gin.H{}
	allocCPUtotal := resource.NewQuantity(0, resource.DecimalSI)
	allocMemTotal := resource.NewQuantity(0, resource.BinarySI)
	for _, n := range nodeList.Items {
		ready := false
		for _, cond := range n.Status.Conditions {
			if cond.Type == corev1.NodeReady && cond.Status == corev1.ConditionTrue {
				ready = true
			}
		}
		roles := []string{}
		for k := range n.Labels {
			if strings.HasPrefix(k, "node-role.kubernetes.io/") {
				roles = append(roles, strings.TrimPrefix(k, "node-role.kubernetes.io/"))
			}
		}
		sort.Strings(roles)

		allocCPU := n.Status.Allocatable.Cpu()
		allocMem := n.Status.Allocatable.Memory()
		allocCPUtotal.Add(*allocCPU)
		allocMemTotal.Add(*allocMem)

		podCount := 0
		if pl, perr := kc.Typed.CoreV1().Pods("").List(ctx, metav1.ListOptions{
			FieldSelector: "spec.nodeName=" + n.Name,
		}); perr == nil {
			podCount = len(pl.Items)
		}

		entry := gin.H{
			"name":        n.Name,
			"ready":       ready,
			"roles":       roles,
			"address":     firstInternalIP(n),
			"version":     n.Status.NodeInfo.KubeletVersion,
			"osImage":     n.Status.NodeInfo.OSImage,
			"podCapacity": n.Status.Allocatable.Pods().Value(),
			"podCount":    podCount,
			"allocatable": gin.H{
				"cpu":    allocCPU.String(),
				"memory": allocMem.String(),
			},
		}
		if q, ok := nodeCPU[n.Name]; ok && allocCPU.MilliValue() > 0 {
			entry["cpuUsed"] = milliCpu(q)
			entry["cpuPercent"] = percent(q.MilliValue(), allocCPU.MilliValue())
		}
		if q, ok := nodeMem[n.Name]; ok && allocMem.Value() > 0 {
			entry["memUsed"] = humanBytesBinary(q.Value())
			entry["memPercent"] = percent(q.Value(), allocMem.Value())
		}
		nodes = append(nodes, entry)
	}

	usage = gin.H{
		"cpuUsed":         milliCpu(totalCPU),
		"cpuAllocatable":  milliCpu(allocCPUtotal),
		"cpuPercent":      percent(totalCPU.MilliValue(), allocCPUtotal.MilliValue()),
		"memoryUsed":      humanBytesBinary(totalMem.Value()),
		"memoryAllocable": humanBytesBinary(allocMemTotal.Value()),
		"memoryPercent":   percent(totalMem.Value(), allocMemTotal.Value()),
	}

	// top pods by memory among running ones
	topPods = []gin.H{}
	if ml, merr := kc.Dynamic.Resource(schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods"}).
		List(ctx, metav1.ListOptions{}); merr == nil {
		type row struct {
			ns, name string
			cpu      *resource.Quantity
			mem      *resource.Quantity
		}
		rows := []row{}
		for i := range ml.Items {
			p := &ml.Items[i]
			ns, _, _ := unstructured.NestedString(p.Object, "metadata", "namespace")
			name, _, _ := unstructured.NestedString(p.Object, "metadata", "name")
			sumC, sumM := resource.NewQuantity(0, resource.DecimalSI), resource.NewQuantity(0, resource.BinarySI)
			cs, found, _ := unstructured.NestedSlice(p.Object, "containers")
			if !found {
				continue
			}
			for _, ci := range cs {
				cm, ok := ci.(map[string]interface{})
				if !ok {
					continue
				}
				if cq := nestedQuantity(cm, "usage", "cpu"); cq != nil {
					sumC.Add(*cq)
				}
				if mq := nestedQuantity(cm, "usage", "memory"); mq != nil {
					sumM.Add(*mq)
				}
			}
			rows = append(rows, row{ns, name, sumC, sumM})
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].mem.Value() > rows[j].mem.Value() })
		if len(rows) > 10 {
			rows = rows[:10]
		}
		for _, r := range rows {
			topPods = append(topPods, gin.H{
				"namespace": r.ns, "name": r.name,
				"cpu": milliCpu(r.cpu), "memory": humanBytesBinary(r.mem.Value()),
			})
		}
	}
	return nodes, usage, topPods
}

func nestedQuantity(obj map[string]interface{}, path ...string) *resource.Quantity {
	s, found, _ := unstructured.NestedString(obj, path...)
	if !found || s == "" {
		return nil
	}
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return nil
	}
	return &q
}

func firstInternalIP(n corev1.Node) string {
	for _, a := range n.Status.Addresses {
		if a.Type == corev1.NodeInternalIP {
			return a.Address
		}
	}
	return ""
}

func percent(part, whole int64) float64 {
	if whole <= 0 {
		bf := big.NewFloat(float64(part))
		return round2(bf)
	}
	bf := new(big.Float).Quo(big.NewFloat(float64(part)), big.NewFloat(float64(whole)))
	bf.Mul(bf, big.NewFloat(100))
	return round2(bf)
}

func round2(f *big.Float) float64 {
	v, _ := f.Float64()
	return float64(int(v*100)) / 100
}

func handleEvents(c *gin.Context) {
	kc, err := getKube()
	if err != nil {
		httpKubeError(c, err)
		return
	}
	opts := metav1.ListOptions{Limit: 400}
	if v := c.Query("fieldSelector"); v != "" {
		opts.FieldSelector = v
	}
	evts, err := kc.Typed.CoreV1().Events(c.DefaultQuery("namespace", "all")).List(
		c.Request.Context(), opts)
	if err != nil {
		httpKubeError(c, err)
		return
	}
	items := evts.Items
	sort.Slice(items, func(i, j int) bool {
		ti, tj := eventTime(items[i]), eventTime(items[j])
		return ti.After(tj)
	})
	out := []gin.H{}
	for _, e := range items {
		if t := c.Query("type"); t != "" && e.Type != t {
			continue
		}
		last := eventTime(e)
		out = append(out, gin.H{
			"namespace":  e.Namespace,
			"type":       e.Type,
			"reason":     e.Reason,
			"object":     strings.Title(strings.ToLower(e.InvolvedObject.Kind)) + "/" + e.InvolvedObject.Name,
			"count":      e.Count,
			"message":    e.Message,
			"source":     e.Source.Component,
			"lastSeen":   metav1.Time{Time: last}.Unix(),
			"firstSeen":  e.FirstTimestamp.Unix(),
		})
		if len(out) >= 200 {
			break
		}
	}
	c.JSON(http.StatusOK, gin.H{"items": out, "total": len(evts.Items)})
}

var _ = metav1.Time{}
