# Seedance 后端骨架

这是给当前前端页面配套的最小后端版本，目标是先把这条链路搭起来：

- 上传视频
- 创建分析任务
- 查询任务状态
- 返回结构化结果

当前版本已经具备：

- `FastAPI` 接口
- 本地文件任务存储
- `ffprobe` 视频信息探测
- `ffmpeg` 镜头切分
- 自动把原镜头打包为 `<= 15s` 的段落
- 返回结构化 `JSON` 结果

当前版本还没有接入：

- 多模态画面理解模型
- OCR 服务
- 对象存储
- 真正的队列系统
- 数据库

## 目录

```text
backend/
  app/
    __init__.py
    main.py
  data/jobs/
  requirements.txt
  Dockerfile
  start.sh
  render.yaml
  railway.toml
```

## 安装依赖

```bash
pip install -r /workspace/backend/requirements.txt --break-system-packages
```

## 启动服务

```bash
uvicorn app.main:app --app-dir /workspace/backend --host 0.0.0.0 --port 9000 --reload
```

启动后接口地址默认是：

```text
http://127.0.0.1:9000
```

前端当前默认也会请求这个地址。

如果你的前端不和后端部署在同一个地址，可以这样覆盖前端调用地址：

```text
http://你的前端地址/?api=http://你的后端地址:9000
```

也可以在浏览器控制台执行：

```js
localStorage.setItem("seedance_api_base", "http://你的后端地址:9000")
```

## 环境变量

后端支持这些环境变量：

- `PORT`
  - 平台分配的端口，Docker 启动脚本会自动读取
- `SEEDANCE_CORS_ORIGINS`
  - 允许的前端来源，多个地址用英文逗号分隔
  - 示例：`https://你的前端域名,https://另一个域名`
- `SEEDANCE_DATA_DIR`
  - 后端本地临时数据目录
  - 默认是 `backend/data`

## 部署到 Railway

最简单的做法：

1. 把整个仓库推到 GitHub
2. 登录 Railway
3. 选择 `New Project`
4. 选择 `Deploy from GitHub repo`
5. 选中你的仓库
6. 在服务设置里把 Root Directory 设成：

```text
backend
```

7. Railway 会自动识别 `Dockerfile`
8. 部署完成后，在变量里补：

```text
SEEDANCE_CORS_ORIGINS=https://你的前端地址
```

9. 拿到 Railway 生成的公网后端地址
10. 前端访问时加上：

```text
?api=https://你的后端地址
```

## 部署到 Render

这个目录已经自带：

- `render.yaml`
- `Dockerfile`

步骤：

1. 把仓库推到 GitHub
2. 登录 Render
3. 选择 `New +`
4. 选择 `Blueprint`
5. 连接你的 GitHub 仓库
6. Render 会读取 `backend/render.yaml`
7. 部署完成后，把：

```text
SEEDANCE_CORS_ORIGINS
```

改成你的前端地址

## 当前部署边界

这个版本适合先部署验证链路，但要注意：

- 任务数据目前落本地磁盘
- 服务重启后，本地任务文件可能丢失
- 还没有对象存储
- 还没有正式队列

所以它现在更适合：

- 验证前后端闭环
- 小规模测试
- 继续往正式版演进

## 主要接口

### 1. 健康检查

```http
GET /api/health
```

### 2. 创建任务

```http
POST /api/jobs
Content-Type: multipart/form-data
```

表单字段：

- `file`: 视频文件
- `analysis_mode`: `fast` 或 `detail`
- `segment_max_seconds`: 单段最大秒数，默认 `15`

### 3. 查询任务

```http
GET /api/jobs/{job_id}
```

### 4. 查询结果

```http
GET /api/jobs/{job_id}/result
```

## curl 示例

```bash
curl -X POST "http://127.0.0.1:9000/api/jobs" \
  -F "file=@/workspace/.uploads/f89fdacc-c3d9-4ff1-830f-29d3ea575c3c_38047f1655cee72c4397d27efb6a40f5_raw.mp4" \
  -F "analysis_mode=fast" \
  -F "segment_max_seconds=15"
```

## 下一步建议

建议按这个顺序继续补：

1. 接入对象存储，避免视频只落本地磁盘
2. 把后台任务切到真正队列
3. 为每个镜头接入多模态模型生成更具体的 `画面/镜头运动/旁白`
4. 前端改成轮询这个后端 API，而不是浏览器本地重分析
