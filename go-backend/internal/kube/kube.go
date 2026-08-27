// Package kube bootstraps Kubernetes clients from either in-cluster
// ServiceAccount credentials or a KUBECONFIG file for local development.
package kube

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/flowcontrol"
)

type Clients struct {
	RestConfig *rest.Config
	Typed      kubernetes.Interface
	Dynamic    dynamic.Interface
	Discovery  discovery.DiscoveryInterface
}

var (
	mu     sync.Mutex
	single *Clients
)

func Get() (*Clients, error) {
	mu.Lock()
	defer mu.Unlock()
	if single != nil {
		return single, nil
	}
	c, err := load()
	if err != nil {
		return nil, err
	}
	single = c
	return single, nil
}

func load() (*Clients, error) {
	var cfg *rest.Config
	var err error

	if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
		cfg, err = rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("in-cluster config: %w", err)
		}
	} else if kc := os.Getenv("KUBECONFIG"); kc != "" {
		if abs, aerr := filepath.Abs(kc); aerr == nil {
			kc = abs
		}
		cfg, err = clientcmd.BuildConfigFromFlags("", kc)
		if err != nil {
			return nil, fmt.Errorf("kubeconfig %s: %w", kc, err)
		}
	} else {
		return nil, fmt.Errorf("no cluster access: set KUBERNETES_SERVICE_HOST (in-cluster) or KUBECONFIG")
	}

	cfg.RateLimiter = flowcontrol.NewTokenBucketRateLimiter(100, 200)

	typed, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	disc, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Clients{RestConfig: cfg, Typed: typed, Dynamic: dyn, Discovery: disc}, nil
}
