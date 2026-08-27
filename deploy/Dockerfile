# 多阶段构建：Go 静态编译 + 前端嵌入 + 极简运行层
# 构建上下文 = 仓库根目录（deploy/install.sh 已 cd 到根目录）
FROM docker.m.daocloud.io/library/golang:1.24-alpine AS build
ARG GOPROXY_PROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY_PROXY} GOSUMDB=off CGO_ENABLED=0
WORKDIR /src
COPY go-backend/go.mod go-backend/go.sum* ./
RUN go mod download || true
COPY go-backend ./
COPY frontend ./web/dist
RUN go build -ldflags "-s -w" -o /out/kubestack-console .

FROM docker.m.daocloud.io/library/debian:bookworm-slim
COPY --from=build /out/kubestack-console /usr/local/bin/kubestack-console
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/kubestack-console"]
