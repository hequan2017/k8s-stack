package server

import (
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	"kubestack/console/internal/kube"
)

// package-level aliases keep handler signatures tidy.
type kubeClients = kube.Clients

var adminPwd string

// waitGroup runs funcs concurrently and waits for all of them.
type waitGroup struct{ wg sync.WaitGroup }

func (w *waitGroup) Go(f func()) {
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		f()
	}()
}

func (w *waitGroup) Wait() { w.wg.Wait() }

func adminPassword() string { return adminPwd }

func timeout20s() time.Duration { return 20 * time.Second }

func eventTime(e corev1.Event) time.Time {
	if !e.LastTimestamp.IsZero() {
		return e.LastTimestamp.Time
	}
	if !e.EventTime.IsZero() {
		return e.EventTime.Time
	}
	return e.CreationTimestamp.Time
}

func itoa(i int) string { return strconv.Itoa(i) }

func ftoa(f float64) string {
	return strings.TrimSuffix(strconv.FormatFloat(f, 'f', 2, 64), ".00")
}

// milliCpu renders a CPU quantity as a plain millcore string like "850m".
func milliCpu(q *resource.Quantity) string {
	if q == nil || q.MilliValue() == 0 {
		return "0m"
	}
	return strconv.FormatInt(q.MilliValue(), 10) + "m"
}

// humanBytesBinary renders bytes as Ki/Mi/Gi with the correct exponent.
func humanBytesBinary(b int64) string {
	const unit = 1024
	if b < unit {
		return strconv.FormatInt(b, 10) + "B"
	}
	v := float64(b)
	i := 0
	for ; v >= unit && i < 5; i++ {
		v /= unit
	}
	// after i divisions the unit is K,M,G,T,P,E -> index i-1; rendered as Ki/Mi/Gi
	return ftoa(v) + "KMGTPE"[i-1:i] + "i"
}
