package sandbox

import (
	"encoding/json"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// mapToNamespace converts an unstructured map into a typed Namespace via JSON round-trip.
func mapToNamespace(m map[string]any) (*corev1.Namespace, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	ns := &corev1.Namespace{}
	if err := json.Unmarshal(b, ns); err != nil {
		return nil, err
	}
	return ns, nil
}

// mapToUnstructured wraps a raw object map for the dynamic client.
func mapToUnstructured(m map[string]any) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: m}
}

func parseQty(s string) (resource.Quantity, error) {
	return resource.ParseQuantity(s)
}

// normQty validates a quantity string, falling back to def when empty or invalid.
func normQty(v, def string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return def
	}
	q, err := resource.ParseQuantity(v)
	if err != nil {
		return def
	}
	return q.String()
}

func parseFloatOr(s string, def float64) float64 {
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		return v
	}
	return def
}

func humanBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return strconv.FormatInt(b, 10) + "B"
	}
	v := float64(b)
	i := 0
	for ; v >= unit && i < 5; i++ {
		v /= unit
	}
	return trimZero(strconv.FormatFloat(v, 'f', 1, 64)) + "KMGTPE"[i-1:i] + "i"
}

func trimZero(s string) string {
	if len(s) > 3 && s[len(s)-2:] == ".0" {
		return s[:len(s)-2]
	}
	return s
}
