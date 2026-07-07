# RAGFlow 知识库问答系统

这是一个可上云部署的 RAGFlow-backed 知识库问答应用。前端可以部署在 GitHub Pages，后端部署在云服务器，后端负责邀请码访问控制、资料源管理、RAGFlow 调用、直接大模型调用、历史记录、后台任务和对外 API。

## 核心能力

- 上传文件和粘贴 URL，进入同一个 RAGFlow dataset。
- URL 重复粘贴会刷新旧 document，再导入并触发解析。
- 问答时同时展示 RAGFlow RAG 答案和直接大模型答案。
- 后台 `/admin` 可查看设置、资料源、问答历史、后台任务和健康状态。
- 网页访问使用邀请码 cookie，不做完整用户系统。
- 外部网站对接使用 `/api/v1/*`，通过 `Authorization: Bearer <key>` 或 `X-API-Key` 认证。
- API key 存在 SQLite 中并用 `APP_SECRET` 加密，接口不会明文回显。
- 长任务支持后台 job：上传文件、刷新 URL、刷新全部 URL、异步问答。

## 本地运行

```bash
npm install
cp .env.example .env
npm start
```

打开：

```text
http://localhost:4317
```

默认邀请码在 `.env.example` 中是：

```text
dev-invite
```

## 必要配置

生产环境至少需要配置：

```text
APP_SECRET=一段足够长的随机字符串
APP_INVITE_CODES=邀请码1,邀请码2
EXTERNAL_API_KEYS=给外部网站调用的key1,给外部网站调用的key2

RAGFLOW_BASE_URL=http://ragflow-server:9380
RAGFLOW_API_KEY=你的 RAGFlow API Key
RAGFLOW_DATASET_NAME=web-materials
RAGFLOW_CHAT_NAME=web-materials-assistant

DIRECT_AI_BASE_URL=https://api.openai.com/v1
DIRECT_AI_API_KEY=你的模型 API Key
DIRECT_AI_MODEL=模型名
```

`APP_SECRET` 用来加密 SQLite 里的 API key。生产环境不要随意更换，否则旧 key 无法解密。

URL 导入会先调用 RAGFlow 的 `type=web`；如果失败，会由 App 后端抓取网页正文后作为文本文件上传到 RAGFlow。若目标网站阻止服务端抓取，默认会再尝试 reader fallback。需要关闭这个第三方 reader fallback 时设置：

```text
URL_READER_FALLBACK=false
```

Windows 本地开发时，如果 Node 网络栈访问 reader 超时，但系统网络能访问，App 还会尝试 PowerShell 系统抓取作为最后兜底。Docker/Linux 云端不会依赖这个能力；需要关闭时设置 `URL_READER_SYSTEM_FETCH=false`。

如果 GitHub Pages 前端连接云服务器后端，后端必须使用 HTTPS，并设置：

```text
COOKIE_SECURE=true
COOKIE_SAMESITE=None
CORS_ORIGINS=https://pilipiliwang.github.io
```

## GitHub Pages

仓库包含 `.github/workflows/pages.yml`，推送后会部署 `public/` 目录，也就是本地 `http://localhost:4317/` 的前端界面。

注意：GitHub Pages 只能托管静态前端，不能运行 Express、SQLite、RAGFlow、文件上传或 API key 加密。页面上的“后端 API 地址”需要填写云服务器上的后端地址，例如：

```text
https://rag.example.com
```

## 云服务器部署

轻量部署可直接使用根目录 compose：

```bash
docker compose up -d --build
```

生产部署建议使用 `deploy/`：

```bash
cd deploy
cp .env.production.example .env
# 修改 .env
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
```

生产 compose 包含：

- `rag-kb-app`：本应用后端和静态页面服务。
- `caddy`：HTTPS 反向代理。
- `rag-kb-data`：SQLite 和上传暂存文件持久化卷。

RAGFlow 本身仍建议按官方 Docker Compose 部署，并让 RAGFlow server 加入名为 `ragflow` 的 Docker network，或修改 `RAGFLOW_BASE_URL` 指向实际地址。

## 对外 API

所有 `/api/v1/*` 接口都需要 API key：

```bash
curl https://rag.example.com/api/v1/health \
  -H "Authorization: Bearer your-external-api-key"
```

常用接口：

- `GET /api/v1/health`
- `GET /api/v1/sources`
- `POST /api/v1/sources/url`
- `POST /api/v1/sources/upload`
- `POST /api/v1/sources/refresh-urls`
- `POST /api/v1/ask`
- `POST /api/v1/ask/compare`
- `GET /api/v1/jobs/:id`

示例：异步刷新 URL。

```bash
curl https://rag.example.com/api/v1/sources/url \
  -H "Authorization: Bearer your-external-api-key" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://www.chuancheng.tech"],"async":true}'
```

示例：同步 RAG 问答。

```bash
curl https://rag.example.com/api/v1/ask \
  -H "Authorization: Bearer your-external-api-key" \
  -H "Content-Type: application/json" \
  -d '{"question":"这个网站的知识库怎么用？","refreshUrls":false}'
```

示例：异步对比问答。

```bash
curl https://rag.example.com/api/v1/ask/compare \
  -H "Authorization: Bearer your-external-api-key" \
  -H "Content-Type: application/json" \
  -d '{"question":"资料里有哪些应用场景？","refreshUrls":true,"async":true}'
```

异步接口返回 `job.id` 后，用：

```bash
curl https://rag.example.com/api/v1/jobs/job_xxx \
  -H "Authorization: Bearer your-external-api-key"
```

## 测试

```bash
npm test
```

当前测试覆盖：

- 邀请码和 cookie 保护。
- 外部 API key 鉴权。
- API key 加密、脱敏、持久化。
- jobs 表和后台任务执行器。
- RAGFlow adapter 的上传、URL、parse、chat、重试和解析轮询。
- URL 导入的后端正文抓取和 reader fallback。
- mock RAGFlow + mock 模型的对比问答和历史记录。
