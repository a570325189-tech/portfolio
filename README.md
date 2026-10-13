# 游戏特效作品集（Cloudflare Pages + R2）

一个只属于你的作品集站：**你能上传/删除，别人只能看**；视频原片直出、不转码，弹层大屏播放。
免费额度内 **0 元**，且流量永久免费（R2 出网免费），所以不存在"被转发后产生账单"的风险。

---

## 1. 它长什么样

- `/` 作品集首页：封面网格 + 标签筛选 + 点击弹层大屏播放（支持 `←` `→` 切换、`Esc` 关闭、`#v=xxx` 可分享单个作品）
- `/admin` 管理页：密码登录 → 拖入视频 → 自动抓取封面（可调时间点重截）→ 填文案 → 上传发布；可编辑文案、删除视频
- 文案字段：标题、简介、标签、引擎、职责、排序权重

## 2. 目录结构

```
public/                 静态站点（Pages 的输出目录）
  index.html            作品集首页
  admin.html            管理页（noindex）
  config.json           站点标题 / 署名 / 链接（改这里就行）
  assets/app.js         首页逻辑
  assets/admin.js       管理页逻辑
  assets/style.css      深色主题样式
functions/api/          Pages Functions（后端 API）
  _lib.js               会话签名 / R2 SigV4 预签名 / 清单读写（下划线开头，不会被路由）
  session.js            GET  会话状态
  login.js / logout.js  登录 / 退出
  upload-url.js         生成浏览器直传 R2 的预签名 URL
  videos/index.js       GET 作品列表（公开） / POST 新增或改文案（需登录）
  videos/[id].js        GET 单个 / DELETE 删除（需登录 + 连带删对象）
_routes.json            只把 /api/* 交给 Functions，其余走静态
wrangler.toml           Pages 配置与 R2 绑定
test/                   测试（见第 6 节）
```

作品数据不存数据库，就存在 R2 里的 `_manifest.json`；视频存在 `videos/<id>/`。

## 3. 部署（约 15 分钟）

### 3.1 建 R2 桶
Cloudflare 控制台 → **R2** → Create bucket → 名字 `vfx-portfolio`（需先绑定支付方式，免费额度内不扣费）。

### 3.2 生成 S3 API 令牌
R2 → **Manage R2 API Tokens** → Create API Token → 权限选 **Object Read & Write** → 只授权 `vfx-portfolio` 这个桶。
记下三个值：**Access Key ID**、**Secret Access Key**、**Account ID**（页面右上或桶详情里）。

### 3.3 打开公共读取
桶 → Settings → **Public access** → R2.dev subdomain → **Allow**。
你会得到一个形如 `https://pub-xxxxxxxx.r2.dev` 的地址 —— 这就是 `PUBLIC_MEDIA_BASE`。

> Cloudflare 明确说 r2.dev 有限速、不建议用于生产。小规模作品集够用；将来买了域名，把自定义域名绑到桶上、改一下 `PUBLIC_MEDIA_BASE` 即可，**代码不用动**。

### 3.4 配置 CORS（**漏了这步上传一定失败**）
桶 → Settings → **CORS Policy** → 粘贴（把域名换成你的）：

```json
[
  {
    "AllowedOrigins": ["https://你的项目名.pages.dev"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

### 3.5 建 Pages 项目
1. 把本目录推到 GitHub 仓库（`node_modules/` 已在 .gitignore 里）
2. Cloudflare → **Workers & Pages** → Create → **Pages** → Connect to Git → 选该仓库
3. 构建设置：**Build command 留空**，**Build output directory 填 `public`**
4. Settings → **Functions** → R2 bucket bindings → 变量名 `BUCKET` → 桶 `vfx-portfolio`

### 3.6 加环境变量
Settings → **Environment variables**（Production，建议加密存储）：

| 变量名 | 说明 |
|---|---|
| `ADMIN_PASSWORD` | 你自己设的管理密码，登录 `/admin` 用 |
| `SESSION_SECRET` | 一串随机长字符串，用于给登录 Cookie 签名（换了就要重新登录） |
| `R2_ACCOUNT_ID` | 3.2 里的 Account ID |
| `R2_ACCESS_KEY_ID` | 3.2 里的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | 3.2 里的 Secret Access Key |
| `R2_BUCKET_NAME` | `vfx-portfolio` |
| `PUBLIC_MEDIA_BASE` | 3.3 里的 `https://pub-xxxxxxxx.r2.dev` |
| `R2_ENDPOINT`（可选） | 换到非 R2 存储时填端点，如 `https://cos.ap-guangzhou.myqcloud.com`；留空即用 R2 |
| `R2_REGION`（可选） | 配合上面的端点用，默认 `auto` |

改完重新部署一次，然后访问 `https://你的项目名.pages.dev/admin`。

## 4. 部署后验证清单

1. 首页能打开，显示"还没有发布作品。"
2. `/admin` 输入错密码 → 提示"密码错误"；输入对的 → 进入管理区
3. 传一个短视频 → 进度条走完 → 列表出现该作品
4. 回首页刷新 → 出现封面卡片；点击 → 弹层播放
5. 点删除 → 首页同步消失（R2 里的文件也一并删掉）

**第 3 步是我唯一无法在本地验证的环节**（浏览器直传 R2 需要真实凭证）。若它失败，报错会明确提示是 CORS，去 3.4 检查 `AllowedOrigins` 是否与实际访问域名完全一致（含 https、不含结尾斜杠）。

## 5. 已知限制与注意事项

- **国内访问**：`*.pages.dev` 与 `*.r2.dev` 在大陆的连通性和速度不稳定，这是本方案唯一的硬伤。若体验不可接受，两条退路：
  1. 买一个便宜域名绑到 Cloudflare（$1–2/年），自定义域名的国内访问通常好于 `pages.dev`；
  2. 换成国内对象存储（腾讯云 COS / 七牛云）——**后端是 S3 兼容设计**，用第 7 节的迁移脚本搬对象，再改两个环境变量即可，前端与数据格式都不用动。
- **免费额度**：R2 每月 10 GB 存储 + 100 万次写 + 1000 万次读，出网免费。超出后 $0.015/GB·月。按 1080p60 15 Mbps 算，10 GB ≈ 90 个 1 分钟片段。
- **画质**：站点不做任何转码，观众下载到的是你上传的原片。建议导出 **H.264 + faststart**、1080p60、12–25 Mbps；H.265/AV1 体积更小但浏览器兼容性差。
- **单文件上限**：走的是单次 PUT，最大 5 GB（S3 单请求上限）。作品集场景足够。
- **安全**：密码只存在服务端环境变量里，前端不保存密码；会话是 HttpOnly + Secure + SameSite=Strict 的签名 Cookie，14 天过期。`/admin` 已加 `noindex`。
- **没有做防爆破限流**：Cloudflare 免费版可在 Security → WAF 里给 `/api/login` 加一条 Rate limiting 规则，强烈建议加。

## 6. 本地预览与测试

### 6.1 起本地服务

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars    # 里面是可直接用的假值，够跑通前端与接口
npm run dev                              # -> http://127.0.0.1:8799
```

`npm run dev` 用的是 Cloudflare 官方的 wrangler + Miniflare，**就是线上那个运行时**：路由规则、R2 绑定、环境变量都与线上一致，所以本地跑通基本等于线上跑通。R2 数据落在 `.wrangler/state`（已 gitignore），删掉即清空本地数据。

只有一件事本地做不到：**浏览器直传真实 R2**（本地没有真桶），所以"上传视频"那一步在本地会失败，其余全部可跑。

若 `npm run dev` 报"不能同时指定目录和 pages_build_output_dir"之类的错，把 `package.json` 里 dev 脚本末尾的 `public` 去掉即可（`wrangler.toml` 里已经声明了输出目录）。另外 wrangler 要求 Node ≥ 22。

### 6.2 跑测试

```powershell
npm test        # 依次跑下面四个套件
```

| 套件 | 覆盖 |
|---|---|
| `test/run-tests.mjs` | 后端 24 项：会话签名与篡改/过期、登录、权限边界、SigV4 预签名、清单增删改查、路径穿越、端点覆盖 |
| `test/check-frontend.mjs` | 前端静态一致性 95 项：HTML 的 id 与 JS 引用是否一一对应、资源路径是否存在、有无重复 id |
| `test/dom-test.mjs` | 前端行为 16 项：在 jsdom 里真实渲染并模拟交互（卡片、弹层、键盘、筛选、登录、编辑回填） |
| `test/migrate-test.mjs` | 迁移脚本 14 项：签名交叉复算、分页列举、预演不写入、字节完全一致、幂等跳过、失败隔离、删除源的双重确认 |

### 6.3 端到端接口验证（部署后也建议跑一次）

```powershell
npm run dev                                                            # 另开一个终端
node test/integration.mjs                                              # 打本地 http://127.0.0.1:8799
node test/integration.mjs https://你的项目名.pages.dev 你的管理密码      # 也可直接打线上
```

它会真实走一遍：首页与静态资源 → 登录（错密码必须 401）→ 拿预签名直传地址 → 未登录写入必须 401 → 创建作品 → 公开列表出现 → 单个作品可读 → 删除 → 数量复原；并顺带确认 `_lib.js` 这类下划线文件没有被暴露成接口。

> 关于验证强度：SigV4 签名除了与 `node:crypto` 的独立实现交叉复算，还对齐了 AWS 官方文档公布的签名密钥派生向量。在拿不到你的真实 R2 凭证的前提下，这已经是能验证到的最强程度；唯一没被验证的就是"浏览器 PUT 到真实 R2"这一段。

## 7. 以后想换存储（批量迁移）

后端是 S3 兼容写法，所以换到腾讯云 COS / 七牛 / B2 / MinIO 时，只要"搬对象 + 改配置"，**前端、清单、管理页都不用动**——清单里存的是对象 key，播放地址是读取时用 `PUBLIC_MEDIA_BASE` 拼出来的。

```powershell
Copy-Item migrate.config.example.json migrate.config.json   # 填源与目标两端的 endpoint / 桶 / 密钥
node scripts/migrate.mjs --list                             # 先看有哪些对象、各多大
node scripts/migrate.mjs --copy --dry-run                   # 预演：只报告要复制什么，不写一个字节
node scripts/migrate.mjs --copy                             # 全量复制并逐个校验大小
node scripts/migrate.mjs --copy --delete-source --yes        # 确认无误后再清空源
```

不想用配置文件，也可以用环境变量：源端 `SRC_ENDPOINT` / `SRC_BUCKET` / `SRC_ACCESS_KEY_ID` / `SRC_SECRET_ACCESS_KEY` / `SRC_REGION`，目标端同理换成 `DST_*`。

脚本特性：分页列举、并发 3（`--concurrency` 可调 1–8）、幂等（目标已存在且大小一致就跳过，`--force` 强制重传）、单对象失败重试 3 次且不影响其它对象、结束汇总失败清单、流式传输（大文件不占内存）、复制后按大小校验。

搬完之后改三处：

1. 新存储开好公开访问，拿到域名；
2. Pages 里把 `PUBLIC_MEDIA_BASE` 改成新域名；
3. 新存储不是 R2 的话，补上 `R2_ENDPOINT`（如 `https://cos.ap-guangzhou.myqcloud.com`）与 `R2_REGION`，让上传的预签名指向新端点。

个别厂商要求 SigV4 的 service name 用 `cos` 而不是 `s3`；若遇到签名错误，改 `functions/api/_lib.js` 里 `presignR2Put` 中的 `const service = 's3'` 一处即可。

## 8. 日常使用

- 加作品：进 `/admin` → 拖视频 → 补文案 → 上传并发布
- 改文案／调顺序：列表里点「编辑文案」，改完保存（不会重传视频）
- 换视频：删除后重传
- 改站点标题、署名、链接：编辑 `public/config.json` 后重新部署
