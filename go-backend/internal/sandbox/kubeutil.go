package sandbox

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"kubestack/console/internal/kube"
)

func gvrCore(res string) schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "", Version: "v1", Resource: res}
}

func gvrApps(res string) schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: res}
}

// GVRFor lets the server layer reuse this package's helpers for discovery scans.
func GVRFor(group, version, res string) schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: group, Version: version, Resource: res}
}

// ListUnstructured lists any GVR across all namespaces using the shared client.
func ListUnstructured(ctx context.Context, gvr schema.GroupVersionResource,
	labelSelector string) (*unstructured.UnstructuredList, error) {
	kc, err := kube.Get()
	if err != nil {
		return nil, err
	}
	opts := metav1.ListOptions{}
	if labelSelector != "" {
		opts.LabelSelector = labelSelector
	}
	return kc.Dynamic.Resource(gvr).List(ctx, opts)
}

// createHelper creates a raw object inside a namespace via the dynamic client.
func createHelper(ctx context.Context, gvr schema.GroupVersionResource, ns string,
	obj map[string]any) error {
	kc, err := kube.Get()
	if err != nil {
		return err
	}
	u := &unstructured.Unstructured{Object: obj}
	_, err = kc.Dynamic.Resource(gvr).Namespace(ns).Create(ctx, u, metav1.CreateOptions{})
	return err
}

func unstrInt64(obj map[string]any, path ...string) (int64, bool, error) {
	return unstructured.NestedInt64(obj, path...)
}
