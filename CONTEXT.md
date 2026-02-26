# Node-Worker 部署记忆文档

## 项目概述

- **用途**：Cloudflare Workers 上的 VLESS 代理节点 + Docker 管理面板
- **核心文件**：`Node-Worker.js`（源码） → `Node-Worker.obfuscated.js`（部署用）
- **管理端 API**：`https://ccfly.me/api/users`
- **API Token**：`d232d32c885e21177f0fec6dd3b5ea0f112b7cff5ea7ade75b55767f414a324d`
- **管理面板**：`docker-manager/`，Express + SQLite，端口 3000

---

## docker-manager 架构

| 文件 | 说明 |
|------|------|
| `server.js` | 入口，路由注册，cron 定时任务 |
| `database.js` | SQLite（better-sqlite3），用户/设置/日志存取 |
| `routes/admin.js` | 管理员 API，含节点检测、日志查询 |
| `routes/api.js` | 用户订阅 API |
| `routes/user.js` | 用户端 API |
| `views/admin.js` | 管理面板前端（~7000 行，HTML+内联 JS） |

### 启动方式

```bash
cd docker-manager
# 构建镜像并启动（--force-recreate 确保代码变更生效）
docker compose up -d --build --force-recreate
# 查看日志
docker logs -f vles-manager
```

> ⚠️ `docker compose restart` 不重建镜像，代码改动不生效，必须用 `--build --force-recreate`

Docker 日志自动轮转：`max-size: 10m, max-file: 3`（最多 30 MB），无需手动清理。

### 数据库权限注意
直接运行 `node server.js` 创建的 `data/vles.db` 权限为 `codespace:codespace`，Docker 容器内用户不同会报 `readonly database`。修复：
```bash
chmod 666 docker-manager/data/vles.db docker-manager/data/vles.db-shm docker-manager/data/vles.db-wal
```

---

## 功能：手动节点 TCP 存活检测

**位置**：`routes/admin.js` → `checkManualNodes()`

**逻辑**：
1. 取出 `settings.bestDomains` 列表
2. 排除自动抓取节点（正则 `^(\[?[0-9a-fA-F:.]+\]?):443#(v4|v6)(移动|联通|电信|铁通|广电)\s+[A-Z]{3}$`）
3. **跳过 IPv6-only 节点**：原始 IPv6 地址 或 域名无 A 记录（仅 AAAA）→ 直接跳过，不参与禁用判断
4. 剩余节点批量 TCP 测试（每批 8 个并发，超时 5s）
5. 不通 → 添加 `___DISABLED___` 前缀；恢复 → 移除前缀
6. 任何变化才写库，减少写入

**触发方式**：
- cron 每 15 分钟自动执行（`server.js` 定时任务）
- 管理面板"节点管理"页面点击 **立即检测** 按钮（`POST /api/admin/check-nodes`）

**API**：
```
POST /api/admin/check-nodes
响应：{ success, checked, disabled, restored, skipped }
skipped = IPv6-only 节点数
```

---

## 功能：系统日志面板

**后端**：
- `database.js` → `addLog(action, details, level)` 存入 `settings.systemLogs`（最多 1000 条）
- `server.js` 启动时拦截 `console.log/warn/error`，解析 `[模块]` tag 自动入库
- `GET /api/admin/logs?limit=500[&level=info|warning|error|success]`（需登录 cookie）
- `POST /api/admin/logs/clear`（需登录 cookie）

**前端**（`views/admin.js`）：
- 侧边栏"系统日志"入口（`switchSection('logs')`）
- 工具栏：级别筛选（全部/信息/警告/错误/成功）+ 关键词搜索 + 自动刷新（5s）+ 刷新 + 清空
- 移动端适配：工具栏两行布局，时间/模块列在窄屏隐藏，折叠入详情列前缀

---

## Node-Worker 问题汇总

### 问题 1：被 Cloudflare 1101 检测

**原因**：代码含有可识别特征：
- 函数名可读：`handleWebSocket`、`syncRemoteConfig`
- 明文字符串：`"vless"`、`"CF-Node-Worker/1.0"`
- `console.log` 含中文日志
- 404 响应体暴露 UUID 机制

**解决**：
1. 删除所有 `console.log` / `console.error`
2. `User-Agent` 改为 `Mozilla/5.0`
3. 404 响应改为简单 `Not Found`
4. `"vless"` → `String.fromCharCode(118,108,101,115,115)`
5. terser 变量名混淆 + 最大压缩
6. **部署 `Node-Worker.obfuscated.js`，不要部署 `Node-Worker.js`**

### 问题 2：ProxyIP 域名 `CMLiussss.net` 已知基础设施

**解决**：删除 `REGION_PROXY_IPS`、`coloToProxyMap`、`getProxyIPByColo()`，`FALLBACK_CONFIG.proxyIPs = []`

### 问题 3：混淆文件超出 32KB 限制

**解决**：`javascript-obfuscator` 生成 41KB，改用 **terser** → **12.7 KB**

---

## 混淆生成命令（每次修改 Node-Worker.js 后执行）

```bash
cd /workspaces/vles

npx terser Node-Worker.js \
  --module \
  --compress 'passes=3,drop_console=true,pure_getters=true,unsafe=true,join_vars=true' \
  --mangle 'toplevel=true,eval=true' \
  --format 'comments=false,beautify=false' \
  -o Node-Worker.obfuscated.js

node -e "
const fs = require('fs');
let code = fs.readFileSync('Node-Worker.obfuscated.js', 'utf8');
code = code.replace(/([\"'])vless\1/g, 'String.fromCharCode(118,108,101,115,115)');
fs.writeFileSync('Node-Worker.obfuscated.js', code);
console.log('Done. Size:', code.length, 'bytes');
"
```

---

## 当前文件状态

| 文件 | 用途 | 备注 |
|------|------|------|
| `Node-Worker.js` | 源码，可读 | 日常修改这个文件 |
| `Node-Worker.obfuscated.js` | **部署到 Cloudflare** | 每次改完源码重新生成 |
| `Node-Worker-env.js` | 环境变量版本（未混淆） | 多租户部署用 |
| `docker-manager/` | 管理面板 Docker 服务 | `docker compose up -d --build --force-recreate` |

---

## ProxyIP 选择逻辑（当前）

```
URL 参数 ?proxyip=xxx（最高优先）
  ↓ 无
管理后台配置的 proxyIPs 列表（按机房地理位置智能选）
  ↓ 无
不使用 ProxyIP，直连目标（无兜底硬编码）
```

---

## 检测规避清单

| 特征 | 状态 |
|------|------|
| `vless` 明文 | ✅ 已用 charCode 替换 |
| `CMLiussss.net` | ✅ 已删除 |
| `console.log` | ✅ 已删除 |
| `CF-Node-Worker` UA | ✅ 改为 Mozilla/5.0 |
| 404 暴露 UUID 机制 | ✅ 改为简单 Not Found |
| 函数名/变量名可读 | ✅ terser 混淆 |
| 文件大小 | ✅ 12.7 KB（< 32 KB） |

---

## 最近 commit 记录

| commit | 说明 |
|--------|------|
| `48924a4` | chore: upgrade better-sqlite3 to v12 for Node.js v24 |
| `4c9c69b` | fix(nodes): skip IPv6-only nodes in manual health check |
| `389f9ce` | fix(admin): localize log level filter options to Chinese |
| `d4b454c` | fix(admin): make system logs panel mobile-responsive |
| `53ab193` | feat(admin): add system log panel with auto-capture and frontend UI |
| `0cdc133` | feat(admin): add check-nodes button to node management panel |
| `9ba1767` | feat(docker): 手动节点 TCP 存活检测，自动启用/禁用 |
| `0c9542a` | refactor: remove comments, obfuscate, strip CMLiussss proxyIP fallback |
