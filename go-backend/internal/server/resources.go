package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
)

// resourceMapper resolves "group/version plural" pairs through the
// server-preferred discovery cache so every API the cluster exposes is manageable.
type resourceMapper struct {
	mu       sync.Mutex
	disc     discovery.DiscoveryInterface
	groupVer map[string]map[string]ResInfo // "group/version" -> plural -> info
}

type ResInfo struct {
	Group      string `json:"group"`
	Version    string `json:"version"`
	Resource   string `json:"resource"` // plural
	Kind       string `json:"kind"`
	Namespaced bool   `json:"namespaced"`
	APIVersion string `json:"apiVersion"`
}

var mapper *resourceMapper

func InitResources() error {
	kc, err := getKube()
	if err != nil {
		return err
	}
	mapper = &resourceMapper{disc: kc.Discovery, groupVer: map[string]map[string]ResInfo{}}
	if err := mapper.refresh(); err != nil {
		return err
	}
	go func() { // keep discovery fresh so CRDs created later become manageable
		t := time.NewTicker(10 * time.Minute)
		for range t.C {
			if err := mapper.refresh(); err != nil {
				log.Printf("discovery refresh failed: %v", err)
			}
		}
	}()
	return nil
}

func collectList(rl *metav1.APIResourceList, gv map[string]map[string]ResInfo) {
	if rl == nil {
		return
	}
	key := rl.GroupVersion
	if gv[key] == nil {
		gv[key] = map[string]ResInfo{}
	}
	group, version := "", key
	if parts := strings.SplitN(key, "/", 2); len(parts) == 2 {
		group, version = parts[0], parts[1]
	}
	for _, r := range rl.APIResources {
		if strings.Contains(r.Name, "/") || !hasListVerb(r.Verbs) {
			continue
		}
		gv[key][r.Name] = ResInfo{
			Group: group, Version: version, Resource: r.Name,
			Kind: r.Kind, Namespaced: r.Namespaced, APIVersion: key,
		}
	}
}

func hasListVerb(verbs []string) bool {
	for _, v := range verbs {
		if v == "list" {
			return true
		}
	}
	return false
}

func (m *resourceMapper) refresh() error {
	nsLists, nerr := m.disc.ServerPreferredNamespacedResources()
	if nerr != nil {
		log.Printf("namespaced discovery partial error (continuing): %v", nerr)
	}
	allLists, aerr := m.disc.ServerPreferredResources()
	if aerr != nil {
		log.Printf("preferred discovery partial error (continuing): %v", aerr)
	}
	gv := map[string]map[string]ResInfo{}
	for _, l := range nsLists {
		collectList(l, gv)
	}
	for _, l := range allLists { // adds cluster-scoped kinds too
		collectList(l, gv)
	}
	if len(gv) == 0 {
		return fmt.Errorf("discovery failed: %v / %v", nerr, aerr)
	}
	log.Printf("[discovery] %d groupVersions cached (v1=%v apps=%v)", len(gv),
		gv["v1"] != nil, gv["apps/v1"] != nil)
	m.mu.Lock()
	m.groupVer = gv
	m.mu.Unlock()
	return nil
}

func (m *resourceMapper) lookup(group, version, plural string) (ResInfo, error) {
	key := version
	if group != "" {
		key = group + "/" + version
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	table := m.groupVer[key]
	if table == nil {
		return ResInfo{}, fmt.Errorf("unknown apiVersion %s/%s", group, version)
	}
	info, ok := table[plural]
	if !ok {
		return ResInfo{}, fmt.Errorf("unknown resource %s in %s/%s", plural, group, version)
	}
	return info, nil
}

func (i ResInfo) gvr() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: i.Group, Version: i.Version, Resource: i.Resource}
}

// resResolve parses a wildcard path into (resource, namespace, name).
// Accepted shapes after /api/res/:
//   - <group>/<version>/<plural>[/<ns>/<name>]      grouped APIs and CRDs
//   - <version>/<plural>                            core group (list)
//   - <version>/<plural>/<ns>/<name>                core group with pair
func resResolve(c *gin.Context) (ResInfo, string, string, bool) {
	raw := strings.Trim(c.Param("path"), "/")
	parts := strings.Split(raw, "/")
	invalid := func(msg string) (ResInfo, string, string, bool) {
		c.JSON(http.StatusNotFound, gin.H{"error": msg})
		return ResInfo{}, "", "", false
	}
	var (
		info ResInfo
		err  error
	)
	// core-group long form first: v1/<plural>/… is unambiguous from length alone
	if len(parts) >= 3 && parts[0] == "v1" {
		info, err = mapper.lookup("", "v1", parts[1])
		if err != nil {
			return invalid(err.Error())
		}
		rest := parts[2:]
		if info.Namespaced {
			switch len(rest) {
			case 1: // namespace-scoped list
				return info, rest[0], "", true
			case 2: // detail with ns/name
				return info, rest[0], rest[1], true
			default:
				return invalid("路径段过多")
			}
		}
		if len(rest) == 1 { // cluster-scoped detail
			return info, "", rest[0], true
		}
		return invalid("该资源为集群级资源，路径应为 v1/" + parts[1] + "/<name>")
	}

	switch {
	case len(parts) >= 3:
		info, err = mapper.lookup(parts[0], parts[1], parts[2])
		parts = parts[3:]
	case len(parts) == 2:
		info, err = mapper.lookup("", parts[0], parts[1])
		parts = parts[2:]
	default:
		return invalid("路径格式：{group}/{version}/{resource}[/{ns}/{name}] 或 {version}/{resource}")
	}
	if err != nil {
		return invalid(err.Error())
	}

	ns, name := "", ""
	switch len(parts) {
	case 0:
	case 1:
		if info.Namespaced {
			return invalid("该资源为命名空间级，需 /namespace/name")
		}
		name = parts[0]
	case 2:
		ns, name = parts[0], parts[1]
	default:
		return invalid("路径段过多")
	}
	return info, ns, name, true
}

// ---- handlers (all mapped onto /api/res/*path) ----

func listDiscovery(c *gin.Context) {
	out := []ResInfo{}
	mapper.mu.Lock()
	for _, table := range mapper.groupVer {
		for _, info := range table {
			out = append(out, info)
		}
	}
	mapper.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].APIVersion != out[j].APIVersion {
			return out[i].APIVersion < out[j].APIVersion
		}
		return out[i].Resource < out[j].Resource
	})
	c.JSON(http.StatusOK, gin.H{"resources": out})
}

// listResources serves GET /api/res/*path — either a collection listing
// (no trailing name) or a single object detail when a name is supplied.
func listResources(c *gin.Context) {
	info, ns, name, ok := resResolve(c)
	if !ok {
		return
	}
	if name != "" {
		getOne(c, info, ns, name)
		return
	}
	opts := metav1.ListOptions{}
	opts.LabelSelector = c.Query("labelSelector")
	opts.FieldSelector = c.Query("fieldSelector")
	if v := c.Query("limit"); v != "" {
		fmt.Sscanf(v, "%d", &opts.Limit)
	}
	ctx := c.Request.Context()
	ri := getKubeDynamic().Resource(info.gvr())
	var (
		list any
		err  error
	)
	if info.Namespaced && ns != "all" && ns != "" {
		list, err = ri.Namespace(ns).List(ctx, opts)
	} else {
		list, err = ri.List(ctx, opts)
	}
	if err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, list)
}

func getOne(c *gin.Context, info ResInfo, ns, name string) {
	ri := getKubeDynamic().Resource(info.gvr())
	var (
		obj any
		err error
	)
	if info.Namespaced {
		obj, err = ri.Namespace(ns).Get(c.Request.Context(), name, metav1.GetOptions{})
	} else {
		obj, err = ri.Get(c.Request.Context(), name, metav1.GetOptions{})
	}
	if err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, obj)
}

func createResource(c *gin.Context) {
	info, _, _, ok := resResolve(c)
	if !ok {
		return
	}
	body, ok := readBodyObject(c)
	if !ok {
		return
	}
	if info.Namespaced {
		m := meta(body)
		if s, _ := m["namespace"].(string); s == "" {
			m["namespace"] = c.DefaultQuery("namespace", "default")
		}
	}
	obj, err := getKubeDynamic().Resource(info.gvr()).Create(c.Request.Context(),
		&unstructured.Unstructured{Object: body}, metav1.CreateOptions{})
	if err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, obj)
}

func replaceResource(c *gin.Context) {
	info, ns, name, ok := resResolve(c)
	if !ok {
		return
	}
	body, ok := readBodyObject(c)
	if !ok {
		return
	}
	m := meta(body)
	m["name"] = name
	if info.Namespaced {
		m["namespace"] = ns
	}
	bodyU := &unstructured.Unstructured{Object: body}
	ri := getKubeDynamic().Resource(info.gvr())
	var (
		obj any
		err error
	)
	if info.Namespaced {
		obj, err = ri.Namespace(ns).Update(c.Request.Context(), bodyU, metav1.UpdateOptions{})
	} else {
		obj, err = ri.Update(c.Request.Context(), bodyU, metav1.UpdateOptions{})
	}
	if err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, obj)
}

// patchResource applies a raw JSON merge patch (used for scaling, restarts,
// label edits, …).
func patchResource(c *gin.Context) {
	info, ns, name, ok := resResolve(c)
	if !ok {
		return
	}
	raw, err := c.GetRawData()
	if err != nil || len(raw) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "empty request body"})
		return
	}
	if !json.Valid(raw) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON patch"})
		return
	}
	ri := getKubeDynamic().Resource(info.gvr())
	var (
		obj any
		prr error
	)
	if info.Namespaced {
		obj, prr = ri.Namespace(ns).Patch(c.Request.Context(), name, mergePatchType, raw, metav1.PatchOptions{})
	} else {
		obj, prr = ri.Patch(c.Request.Context(), name, mergePatchType, raw, metav1.PatchOptions{})
	}
	if prr != nil {
		httpKubeError(c, prr)
		return
	}
	c.JSON(http.StatusOK, obj)
}

func deleteResource(c *gin.Context) {
	info, ns, name, ok := resResolve(c)
	if !ok {
		return
	}
	opts := metav1.DeleteOptions{}
	if v := c.Query("gracePeriodSeconds"); v != "" {
		var gp int64
		fmt.Sscanf(v, "%d", &gp)
		opts.GracePeriodSeconds = &gp
	}
	ri := getKubeDynamic().Resource(info.gvr())
	var err error
	if info.Namespaced {
		err = ri.Namespace(ns).Delete(c.Request.Context(), name, opts)
	} else {
		err = ri.Delete(c.Request.Context(), name, opts)
	}
	if err != nil {
		httpKubeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": name})
}

// ---- shared helpers ----

const mergePatchType = "application/merge-patch+json"

func httpKubeError(c *gin.Context, err error) {
	code := statusErrorCode(err)
	c.JSON(code, gin.H{"error": err.Error()})
}

func readBodyObject(c *gin.Context) (map[string]any, bool) {
	raw, err := c.GetRawData()
	if err != nil || len(raw) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "empty request body"})
		return nil, false
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON object: " + err.Error()})
		return nil, false
	}
	return obj, true
}

func meta(obj map[string]any) map[string]any {
	if obj["metadata"] == nil {
		obj["metadata"] = map[string]any{}
	}
	m, _ := obj["metadata"].(map[string]any)
	return m
}

var _ = context.Background
