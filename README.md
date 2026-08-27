# KubeStack Console

对标 KubeSphere 使用体验的开源 Kubernetes 管理平台，使用 **Go (client-go) + Vue3** 构建，
内置 **沙箱管理** 平台。单二进制部署，前端嵌入二进制，无需外部数据库。

## 功能总览

| 模块 | 能力 |
| --- | --- |
| 集群总览 | 资源计数、CPU/内存实时用量（metrics-server）、节点健康、Top Pods、告警事件 |
| 节点管理 | 列表/详情、条件与健康、cordon / uncordon |
| 项目管理 | 命名空间（项目）CRUD、全局命名空间切换作用域 |
| 工作负载 | Deployment / StatefulSet / DaemonSet / ReplicaSet / Job / CronJob / HPA：列表、详情、YAML 编辑、滚动重启、扩缩容、删除 |
| 容器组 Pods | 状态识别（Waiting 原因/重启数/节点/IP）、实时日志流（follow）、**网页终端 exec**、YAML 查看 |
| 服务与路由 | Service（NodePort 高亮）/ Ingress / EndpointSlice |
| 配置中心 | ConfigMap / Secret 管理 |
| 存储管理 | PVC / PV / StorageClass |
| 权限管理 | ServiceAccount / Role / RoleBinding / ClusterRole / ClusterRoleBinding |
| CRD 浏览器 | 发现集群全部 API 资源（含任意 Operator CRD）并做通用 CRUD 与 YAML 编辑 |
| 事件查询 | 全局/项目范围过滤、类型过滤、自动刷新 |
| **沙箱管理** | 一键创建隔离沙箱环境（独立命名空间 + ResourceQuota + LimitRange + 工作负载模板）、启停、续期、到期 TTL 自动回收、NodePort 暴露、内嵌终端；自动发现集群已有 E2B/OpenSandbox/agents.x-k8s.io 沙箱实例统一展示 |
| YAML 应用中心 | 多文档 YAML 在线应用（语义同 kubectl apply），创建或更新 |

## 架构

```
浏览器 (Vue3 SPA)
  │ REST /api/res/** 通用资源引擎     WebSocket /ws/exec/** 终端
  ▼
Go 单进程 (gin + client-go dynamic/discovery/remotecommand)
  │ in-cluster ServiceAccount（默认）或 KUBECONFIG
  ▼
Kubernetes API Server
```

* **通用资源引擎**：基于 discovery 缓存动态解析所有 `group/version/resource`，
  核心组、扩展组与 CRD 无需改代码即可管理。
* **凭据策略**：源码不包含任何密码/证书；集群访问凭证由容器运行时通过
  ServiceAccount token 自动挂载获得。可选登录口令经 `ADMIN_PASSWORD`
  环境变量（Secret 注入）启用，登录态为内存型 Bearer Token。

## 快速开始

### 在 Kubernetes 上安装（目标节点需 docker + containerd）

```bash
git clone <repo> k8s-stack && cd k8s-stack
./deploy/install.sh                       # 构建并部署，未设 ADMIN_PASSWORD 时自动生成随机密码
ADMIN_PASSWORD='你的强密码' ./deploy/install.sh   # 或自定义管理员密码
```

安装完成后访问 `http://<节点IP>:30885`。

### 本地开发

```bash
cd go-backend && GOPROXY=https://goproxy.cn,direct go build .
KUBECONFIG=/path/to/kubeconfig PORT=8080 ./kubestack-console

# 前端改动后重新嵌入
rm -rf go-backend/web/dist && cp -r frontend go-backend/web/dist
cd go-backend && go build .
```

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| PORT | 8080 | HTTP 监听端口 |
| ADMIN_PASSWORD | 空（关闭鉴权） | 非空时启用登录鉴权 |
| DISCOVERY_NAMESPACE | opensandbox | 第三方沙箱 Pod 的发现命名空间 |

## 目录结构

```
go-backend/          Go 服务端（internal/server: HTTP+WS, internal/sandbox: 沙箱引擎）
frontend/            Vue3 单页应用（vendor 内置 Vue/xterm，离线可用）
deploy/              manifests.yaml + Dockerfile + install.sh
```

## 安全说明

* 仓库内不含任何密钥、kubeconfig 或密码字面量。
* 集群角色绑定为 cluster-admin（对标 KubeSphere 平台管理面所需权限），
  生产环境可按需收敛 ClusterRole。
* Web 终端/日志入口在启用鉴权后同样受 Bearer Token 保护。
