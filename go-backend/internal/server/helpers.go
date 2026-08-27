package server

import (
	"k8s.io/client-go/dynamic"

	"kubestack/console/internal/kube"
)

func getKube() (*kube.Clients, error) { return kube.Get() }

func getKubeDynamic() dynamic.Interface {
	c, err := kube.Get()
	if err != nil {
		return nil
	}
	return c.Dynamic
}

// statusErrorCode maps Kubernetes API errors onto HTTP status codes for the UI.
func statusErrorCode(err error) int {
	return kube.HTTPStatusOf(err)
}

func isNotFoundErr(err error) bool {
	return kube.IsNotFound(err)
}
