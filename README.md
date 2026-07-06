# RAGFlow 知识库问答对比系统

这是从昨天轻量 RAG demo 升级后的版本。应用本身负责上传、URL 管理、访问控制、模型配置、问答对比和历史记录；真正的知识库解析、索引和 RAG 问答交给 RAGFlow。

## 功能

- 邀请码访问控制，不做用户体系
- 上传文件到同一个 RAGFlow dataset
- 粘贴 URL 时刷新该 URL 对应的 RAGFlow document
- 问答前可选择刷新全部 URL 源
- 两栏对比：
  - RAGFlow RAG 问答，带引用
  - 直接大模型问答，不使用知识库上下文
- 后台 `/admin`：
  - RAGFlow 和直接模型配置
  - API key 本地加密保存
  - 资料源状态
  - 问答历史
  - RAGFlow 初始化、健康检查、URL 刷新

## 本地运行

```bash
npm install
npm start
```

打开：

```text
http://localhost:4317
```

默认邀请码来自 `.env.example`：

```text
dev-invite
```

本地启动前建议复制配置：

```bash
cp .env.example .env
```

Windows PowerShell 可手动复制 `.env.example` 为 `.env`。

## 必填配置

后台页面可以保存配置，也可以通过环境变量预置：

```text
APP_SECRET=一段足够长的随机字符串
APP_INVITE_CODES=邀请码1,邀请码2
COOKIE_SECURE=false
COOKIE_SAMESITE=Lax
CORS_ORIGINS=http://localhost:4317,http://127.0.0.1:4317,https://pilipiliwang.github.io

RAGFLOW_BASE_URL=http://ragflow-server:9380
RAGFLOW_API_KEY=你的 RAGFlow API Key
RAGFLOW_DATASET_NAME=web-materials
RAGFLOW_CHAT_NAME=web-materials-assistant

DIRECT_AI_BASE_URL=https://api.openai.com/v1
DIRECT_AI_API_KEY=你的模型 API Key
DIRECT_AI_MODEL=模型名
```

`APP_SECRET` 用于加密保存在 SQLite 里的 API key。生产环境不要更换它，否则旧 key 无法解密。

如果已经配置 HTTPS，可以把 `COOKIE_SECURE=true`；如果只是用服务器 IP 和 HTTP 测试，保持 `false`，否则浏览器不会保存邀请码 cookie。

如果用 GitHub Pages 前端连接云服务器后端，后端必须使用 HTTPS，并设置：

```text
COOKIE_SECURE=true
COOKIE_SAMESITE=None
CORS_ORIGINS=https://pilipiliwang.github.io
```

## 云服务器部署

RAGFlow 官方 Docker Compose 比较重，建议先按 RAGFlow 官方文档部署 RAGFlow，然后把本应用接入同一个 Docker network。

1. 在云服务器部署并启动 RAGFlow。
2. 创建或确认 Docker network：

```bash
docker network create ragflow || true
```

3. 让 RAGFlow server 容器加入 `ragflow` network，并确保服务名或别名是 `ragflow-server`，或者修改 `RAGFLOW_BASE_URL`。
4. 启动本应用：

```bash
docker compose up -d --build
```

5. 打开 `http://服务器IP:4317`，用邀请码进入 `/admin`，配置 RAGFlow API key 和模型。

如果你把本应用 compose 文件并入 RAGFlow 官方 compose，只要保证两者在同一个 network，`RAGFLOW_BASE_URL` 指向 RAGFlow server 容器即可。

## GitHub Pages

仓库包含 `.github/workflows/pages.yml`。推送到 GitHub 后，GitHub Pages 会部署 `public/` 目录里的前端应用。

当前 GitHub Pages 部署的是 `public/` 里的真实前端页面，也就是本地 `http://localhost:4317/` 的应用界面。

注意：GitHub Pages 只能托管静态前端，不能运行 Express、SQLite、RAGFlow、文件上传或 API key 加密存储。页面上的“后端 API 地址”需要填写你云服务器上的 `rag-kb-app` 后端地址。

## API

- `POST /api/access`：提交邀请码并设置 httpOnly cookie
- `GET /api/settings` / `POST /api/settings`：读取/保存配置，secret 字段只返回是否已配置
- `POST /api/sources/upload`：上传文件到 RAGFlow dataset 并触发 parse
- `POST /api/sources/url`：添加或刷新 URL document 并触发 parse
- `POST /api/sources/refresh-urls`：刷新全部 URL 源
- `GET /api/admin/sources`：查看资料源状态
- `POST /api/ask/compare`：执行 RAGFlow RAG 问答和直接大模型问答
- `GET /api/admin/qa`：分页查看问答历史
- `GET /api/health`：App、SQLite、RAGFlow、模型配置状态，需要邀请码 cookie
- `GET /healthz`：无敏感信息的公开探活接口

## 测试

```bash
npm test
```

测试覆盖：

- 邀请码和 cookie 访问控制
- API key 加密、脱敏和保存
- RAGFlow adapter 请求封装
- mock RAGFlow + mock 模型的对比问答和历史记录
