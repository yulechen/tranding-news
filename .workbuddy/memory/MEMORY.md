# 云端信息库 · 项目长期记忆

## 关键标识
- 云应用 appId：`wbapp_nYUBg7YCbzNbEX9V2pDJ4d` —— **发布时必须复用这个 id**，换新 id 会导致域名变、云登录 Origin 校验失败
- 线上地址 / 云数据面 endpoint：`https://info-vault.app.workbuddy.host`
- 收件箱写入密钥 `INGEST_KEY`：出现在 **4 处**，改一处必须全改 ——
  `server.js` 与 `tools/push.mjs`、`tools/selfcheck.mjs` 里的 `process.env.INGEST_KEY || '...'` 兜底，
  以及 `public/app.js` 第 11 行**内联明文**（收件箱条鉴权用）。
  ⚠️ 因为是内联在浏览器端，这个密钥**本来就是公开的**，别把它当机密。

## 代码仓库（GitHub）
- 远端：`https://github.com/yulechen/tranding-news`（**PUBLIC**），分支 `main`，远端地址名 `origin`
- 身份只配在 **repo 局部**（`yulechen` / `3973126+yulechen@users.noreply.github.com`），不动全局配置
- `core.autocrlf` 全局为 `true`，本仓库**局部设为 `false`**（源文件均为 LF）
- 🚫 **`.gitignore` 里临时文件规则必须写 `.tmp-*`**，写成 `.tmp-*/` 带尾斜杠只匹配目录，
  会让临时文件被 `git add -A` 一起提交（已踩过一次）
- 验证忽略规则用 `git check-ignore -v --no-index <path>`；**不加 `--no-index` 时，
  已跟踪文件一律报「未忽略」**，会误判规则失效
- ⚠️ **沙箱下 `git fetch` 写不进 `refs/remotes/origin/main`**：`fetch` 会打印
  `[new branch] main -> origin/main`，但本地其实没落盘，表现为 `status -sb` 显示 `[gone]`、
  `rev-parse origin/main` 解析失败。**这不是远端问题** —— 判据是 `git ls-remote origin`。
  修法：用 node 直接 `.git/refs/remotes/origin/main` 写入 sha 后即恢复正常。
  **远端状态永远以 `git ls-remote` / `gh api` 为准。**
- 排除项：`design/preview/*.png`（可由 `tools/shot.mjs` / `make-icons.mjs` 重新生成）、
  `inbox/*`（保留 `.gitkeep`）、`.tmp-*`、`node_modules/`

## 架构约定
- 前端是纯静态、无构建步骤：云 SDK 走自托管 `public/vendor/workbuddy-cloud-sdk.js`（不用 CDN，避免国内加载不稳）
- 后端 `server.js` 零第三方依赖，只做两件事：静态托管 + `/api/inbox` 收件箱
- **站点公开、无需登录**（用户 2026-09-19 明确要求「不需要注册验证，全部都可以看」）：`documents` 四条 RLS 策略全部放开为 `true`，`owner_id` 允许为空
- 内容正文（HTML 源码）直接存在 `documents.content` 字段，**不用云对象存储** —— Storage 必须登录才能读，与公开诉求直接冲突
- 列表查询不带 `content`，预览时按 id 单独拉取，避免大字段拖慢首屏
- 预览把 `content` 塞进 iframe 的 `srcdoc`（sandbox 刻意不含 `allow-same-origin`，隔离风险）

## 推送链路：直接入库
- **云 SDK 可以在 Node 里跑**：`tools/push.mjs` 用 `vm` 沙箱加载前端那份 SDK，补齐
  `window`/`self`/`fetch`/`webcrypto`/`Headers`/`Response`/`Blob`/`FormData`/`atob`/`btoa` 等浏览器全局，
  再用 `public/config.js` 的 `endpoint`+`publishableKey` 建客户端，**匿名身份就能读写库**。
- 推送默认 **直接入库**（推完立刻可见），`--inbox` 才是旧的收件箱暂存模式。
- 这条路径不需要任何长期密钥，改 SDK 版本时注意浏览器全局是否够用。
- 🚫 **推送不写标签**（用户 2026-09-19 明确要求「推送数据不能设置标签，标签我自己维护」）：
  `tags` 强制 `[]`；`--tags` 参数保留但忽略，只为兼容旧脚本。
  曾因机器自动打标签，4 条内容攒出 21 个标签、19 个只用过一次，标签区被撑乱。
  **归档只给标题 / 摘要 / 类型。**

## 标签的维护方式
- 标签**由用户手工维护**，这是系统里唯一的组织方式（用户 2026-09-19 要求去掉搜索与上传入口）。
- 最主要的入口是**每张卡片右上角的标签按钮**（`data-tagedit`，在星标左侧），点开 `#tag-modal`：
  输入框回车/逗号成词、当前标签 chip 可 ✕ 移除、下方「已有标签」池点一下加入再点移除、
  上限 `MAX_TAGS = 12`；草稿放 `tagDraft`，点保存才落库。
- 「编辑信息」弹窗里也有标签字段（带 `renderTagSuggest` 快捷追加）；预览页顶栏有 `data-act="tag"` 按钮。
- 工具栏标签行是**按标签过滤**的主入口；一条标签都没有时**不隐藏**，显示引导语。
- 公共函数：`tagCounts(list)`（按次数降序统计）、`splitTags(v)`（兼容中英文逗号与空格）。

## 分面计数规则（容易写错）
- 类型 chip 的计数 = 「收藏 + 标签」过滤后的结果（`afterTag`）
- 标签 pill 的计数 = 「收藏 + 类型」过滤后的结果（`afterType`）
- 两者**都不等于**当前列表条数，这是刻意的：每个选项上的数字要代表「点进去大概有几条」
- 选中的标签若被类型筛成 0 条，仍要留在标签行里，否则用户看不到自己卡在哪个筛选上、退不出来

## 项目级约束
- 平台网关占用 `/healthz`；应用自己的健康检查是 `/api/health`
- 🚫 **页面刻意不提供上传入口与搜索**（用户 2026-09-19 要求）：内容只从 WorkBuddy 推过来，查找全靠标签。
  自检里有「页面不含上传入口与搜索」一项守着，别再手痒加回去。
- 本机 bash 没有 coreutils，脚本一律用 node 写，不要用 ls/dirname/cat
- 每次改完代码跑 `node tools/selfcheck.mjs [--base <url>]`，23 项要全绿
- **UI 改动必须实际截图看过再交付**：`node tools/shot.mjs --out x.png --script "<JS>"`，
  用本机 Chrome 的 CDP 无头模式，能执行一段 JS 后再截图（拍交互后的状态），零安装零依赖

## 常用命令
- 本地起服务：`node server.js`（默认 3000）
- 推送内容（默认直接入库，**不带标签**）：`node tools/push.mjs --file a.html --title "标题" --summary "摘要" --type report`
  （`--tags` 参数还在但被忽略，只为兼容旧脚本）
- 推送内容（暂存收件箱）：加 `--inbox`
- 自检线上：`node tools/selfcheck.mjs --base https://info-vault.app.workbuddy.host`
- 页面截图：`node tools/shot.mjs --out shot.png [--url ...] [--script "..."]`
- 图标光栅化：`node tools/make-icons.mjs`

## 前端功能点（避免重复实现）
- 收藏：工具条首个 chip（`data-fav`）切换只看收藏；状态存 DB `documents.starred`；
  深链 `#fav`；预览页顶栏也有收藏按钮；卡片 `is-starred` 有琥珀色顶条
- 筛选都是前端本地过滤（一次拉最多 500 条列表，不带 `content`）
