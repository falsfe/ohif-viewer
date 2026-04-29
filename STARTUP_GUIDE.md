# OHIF Viewer 本地开发环境启动指南

## 前置条件

- Node.js（已安装）
- Yarn（已安装）
- VMware Ubuntu 虚拟机运行中，IP: `192.168.150.101`

## 架构概览

```
浏览器 (localhost:3000)
  │
  ├─ /api/auth/*  ──proxy──>  auth-api (localhost:4001)
  │                             └─ MySQL (192.168.150.101:3306)
  │
  └─ /dicomweb/*  ──proxy──>  Orthanc (192.168.150.101:8042)
                                 └─ DICOMweb 路径: /dicom-web/
```

## 启动步骤

### 1. 启动虚拟机上的 Docker 容器

SSH 登录 Ubuntu 虚拟机后执行：

```bash
sudo systemctl start docker
docker start ohif-mysql orthanc
```

验证容器状态：

```bash
docker ps
```

应看到两个容器运行中：
- `ohif-mysql` — MySQL 8.4，端口 3306
- `orthanc` — Orthanc DICOMweb，端口 8042

### 2. 启动后端 auth-api

在 Windows 上打开一个终端：

```bash
cd c:\Users\gin\Desktop\ohif\Viewers\services\auth-api
npm run dev
```

看到以下输出表示成功：

```
auth-api listening on http://localhost:4001
```

### 3. 启动前端 OHIF Viewer

在 Windows 上打开**另一个**终端：

```bash
cd c:\Users\gin\Desktop\ohif\Viewers
yarn dev
```

看到以下输出表示成功：

```
[webpack-dev-server] Server started
```

浏览器会自动打开 `http://localhost:3000`。

## 访问地址

| 服务 | 地址 |
|------|------|
| OHIF 前端 | http://localhost:3000 |
| 登录页 | http://localhost:3000/auth/login |
| 注册页 | http://localhost:3000/auth/register |
| auth-api 后端 | http://localhost:4001 |
| Orthanc 管理界面 | http://192.168.150.101:8042 |

## 代理说明

前端通过 webpack dev server 内置代理转发请求，无需手动设置环境变量：

| 前端路径 | 转发目标 |
|----------|----------|
| `/api/auth/*` | `http://localhost:4001` |
| `/dicomweb/*` | `http://192.168.150.101:8042/dicom-web/*` |

代理配置位于 `platform/app/.webpack/webpack.pwa.js`。

## 账号与 Token

- Access Token 有效期：15 分钟
- Refresh Token（httpOnly Cookie）有效期：7 天
- 刷新页面自动恢复登录状态

## 常见问题

### 虚拟机重启后无法连接 MySQL

```bash
sudo systemctl restart docker
docker start ohif-mysql orthanc
```

### 登录后看不到研究列表

检查 Orthanc 容器是否运行，以及是否已上传 DICOM 数据：

```bash
# 浏览器访问
http://192.168.150.101:8042/dicom-web/studies
# 返回 [] 表示 Orthanc 正常但无数据
# 返回连接拒绝表示 Orthanc 未运行
```

### 代理 404

确认 auth-api 后端已启动（步骤 2），并且代理配置未被覆盖。如果启动时使用了 `PROXY_TARGET` 等环境变量，会覆盖默认代理配置。
