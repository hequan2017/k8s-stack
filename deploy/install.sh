#!/usr/bin/env bash
# KubeStack Console 一键安装脚本（在目标节点上执行）
# 流程：docker 构建(多阶段, Go 编译) → 导入 containerd(k8s.io) → kubectl apply
# 凭据：ADMIN_PASSWORD 从执行环境读取并写入 Secret，脚本/仓库中不包含任何真实密码。
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE="kubestack-console:${IMAGE_TAG}"
GOPROXY_BUILD="${GOPROXY_BUILD:-https://goproxy.cn,direct}"

echo "==> [1/4] docker build ${IMAGE}"
docker build \
  --build-arg GOPROXY_PROXY="${GOPROXY_BUILD}" \
  -f deploy/Dockerfile -t "${IMAGE}" .

echo "==> [2/4] import image into containerd (k8s.io namespace)"
docker save "${IMAGE}" | ctr -n k8s.io images import -

echo "==> [3/4] ensure secret / config"
if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
  kubectl -n kubestack-system create secret generic kubestack-console-config \
    --from-literal=admin-password="${ADMIN_PASSWORD}" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  # 未提供密码：生成随机密码并打印一次（保存在 Secret 中，不写入任何文件）
  if ! kubectl -n kubestack-system get secret kubestack-console-config >/dev/null 2>&1; then
    RAND_PW="$(head -c 18 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"
    kubectl -n kubestack-system create secret generic kubestack-console-config \
      --from-literal=admin-password="${RAND_PW}"
    echo "!! 已生成随机管理员密码: ${RAND_PW}"
    echo "!! （仅此一次显示；如需自定义，导出 ADMIN_PASSWORD 后重跑本步骤）"
  fi
fi

echo "==> [4/4] apply manifests"
kubectl apply -f deploy/manifests.yaml
kubectl -n kubestack-system rollout status deployment/kubestack-console --timeout=180s

NODE_IP="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
cat <<EOF

============================================================
 KubeStack Console 部署完成
 访问地址:  http://${NODE_IP}:30885
 命名空间:  kubestack-system
============================================================
EOF
