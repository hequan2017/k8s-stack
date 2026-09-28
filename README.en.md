[简体中文](README.md) | [English](README.en.md)

# KubeStack Console (k8s-stack)

An open-source Kubernetes management platform benchmarked against the KubeSphere experience, built with **Go (client-go) + Vue 3**, featuring a built-in **Sandbox Management** platform. Single-binary deployment — the frontend is embedded in the binary and no external database is required.

![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![Kubernetes](https://img.shields.io/badge/Kubernetes-client--go%200.37-326CE5?logo=kubernetes&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3.x-4FC08D?logo=vuedotjs&logoColor=white)

## Introduction

KubeStack Console is aimed at ops/dev teams that want a lightweight Kubernetes console: one Go process does everything. The frontend static assets are embedded directly into the binary, and it talks to the API Server via the in-cluster ServiceAccount (or a local KUBECONFIG) — no MySQL or other external components needed.

It covers the usual management plane: cluster overview, nodes, projects, workloads, services & routing, config, storage, and RBAC. A discovery-based **universal resource engine** manages any API resource in the cluster — including CRDs registered by arbitrary operators — with no code changes. The highlight is the built-in **Sandbox Management**: create isolated namespaces with CPU / memory / GPU quotas and a TTL in one click, with 7 built-in templates (including code-server, VS Code in the browser) and automatic expiry cleanup.

## 📸 Screenshots

| Cluster Overview | Sandbox Management |
| --- | --- |
| ![dashboard](docs/screenshots/dashboard.png) | ![sandbox-list](docs/screenshots/sandbox-list.png) |

| Workload Detail | Sandbox Creation |
| --- | --- |
| ![workload-detail](docs/screenshots/workload-detail.png) | ![sandbox-create](docs/screenshots/sandbox-create.png) |

More: [Pod logs & terminal](docs/screenshots/pods.png), [YAML apply center](docs/screenshots/yaml-apply.png) (in docs/screenshots/).

## ✨ Features

| Module | Capabilities |
| --- | --- |
| Cluster overview | Resource counts, real-time CPU/memory usage (metrics-server), node health, Top Pods, alerting events |
| Node management | List/detail, conditions & health, cordon / uncordon |
| Project management | Namespace (project) CRUD, global namespace scoping |
| Workloads | Deployment / StatefulSet / DaemonSet / ReplicaSet / Job / CronJob / HPA: list, detail, YAML editing, rolling restart, scaling, delete |
| Pods | Status detection (Waiting reason/restarts/node/IP), live log streaming (follow), **web terminal exec**, YAML view |
| Services & routing | Service (NodePort highlighted) / Ingress / EndpointSlice |
| Config center | ConfigMap / Secret management |
| Storage | PVC / PV / StorageClass |
| RBAC | ServiceAccount / Role / RoleBinding / ClusterRole / ClusterRoleBinding |
| CRD browser | Discovers all API resources in the cluster (including any Operator CRD) with generic CRUD and YAML editing |
| Events | Global/project scope filtering, type filtering, auto refresh |
| YAML apply center | Apply multi-document YAML online (same semantics as kubectl apply), create or update |
| **Sandbox management** | See below |

### Sandbox Management

- **One-click isolated environments**: dedicated namespace + ResourceQuota + LimitRange + workload, with CPU/memory quotas, **GPU count** (`nvidia.com/gpu`, 1-8, requires the device plugin in your cluster) and TTL
- **7 built-in templates**: Ubuntu 24.04 / Alpine 3.20 / Python 3.12 / Node.js 22 / **VS Code in the browser (code-server)** / Nginx / Redis 7, with ports and startup args
- **Smart TTL reclamation**: a background janitor (every 60 seconds) automatically deletes expired namespaces; **stopping a sandbox pauses its countdown** (paused) — the TTL resumes after restart, and can also be renewed
- **Observability**: real-time CPU/memory usage (metrics-server), expiry countdown, auto refresh
- **Access**: NodePort services are allocated automatically with clickable direct links; descriptions support inline editing
- **Web terminal**: open a shell inside the sandbox (automatic bash/sh fallback)
- **Third-party sandbox discovery**: automatically lists existing E2B/OpenSandbox Pods and `agents.x-k8s.io` Sandbox CRs in the cluster

## 🏗 Architecture

```
Browser (Vue3 SPA)
  │ REST /api/res/** universal resource engine     WebSocket /ws/exec/** terminal
  ▼
Single Go process (gin + client-go dynamic/discovery/remotecommand)
  │ in-cluster ServiceAccount (default) or KUBECONFIG
  ▼
Kubernetes API Server
```

* **Universal resource engine**: resolves every `group/version/resource` dynamically via the discovery cache — core groups, extension groups and CRDs are manageable without code changes.
* **Credential policy**: the source code contains no passwords or certificates; cluster access comes from the ServiceAccount token auto-mounted by the container runtime. An optional login password is enabled via the `ADMIN_PASSWORD` environment variable (injected from a Secret); sessions are in-memory Bearer Tokens.

## 🚀 Quick Start

### Install on Kubernetes (target nodes need docker + containerd)

```bash
git clone <repo> k8s-stack && cd k8s-stack
./deploy/install.sh                              # Builds and deploys; generates a random password if ADMIN_PASSWORD is unset
ADMIN_PASSWORD='your-strong-password' ./deploy/install.sh   # Or set your own admin password
```

The install flow: multi-stage docker build → import image into containerd (`k8s.io` namespace) → write the Secret → `kubectl apply`. When finished, open `http://<node-IP>:30885` (namespace `kubestack-system`).

### Local development

```bash
cd go-backend && GOPROXY=https://goproxy.cn,direct go build .
KUBECONFIG=/path/to/kubeconfig PORT=8080 ./kubestack-console

# Re-embed the frontend after changes
rm -rf go-backend/web/dist && cp -r frontend go-backend/web/dist
cd go-backend && go build .
```

### Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| PORT | 8080 | HTTP listen port |
| ADMIN_PASSWORD | empty (auth disabled) | Enables login authentication when non-empty |
| DISCOVERY_NAMESPACE | opensandbox | Namespace scanned for third-party sandbox Pods |

## 🛠 Tech Stack

| Layer | Technologies |
| --- | --- |
| Backend | Go, Gin, client-go 0.37 (dynamic / discovery / remotecommand), gorilla/websocket |
| Frontend | Vue 3 (vendored, works offline), xterm.js terminal |
| Deployment | Multi-stage Docker build, containerd image import, kubectl manifests, NodePort 30885 |

## 📁 Directory Structure

```
go-backend/          Go server (internal/server: HTTP+WS, internal/sandbox: sandbox engine)
frontend/            Vue3 SPA (bundled Vue/xterm vendor, works offline)
deploy/              manifests.yaml + Dockerfile + install.sh
docs/screenshots/    UI screenshots
```

## ⚠️ Security Notes

* The repository contains no keys, kubeconfigs, or password literals.
* The cluster role binding is cluster-admin (matching the privileges a KubeSphere-style management plane needs); tighten the ClusterRole as needed in production.
* Web terminal/log endpoints are also protected by the Bearer Token once authentication is enabled.

## 📄 License

No LICENSE file is included in the repository; no open-source license has been declared yet. Please confirm with the author before use.
