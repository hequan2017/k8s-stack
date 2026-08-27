// Package sandbox implements platform-owned sandbox environments:
// one namespace per sandbox carrying a resource quota, limit range,
// a runnable workload template and an expiry-based lifecycle managed
// by a background janitor.
package sandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"

	"kubestack/console/internal/kube"
)

const (
	NSLabelSandbox = "kubestack.dev/sandbox"
	LabelManagedBy = "app.kubernetes.io/managed-by"
	ValueManagedBy = "kubestack-console"
	AnnTemplate    = "kubestack.dev/template"
	AnnExpiresAt   = "kubestack.dev/expires-at"
	AnnTTLHours    = "kubestack.dev/ttl-hours"
	AnnDescription = "kubestack.dev/description"
	AnnNodePort    = "kubestack.dev/nodeport"
	quotaName      = "sandbox-quota"
	limitRangeName = "sandbox-limits"
)

var nameRe = regexp.MustCompile(`^[a-z]([-a-z0-9]{0,30}[a-z0-9])?$`)

type Template struct {
	Key         string  `json:"key"`
	Name        string  `json:"name"`
	Image       string  `json:"image"`
	Description string  `json:"description"`
	Ports       []int32 `json:"ports"`
	TTY         bool    `json:"tty"`

	command []string
}

func Templates() []Template {
	return []Template{
		{Key: "ubuntu", Name: "Ubuntu 24.04", Image: "docker.m.daocloud.io/library/ubuntu:24.04",
			command: []string{"sleep", "infinity"}, Description: "Ubuntu 基础环境，适合通用实验", TTY: true},
		{Key: "python", Name: "Python 3.12", Image: "docker.m.daocloud.io/library/python:3.12-slim",
			command: []string{"sleep", "infinity"}, Description: "Python 运行环境（可 pip 安装依赖）", TTY: true},
		{Key: "alpine", Name: "Alpine 3.20", Image: "docker.m.daocloud.io/library/alpine:3.20",
			command: []string{"sleep", "infinity"}, Description: "轻量 Linux 环境，秒级启动", TTY: true},
		{Key: "nginx", Name: "Nginx Web 服务", Image: "docker.m.daocloud.io/library/nginx:1.27-alpine",
			Description: "Web 服务沙箱，默认暴露 80 端口", Ports: []int32{80}},
	}
}

func TemplateByKey(key string) *Template {
	for i := range Templates() {
		if Templates()[i].Key == key {
			return &Templates()[i]
		}
	}
	return nil
}

type CreateRequest struct {
	Name        string  `json:"name"`
	Template    string  `json:"template"`
	CPU         string  `json:"cpu"`
	Memory      string  `json:"memory"`
	TTLHours    float64 `json:"ttlHours"`
	NodePort    bool    `json:"nodePort"`
	Description string  `json:"description"`
}

type Item struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Template    string            `json:"template"`
	Status      string            `json:"status"`
	Ready       string            `json:"ready"`
	CPU         string            `json:"cpu"`
	Memory      string            `json:"memory"`
	AgeSeconds  int64             `json:"ageSeconds"`
	ExpiresAt   int64             `json:"expiresAt"`
	TTLHours    float64           `json:"ttlHours"`
	Description string            `json:"description"`
	NodePort    int32             `json:"nodePort"`
	ClusterIP   string            `json:"clusterIP"`
}

func nsFor(name string) string { return "sbx-" + name }

func validateName(name string) error {
	if !nameRe.MatchString(name) {
		return fmt.Errorf("沙箱名需以小写字母开头，仅含小写字母/数字/-")
	}
	return nil
}

func Create(ctx context.Context, req CreateRequest) (string, error) {
	if err := validateName(req.Name); err != nil {
		return "", err
	}
	tpl := TemplateByKey(req.Template)
	if tpl == nil {
		return "", fmt.Errorf("未知模板 %s", req.Template)
	}
	cpu := normQty(req.CPU, "500m")
	mem := normQty(req.Memory, "512Mi")
	ttl := req.TTLHours
	if ttl <= 0 {
		ttl = 24
	}
	kc, err := kube.Get()
	if err != nil {
		return "", err
	}
	ns := nsFor(req.Name)

	nsObj := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: ns,
		Labels: map[string]string{
			NSLabelSandbox: "true",
			LabelManagedBy: ValueManagedBy,
		},
		Annotations: map[string]string{
			AnnTemplate:    tpl.Key,
			AnnExpiresAt:   strconv.FormatInt(time.Now().Add(time.Duration(ttl * float64(time.Hour))).Unix(), 10),
			AnnTTLHours:    strconv.FormatFloat(ttl, 'f', -1, 64),
			AnnDescription: req.Description,
		},
	}}
	if _, err := kc.Typed.CoreV1().Namespaces().Create(ctx, nsObj, metav1.CreateOptions{}); err != nil {
		return "", fmt.Errorf("创建命名空间失败: %w", err)
	}

	createInNS := func(gvr schema.GroupVersionResource, name string, obj map[string]any) error {
		return createHelper(ctx, gvr, ns, obj)
	}

	quota := map[string]any{
		"apiVersion": "v1", "kind": "ResourceQuota",
		"metadata": map[string]any{"name": quotaName, "namespace": ns,
			"labels": map[string]any{LabelManagedBy: ValueManagedBy}},
		"spec": map[string]any{"hard": map[string]any{
			"requests.cpu": cpu, "requests.memory": mem,
			"limits.cpu": cpu, "limits.memory": mem,
			"pods": "10",
		}},
	}
	if err := createInNS(gvrCore("resourcequotas"), quotaName, quota); err != nil {
		return ns, fmt.Errorf("创建资源配额失败: %w", err)
	}

	limitRange := map[string]any{
		"apiVersion": "v1", "kind": "LimitRange",
		"metadata": map[string]any{"name": limitRangeName, "namespace": ns,
			"labels": map[string]any{LabelManagedBy: ValueManagedBy}},
		"spec": map[string]any{"limits": []any{map[string]any{
			"type":           "Container",
			"defaultRequest": map[string]any{"cpu": "50m", "memory": "64Mi"},
			"default":        map[string]any{"cpu": cpu, "memory": mem},
		}}},
	}
	if err := createInNS(gvrCore("limitranges"), limitRangeName, limitRange); err != nil {
		return ns, fmt.Errorf("创建 LimitRange 失败: %w", err)
	}

	container := map[string]any{
		"name":      "main",
		"image":     tpl.Image,
		"resources": map[string]any{"limits": map[string]any{"cpu": cpu, "memory": mem}},
	}
	if len(tpl.command) > 0 {
		container["command"] = tpl.command
	}
	if tpl.TTY {
		container["stdin"] = true
		container["tty"] = true
	}
	if len(tpl.Ports) > 0 {
		ports := []any{}
		for _, p := range tpl.Ports {
			ports = append(ports, map[string]any{"containerPort": p})
		}
		container["ports"] = ports
	}
	deploy := map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{
			"name": req.Name, "namespace": ns,
			"labels": map[string]any{"app": req.Name, LabelManagedBy: ValueManagedBy},
		},
		"spec": map[string]any{
			"replicas": 1,
			"selector": map[string]any{"matchLabels": map[string]any{"app": req.Name}},
			"template": map[string]any{
				"metadata": map[string]any{"labels": map[string]any{"app": req.Name, LabelManagedBy: ValueManagedBy}},
				"spec":     map[string]any{"containers": []any{container}},
			},
		},
	}
	if err := createInNS(gvrApps("deployments"), req.Name, deploy); err != nil {
		return ns, fmt.Errorf("创建工作负载失败: %w", err)
	}

	svcType := "ClusterIP"
	if req.NodePort {
		svcType = "NodePort"
	}
	svcPorts := []any{}
	if len(tpl.Ports) == 0 {
		svcPorts = append(svcPorts, map[string]any{"port": 80, "targetPort": 80})
	} else {
		for _, p := range tpl.Ports {
			svcPorts = append(svcPorts, map[string]any{"port": p, "targetPort": p})
		}
	}
	svc := map[string]any{
		"apiVersion": "v1", "kind": "Service",
		"metadata": map[string]any{"name": "svc", "namespace": ns,
			"labels": map[string]any{LabelManagedBy: ValueManagedBy}},
		"spec": map[string]any{
			"type": svcType, "selector": map[string]any{"app": req.Name}, "ports": svcPorts,
		},
	}
	if err := createInNS(gvrCore("services"), "svc", svc); err != nil {
		return ns, fmt.Errorf("创建服务失败: %w", err)
	}
	if req.NodePort {
		go recordNodePort(ns)
	}
	log.Printf("[sandbox] created %s (template=%s cpu=%s mem=%s ttl=%.0fh)", ns, tpl.Key, cpu, mem, ttl)
	return ns, nil
}

func recordNodePort(ns string) {
	kc, _ := kube.Get()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for i := 0; i < 6; i++ {
		time.Sleep(700 * time.Millisecond)
		svc, err := kc.Typed.CoreV1().Services(ns).Get(ctx, "svc", metav1.GetOptions{})
		if err != nil || len(svc.Spec.Ports) == 0 {
			continue
		}
		var np int32
		for _, p := range svc.Spec.Ports {
			if p.NodePort > 0 {
				np = p.NodePort
			}
		}
		if np == 0 {
			continue
		}
		cur, gerr := kc.Typed.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{})
		if gerr != nil {
			return
		}
		if cur.Annotations == nil {
			cur.Annotations = map[string]string{}
		}
		cur.Annotations[AnnNodePort] = strconv.Itoa(int(np))
		kc.Typed.CoreV1().Namespaces().Update(ctx, cur, metav1.UpdateOptions{})
		return
	}
}

func List(ctx context.Context) ([]Item, error) {
	kc, err := kube.Get()
	if err != nil {
		return nil, err
	}
	nsl, err := kc.Typed.CoreV1().Namespaces().List(ctx, metav1.ListOptions{
		LabelSelector: NSLabelSandbox + "=true",
	})
	if err != nil {
		return nil, err
	}
	items := []Item{}
	for i := range nsl.Items {
		item, derr := describeOne(ctx, &nsl.Items[i])
		if derr != nil {
			continue
		}
		items = append(items, *item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].AgeSeconds < items[j].AgeSeconds })
	return items, nil
}

func describeOne(ctx context.Context, ns *corev1.Namespace) (*Item, error) {
	kc, _ := kube.Get()
	full := ns.Name
	name := strings.TrimPrefix(full, "sbx-")
	ann := ns.Annotations

	item := &Item{
		Name:        name,
		Namespace:   full,
		Template:    ann[AnnTemplate],
		TTLHours:    parseFloatOr(ann[AnnTTLHours], 24),
		Description: ann[AnnDescription],
		AgeSeconds:  time.Since(ns.CreationTimestamp.Time).Milliseconds() / 1000,
	}
	if v, err := strconv.ParseInt(ann[AnnExpiresAt], 10, 64); err == nil {
		item.ExpiresAt = v
	}
	if np, err := strconv.Atoi(ann[AnnNodePort]); err == nil && np > 0 {
		item.NodePort = int32(np)
	}

	d, derr := kc.Dynamic.Resource(gvrApps("deployments")).Namespace(full).
		Get(ctx, name, metav1.GetOptions{})
	if derr == nil {
		desired, _, _ := unstrInt64(d.Object, "spec", "replicas")
		ready, _, _ := unstrInt64(d.Object, "status", "readyReplicas")
		item.Ready = fmt.Sprintf("%d/%d", ready, desired)
		switch {
		case desired == 0:
			item.Status = "Stopped"
		case ready >= desired:
			item.Status = "Running"
		default:
			item.Status = "Starting"
		}
	} else {
		item.Status = "Terminating"
	}

	if q, qerr := kc.Typed.CoreV1().ResourceQuotas(full).Get(ctx, quotaName, metav1.GetOptions{}); qerr == nil {
		if c, ok := q.Status.Used["limits.cpu"]; ok {
			item.CPU = c.String()
		}
		if m, ok := q.Status.Used["limits.memory"]; ok {
			item.Memory = humanBytes(m.Value())
		}
	}

	if svcs, serr := kc.Typed.CoreV1().Services(full).List(ctx, metav1.ListOptions{}); serr == nil {
		for _, s := range svcs.Items {
			item.ClusterIP = s.Spec.ClusterIP
			for _, p := range s.Spec.Ports {
				if p.NodePort > 0 {
					item.NodePort = p.NodePort
				}
			}
		}
	}
	return item, nil
}

func SetReplicas(ctx context.Context, name string, replicas int32) error {
	kc, _ := kube.Get()
	patch, _ := json.Marshal(map[string]any{"spec": map[string]any{"replicas": replicas}})
	_, err := kc.Dynamic.Resource(gvrApps("deployments")).Namespace(nsFor(name)).
		Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

func Renew(ctx context.Context, name string, hours float64) error {
	if hours <= 0 {
		hours = 24
	}
	kc, _ := kube.Get()
	exp := time.Now().Add(time.Duration(hours * float64(time.Hour)))
	patch, _ := json.Marshal(map[string]any{"metadata": map[string]any{
		"annotations": map[string]any{
			AnnExpiresAt: strconv.FormatInt(exp.Unix(), 10),
			AnnTTLHours:  strconv.FormatFloat(hours, 'f', -1, 64),
		}}})
	_, err := kc.Typed.CoreV1().Namespaces().Patch(ctx, nsFor(name), types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

func Delete(ctx context.Context, name string) error {
	kc, _ := kube.Get()
	err := kc.Typed.CoreV1().Namespaces().Delete(ctx, nsFor(name), metav1.DeleteOptions{})
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "not found") {
		return nil
	}
	return err
}

func StartJanitor(every time.Duration) {
	go func() {
		runOnce()
		t := time.NewTicker(every)
		defer t.Stop()
		for range t.C {
			runOnce()
		}
	}()
}

func runOnce() {
	kc, err := kube.Get()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	nsl, lerr := kc.Typed.CoreV1().Namespaces().List(ctx, metav1.ListOptions{
		LabelSelector: NSLabelSandbox + "=true",
	})
	if lerr != nil {
		return
	}
	now := time.Now().Unix()
	for i := range nsl.Items {
		ns := &nsl.Items[i]
		exp, perr := strconv.ParseInt(ns.Annotations[AnnExpiresAt], 10, 64)
		if perr != nil || exp <= 0 || now < exp {
			continue
		}
		log.Printf("[janitor] deleting expired sandbox namespace %s", ns.Name)
		if err := kc.Typed.CoreV1().Namespaces().Delete(ctx, ns.Name, metav1.DeleteOptions{}); err != nil {
			log.Printf("[janitor] delete %s failed: %v", ns.Name, err)
		}
	}
}
