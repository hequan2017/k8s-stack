package server

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
	yamlutil "gopkg.in/yaml.v3"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func jsonMarshal(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// handleApply applies a multi-document YAML manifest: create-or-update per doc.
// This is the console's "YAML 应用中心", mirroring `kubectl apply -f`.
func handleApply(c *gin.Context) {
	var req struct {
		Manifest  string `json:"manifest"`
		Namespace string `json:"namespace"` // fallback for docs without metadata.namespace
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Manifest) == "" {
		c.JSON(400, gin.H{"error": "manifest 不能为空"})
		return
	}
	if req.Namespace == "" {
		req.Namespace = "default"
	}

	docs, err := splitYAMLDocs(req.Manifest)
	if err != nil {
		c.JSON(400, gin.H{"error": "YAML 解析失败: " + err.Error()})
		return
	}

	results := []gin.H{}
	for _, doc := range docs {
		results = append(results, applyOneDoc(c, doc, req.Namespace))
	}
	c.JSON(200, gin.H{"results": results})
}

func splitYAMLDocs(s string) ([]map[string]any, error) {
	docs := []map[string]any{}
	dec := yamlutil.NewDecoder(strings.NewReader(s))
	for {
		var m map[string]any
		err := dec.Decode(&m)
		if err != nil {
			if err.Error() == "EOF" {
				break
			}
			return nil, err
		}
		if m == nil { // empty document between --- separators
			continue
		}
		docs = append(docs, m)
	}
	return docs, nil
}

func applyOneDoc(c *gin.Context, doc map[string]any, fallbackNS string) gin.H {
	kind, _, _ := unstructured.NestedString(doc, "kind")
	apiVersion, _, _ := unstructured.NestedString(doc, "apiVersion")
	name, _, _ := unstructured.NestedString(doc, "metadata", "name")
	label := fmt.Sprintf("%s %s/%s", apiVersion, kind, name)
	bad := func(err error) gin.H { return gin.H{"target": label, "ok": false, "error": err.Error()} }

	if kind == "" || apiVersion == "" || name == "" {
		return bad(fmt.Errorf("缺少 apiVersion/kind/metadata.name"))
	}

	group, version := parseAPIVersion(apiVersion)
	info, err := mapper.lookup(group, version, resourcePluralFor(kind))
	if err != nil {
		return bad(err)
	}
	gvr := info.gvr()

	ns := ""
	if info.Namespaced {
		ns = fallbackNS
		if v, _, _ := unstructured.NestedString(doc, "metadata", "namespace"); v != "" {
			ns = v
		}
		meta(doc)["namespace"] = ns
	}

	obj := &unstructured.Unstructured{Object: doc}
	dyn := getKubeDynamic().Resource(gvr)

	ctx := c.Request.Context()
	if info.Namespaced {
		if existing, gerr := dyn.Namespace(ns).Get(ctx, name, metav1.GetOptions{}); gerr == nil {
			_ = existing
			patch := jsonMarshal(sanitizeForUpdate(obj.Object))
			updated, uerr := dyn.Namespace(ns).Patch(ctx, name, mergePatchType, patch, metav1.PatchOptions{})
			if uerr != nil {
				return bad(uerr)
			}
			return gin.H{"target": label, "action": "updated", "ok": true, "object": updated}
		} else if !isNotFoundErr(gerr) {
			return bad(gerr)
		}
		created, cerr := dyn.Namespace(ns).Create(ctx, obj, metav1.CreateOptions{})
		if cerr != nil {
			return bad(cerr)
		}
		return gin.H{"target": label, "action": "created", "ok": true, "object": created}
	}

	if _, gerr := dyn.Get(ctx, name, metav1.GetOptions{}); gerr == nil {
		patch := jsonMarshal(sanitizeForUpdate(obj.Object))
		updated, uerr := dyn.Patch(ctx, name, mergePatchType, patch, metav1.PatchOptions{})
		if uerr != nil {
			return bad(uerr)
		}
		return gin.H{"target": label, "action": "updated", "ok": true, "object": updated}
	} else if !isNotFoundErr(gerr) {
		return bad(gerr)
	}
	created, cerr := dyn.Create(ctx, obj, metav1.CreateOptions{})
	if cerr != nil {
		return bad(cerr)
	}
	return gin.H{"target": label, "action": "created", "ok": true, "object": created}
}

// sanitizeForUpdate strips server-managed fields before using an object as a merge patch.
func sanitizeForUpdate(obj map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range obj {
		if k == "status" {
			continue
		}
		out[k] = v
	}
	if m, ok := out["metadata"].(map[string]any); ok {
		cleanMeta := map[string]any{}
		for k, v := range m {
			switch k {
			case "uid", "resourceVersion", "creationTimestamp", "generation",
				"managedFields", "selfLink":
				continue
			default:
				cleanMeta[k] = v
			}
		}
		out["metadata"] = cleanMeta
	}
	return out
}

func parseAPIVersion(av string) (group, version string) {
	parts := strings.SplitN(av, "/", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", parts[0]
}

func resourcePluralFor(kind string) string {
	k := strings.ToLower(kind)
	switch {
	case strings.HasSuffix(k, "endpoints"):
		return k
	case strings.HasSuffix(k, "y"):
		return k[:len(k)-1] + "ies"
	case strings.HasSuffix(k, "s"):
		return k + "es"
	default:
		return k + "s"
	}
}
