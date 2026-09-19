# 云端信息库 · 项目长期记忆

## 关键标识
- 云应用 appId：`wbapp_nYUBg7YCbzNbEX9V2pDJ4d` —— **发布时必须复用这个 id**，换新 id 会导致域名变、云登录 Origin 校验失败
- 重新发布的调用式：`action` 默认 deploy，带 `appId` + `domainPrefix: "info-vault"` +
  **`userAskedToPublish: true`（对应用户当轮明确说「上线」）+ `updateExistingApp: true`**
  —— 后两个都不能省：前者是平台的发布同意校验（**不跨轮继承**，改了内容就必须重新问），
  后者保证复用同一 app 且**不改动它的显示名**。
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

## 数据表
- `documents`：内容归档。正文直存 `content`；列表查询不带 `content`
- `messages`：留言板（2026-09-19 新增）。字段 `id / author / body / created_at`，
  带 CHECK（body 非空且 ≤2000 字、author ≤40 字）；RLS 四条策略同样全放开

## 开放接口（裸 REST，实测可用）
- 路径：`{endpoint}/.cloud/database/rest/<表名>`，例如
  `https://info-vault.app.workbuddy.host/.cloud/database/rest/documents`
- 鉴权头：**`x-wb-webapp-access-key: <publishableKey>`** —— 注意不是 `apikey` 也不是 `Bearer`。
  这是拦一次真实 SDK 请求才拿到的（SDK 里是拼字符串，搜不到字面量），别凭记忆写
- 实测：GET 列表 200；POST 写入 201 —— **必须带 `Prefer: return=representation` 才会回传新行**；
  DELETE 204；不带密钥 401 `invalid_client`
- 页面上的「接口」按钮（`#api-modal`）就是这份文档，端点与示例全部由 `CFG.endpoint` 拼出，
  **不写死域名**；自检里有断言切出 `renderApiDoc` 片段检查其中不含 `http://` / `https://`
- 🔑 云端错误码是**带前缀**的（如 `DATABASE_23514`），前端 `friendly()` 的判断要用
  `includes` 而不是 `===`，否则错误翻译整块失效

## 前端顶栏（2026-09-19 起）
- 只有三个按钮：**接口**（`#btn-api` → 开放接口说明弹窗）、
  **留言**（`#btn-msg`，带条数角标 `#msg-badge` → 留言板弹窗）、**刷新**
- 窄屏（≤680px）下按钮文字隐藏只留图标；角标保留，否则认不出哪个是留言
- 留言弹窗 `#msg-modal`：上半输入区（署名存 localStorage `iv_msg_author`、
  Ctrl/⌘+Enter 发送），下半倒序列表（`#msg-list`，可删）；删除前 confirm
- 🚫 留言板的**遮罩点击刻意不关闭**（打字时误触太烦），只认关闭按钮与 Esc

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

## 设计系统与无障碍（2026-09-19 v5「留白 · 秩序」重构后）
- **所有数值只在 `public/styles.css` 顶部的 `:root` token 里**：色彩、间距（4 的倍数）、
  7 级字阶（`--fs-2xs…--fs-xl` = 11/12/13/14/16/17/22）、6 级圆角、阴影、动效时长。
  规则里不要再写字面值；改主题只动 token。
- **视觉基调**：中性灰底（`--bg: #f4f5f7`）+ 顶部 320px 极淡白光渐隐；
  强调色只有一种蓝 `--accent: #2563eb`，**一屏最多出现两处**。
  🚫 别再把满屏彩色径向渐变背景加回来（v4 有，v5 刻意去掉）。
- **类型靠左侧色条识别**：`.card::before` 是 3px 竖条，按 `.card[data-type]` 着色
  （报告=蓝 / 看板=青 / 工具=绿 / 页面=橙），hover 变 4px。
  `data-type` 由 app.js 渲染卡片时写入 —— **加新类型要同时补 CSS 和 `TYPE_LABEL`**。
  因此 `.type-badge` 只剩一行浅灰小字，不再带彩色圆点（颜色信息归色条）。
- **类型筛选是分段控件**（`.segmented` > `.seg`，浅灰轨道 + 选中项白底），
  不是一排胶囊；收藏是独立的 `.chip-star`（琥珀色）。收藏卡**不覆盖类型色条**，
  靠暖色描边 + 暖底 + 填充星标表达。
- 🚫 **`:focus-visible` 焦点环是无障碍底线**，别删；文本输入类用 box-shadow 环画焦点，
  所以单独 `outline: none`，避免双环。
- **卡片打开方式是 stretched link**（`.card-link` + 伪元素 `inset:0`），不是给卡片加
  `role="button" tabindex="0"`：卡内还有星标 / 标签按钮，"按钮套按钮"在 ARIA 上是违规的。
  尺寸改动注意 `.card-actions` 的 `z-index: 2`（要压过铺满整卡的链接伪元素）。
  因为 `.card { overflow: hidden }`，卡片焦点环只能画成 `inset` 阴影，画不到外面。
- **弹窗一律走 `openModal/closeModal`**（焦点还原 + 计数式滚动锁 + `trapFocus` 焦点陷阱），
  别再用 `classList.remove('is-hidden')` 裸开。
- 🚫 **不要用原生 `window.confirm`**：统一走 `confirmAction({title,text,okText,tone})`（返回 Promise）。
  自检里有断言挡着这两条回潮。
- 动效要尊重 `prefers-reduced-motion`；只有 hover 才出现的元素，触屏要靠
  `@media (hover: none)` 常显。

## 项目级约束
- 平台网关占用 `/healthz`；应用自己的健康检查是 `/api/health`
- 🚫 **页面刻意不提供上传入口、搜索与排序控件**（用户 2026-09-19 要求）：内容只从 WorkBuddy 推过来，
  查找全靠标签，排序固定「最新优先」（不再有下拉）。自检里「页面不含上传入口与搜索」与
  「固定最新优先，无排序控件」两条守着，别再手痒加回去。
- 本机 bash 没有 coreutils，脚本一律用 node 写，不要用 ls/dirname/cat
- 每次改完代码跑 `node tools/selfcheck.mjs [--base <url>]`，**本地 27 项 / 线上 29 项**要全绿
  （「开放接口」那组只在非 localhost 地址上执行，本地会打印跳过原因）
- **UI 改动必须实际截图看过再交付**：`node tools/shot.mjs --out x.png --script "<JS>"`，
  用本机 Chrome 的 CDP 无头模式，能执行一段 JS 后再截图（拍交互后的状态），零安装零依赖。
  脚本一长就会被 shell 引号咬，改用 **`--script-file <路径>`** 从文件读
- ⚠️ **窄屏弹窗量宽度要直接量卡片**：`.modal` 是 grid + 隐式 auto 轨道，
  `pre` 里的长行会把轨道顶宽到视口之外（实测 500px 视口里卡片被撑成 979px），
  而 `document.scrollWidth` 因为 fixed 定位 + overflow:auto **报不出来**。
  移动端媒体查询里已加 `grid-template-columns: minmax(0, 1fr)` 固定单列满宽
- ⚠️ **本机 3300 端口被 trandingos_v3（股票自选管理系统）占着，别用它起临时服务。**
  Windows 下同一地址端口允许两个进程绑定，**先绑定的接走请求** ——
  自己的服务日志照常打印「已启动」，但请求全被另一个进程接走（抓到的会是股票系统的页面）。
  起临时服务挑 3517 这类冷门端口，并且**起完先 fetch 一下用特征词自证**再往下做。
  另：那个股票服务是用户自己在跑的，**不要 kill 它**。

## 常用命令
- 本地起服务：`node server.js`（默认 3000）
- 推送内容（默认直接入库，**不带标签**）：`node tools/push.mjs --file a.html --title "标题" --summary "摘要" --type report`
  （`--tags` 参数还在但被忽略，只为兼容旧脚本）
- 推送内容（暂存收件箱）：加 `--inbox`
- 自检线上：`node tools/selfcheck.mjs --base https://info-vault.app.workbuddy.host`
- 页面截图：`node tools/shot.mjs --out shot.png [--url ...] [--script "..."] [--script-file 文件]`
- 图标光栅化：`node tools/make-icons.mjs`

## 前端功能点（避免重复实现）
- **打开方式：点卡片默认「新窗口」**（用户 2026-09-19 要求）。页内预览降级为卡片右上角的
  眼睛按钮（`[data-preview]` → `openPreview`）；预览浮层顶栏的「新窗口」按钮复用同一函数。
  实现要点：`openInNewWindow` 里 **`window.open` 必须同步发** —— 先开空白占位窗 + 写入载入页，
  正文拿到后再 `win.location.replace(blobUrl)`；先 `await` 再 `open` 会被弹窗拦截器拦掉。
  自检里「打开方式：卡片默认新窗口」一组守着这条，含「必须同步开窗」的断言。
- 收藏：工具条首个 chip（`data-fav`）切换只看收藏；状态存 DB `documents.starred`；
  深链 `#fav`；预览页顶栏也有收藏按钮；卡片 `is-starred` 有琥珀色顶条
- 筛选都是前端本地过滤（一次拉最多 500 条列表，不带 `content`）
- 顶栏另有：接口说明弹窗（`#api-modal` / `renderApiDoc`）、留言板（`#msg-modal` / `openMsgBoard`）
- 留言不参与标签与筛选体系，是独立的一张表、独立的一个弹窗
