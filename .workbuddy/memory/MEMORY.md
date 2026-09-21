# 云端信息库 · 项目长期记忆（tranding-news）

> 过程细节见同目录按日日志（2026-09-19 / 20 / 21.md）。这里只留**还会用到的口径与坑**。

## 标识 / 发布
- 云应用 appId `wbapp_nYUBg7YCbzNbEX9V2pDJ4d` **必须复用**（换 id → 域名变 + 云登录 Origin 校验失败）
- 发布传参：`domainPrefix:"info-vault"` + `userAskedToPublish:true`（**仅当轮明确说「上线」才加，不跨轮继承**）
  + `updateExistingApp:true`（复用同一 app 不改显示名）→ 线上 `https://info-vault.app.workbuddy.host`
- 🖼 **UI 改动默认先本地给用户看，是否上线听用户那句话**（用户会逐条看到位）
- ⚠️ 站点前置腾讯云 WAF：入库内容含 `<script>` / `on*=` 事件属性 / `eval(` 字样 → **整体 403**（返回体是拦截页
  HTML 不是 JSON，`push.mjs` 会打一大段乱码）。`../` 相对路径、126 KB 纯中文正文都放行 —— 不是体积问题。
  带交互的页面只能推「去掉 `<script>` 与 `on*=` 的静态降级版」；🚫 不做变形伪装绕 WAF

## 仓库
- `github.com/yulechen/tranding-news`（PUBLIC，main / origin）；身份只配 repo 局部，`core.autocrlf=false`
- 🚫 `.gitignore` 临时文件规则写 `.tmp-*`（写成 `.tmp-*/` 只匹配目录，临时文件会被 `git add -A` 提交）；
  验规则用 `git check-ignore -v --no-index <path>`
- ⚠️ 沙箱下 `git fetch` 写不进 `refs/remotes/origin/main`（打印 `[new branch]` 却没落盘，`status -sb` 显 `[gone]`）
  —— **不是远端问题，远端状态一律以 `git ls-remote` / `gh api` 为准**
- 排除项：`design/preview/*.png`（可重生成）、`inbox/*`（只留 `.gitkeep`）、`.tmp-*`、`node_modules/`

## 架构
- 纯静态前端无构建（`public/` index.html + app.js + styles.css）；云 SDK 自托管 `public/vendor/`（不用 CDN）
- `server.js` 零依赖：静态托管 + `/api/inbox`；应用自己的健康检查是 `/api/health`（`/healthz` 被平台网关占）
- **站点公开无需登录**：`documents` 四条 RLS 全放开、`owner_id` 可空；正文 HTML 直存 `documents.content`
  （🚫 不用云 Storage —— 必须登录才能读，与公开诉求冲突）；列表查询不带 content，预览按 id 单拉
- 预览把 `content` 塞 iframe `srcdoc`（sandbox 不含 `allow-same-origin`）
- 裸 REST `{endpoint}/.cloud/database/rest/<表>`；鉴权头 **`x-wb-webapp-access-key: <publishableKey>`**
  （不是 `apikey` 也不是 `Bearer`）；POST / PATCH 要 `Prefer: return=representation`；
  云错误码带前缀（`DATABASE_23514`），`friendly()` 用 `includes` 判断不用 `===`
- `INGEST_KEY` 4 处：`server.js` / `push.mjs` / `selfcheck.mjs` 的 env 兜底 + `app.js` 内联明文
  （内联在浏览器端 = 本来就公开，别当机密）
- `messages` 表还在（留言功能已下线），自检「开放接口」组拿它当裸 REST 鉴权探针 ——
  🚫 别改用 `documents`，那会往真实内容库写测试数据

## 前端口径（用户逐条定过，别自作主张回退）
### 底栏（原顶栏 → 底栏 → 2026-09-21 用户要求整条取消，控件搬进筛选条）
- 🚫 **底栏与顶栏都已不存在**：`bottombar` / `topbar` 的 DOM 与样式全删，命名一个都不许回潮
  （自检反向守着：`!html.includes('bottombar')` / `!css.includes('bottombar')` /
  `!css.includes('--bottombar')` / `!html.includes('topbar') && !css.includes('topbar')`）
- 原来底栏上四个入口的归宿：**未读** → 筛选条 `#btn-unread`；**收藏** → 先搬进筛选条、当天又被
  要求取消；**接口说明** `#btn-api` 与**刷新** `#btn-refresh` → 入口一并收掉，实现与接口文档都留着
  （`closeApiDoc` / `loadDocs` 还在），只是页面上没得点
- 去固定底栏时两处连带项也回退了：`.content` 底部 padding 回到
  `calc(var(--sp-5) + env(safe-area-inset-bottom, 0px))`、`.toast` 的 bottom 回到 `var(--sp-4)` 一档

### 筛选条（`section.toolbar`）
- 左边 = 分类分段控件 `.segmented`（可横滑）；`#stat-text` 是 `.visually-hidden`（🚫 不显示条数）；
  右边 `.tool-actions { margin-left: auto; flex: none }` 顶到另一头，里面**只剩两个图标按钮**：
  `#btn-unread`（只看未读，点亮蓝）在左、`#btn-cat`（逐条改分类）在右
- 两个按钮跟分类入口同一副骨架、同一档尺寸（走 `--tool-btn: 34px` / `--tool-ico`），
  只有图标不带文字，热区靠 `::after { inset: -5px }` 撑到 44px；🚫 别再写死 38 / 34px（自检反向守着）
- ⚠️ **整站没有任何收藏入口**了（2026-09-21：「取消卡片页上面的收藏」+「取消收藏过滤」）。
  演变链：底栏收藏按钮 → 搬进筛选条 `#btn-fav` → 取消。
  **保留面**（实现留着、只是没入口，别当死代码删）：`toggleStar()` 仍由 `actOnCurrent('star')` 调用、
  `documents.starred` 仍在 `LIST_FIELDS`、`.card.is-starred` 与 `--star*` token 都还在 ——
  要加回入口只是接线的事

### 卡片 / 筛选 / 已读
- 卡片只有「推送时间 + 标题」+ **一个删除图标** `data-del`（🚫 星标 / 眼睛 / 标签 / 类型色条
  都被用户要求删掉了，别自作主张加回来）；骨架屏只有 `.sk-icons` + `.sk-title`
- 筛选两者叠加：**分类 × 未读**；未读 = 不在本机 `localStorage.iv_read`（站点公开，「谁读的」无从区分）；
  深链只剩 `#unread`（`#fav` 已删 —— 老书签点开就是全部内容，不再进任何视角）；
  分面计数先叠未读开关再按分类数（**不等于**当前列表条数，故意如此）
- 打开即已读（`.is-read` 灰化：`--surface-2` 底 + `--ink-3` 标题；hover 恢复满对比度）；下载不算已读；
  别的标签页读过后靠 `storage` 事件同步
- 打开方式（2026-09-21 用户改口径）：**点卡片 → 换地址打开 `/doc/<id>`**（🚫 不再用页内浮层）；
  **Shift + 点击 → 新窗口开同一地址**。卡片是**真 `<a href>`**，中键 / 右键「复制链接地址」/ 回车
  全是原生行为 —— 点击处理里只记已读，**不许再 `preventDefault`**，也不需要 keydown（原生 Enter 会合成 click）
- 详情页由 **`server.js` 把 `/doc/<id>` 交给 `public/index.html`** 渲染，前端靠 `location.pathname`
  分流（`DOC_ROUTE` / `renderDocPage` / `leaveDoc` / `docUrl`）。
  ⚠️⚠️ 所以 **index.html 里的静态资源必须写绝对路径**（`/styles.css` `/app.js` …）——
  写成 `./styles.css` 在 `/doc/55` 下会解析成 `/doc/styles.css` 直接 404（自检反向守着）
- 详情页**没有任何横条、也没有任何退出控件**（2026-09-21 用户要求：顶栏 → 底栏 → 全去掉；
  关闭钮也走完 右上角圆钮 → 顶部正中 → 底部正中裸「×」→ **彻底删掉**）。
  iframe 铺满整屏、列表整块 `display:none`；退出只认 **Esc / 浏览器后退**：
  从列表点进来的 `history.back()`（筛选还在），直接打开地址的回 `/`（判据：`document.referrer` 同源）
- ⚠️⚠️ **详情页里 `iframe.srcdoc` 只准赋一次**（2026-09-21 修「返回要按两次」那个坑）：
  多赋一次就往浏览器**联合历史**里多记一条 → 历史成 `[列表, 详情, 详情]`，按一次返回只回到
  「同一条详情」，用户得按两次才回得到列表。实测 `history.length`：给已有 iframe 赋一次**不变**，
  连赋两次 `1 → 3`；而 `Page.frameNavigated` 里主框架其实只跳了一次（所以从导航事件看不出问题）。
  → 「正在载入」画在自己 DOM 上（`.preview.is-loading .preview-body::after`），正文与失败兜底
  都先在本地拼好、最后统一赋一次；自检守着「`srcdoc` 赋值次数 === 1 且发生在 `await fetchDoc` 之后」
- 🚫 已删：`openPreview()`（页内浮层）、`windowShell()`（blob 占位窗）、`#preview-close` 整个按钮
  （DOM + `el.previewClose` + 点击绑定 + 全部 `.preview-close` 样式）—— 别当"丢了"补回来
  - 替代的焦点落点：`#preview` 带 `tabindex="-1"`，脚本 `el.preview.focus()` 把焦点移进去，
    好让读屏念出「内容详情」；容器不可交互，所以 `#preview:focus { outline: none }` 关掉贴边蓝框
    （`[tabindex]:focus-visible` 的通用焦点环会画出来，必须显式压掉）
  - `actOnCurrent()` **故意没有 UI 入口但留着**（「下载」「编辑信息」「收藏」都只在这里实现，
    后两者连按钮都撤了），别当死代码删

### 分类
- 只有三类 `report` 报告 / `watchlist` 自选 / `plan` 计划（+ 分段控件的「全部」）；🚫 旧
  `dashboard/tool/page/other` 已停用；推送没给类型或值不在三类内 → 一律 `report`
  （逻辑收在 `typeOf(d)` + `DEFAULT_TYPE`，**别再散着写 `|| 'other'`**）；0 条也显示
- 逐条改分类：工具栏 `#btn-cat` → `#cat-modal`（`renderCatList` / `setDocType`），点一下即改即存
  （乐观更新 + 失败回滚）；改完要 `renderFilters() + renderDocs()`；`paintCatRow()` 只重画那一行

### 设计系统 / 无障碍
- 数值只在 `styles.css` 顶部 `:root` token（色彩 / 间距 4 的倍数 / 7 级字阶 / 6 级圆角 / 阴影 / 动效时长），
  规则里不写字面值；基调中性灰底 `#f4f5f7` + 顶部极淡白光，强调色只一种蓝 `--accent:#2563eb`（一屏最多两处）
- 🚫 `:focus-visible` 焦点环是无障碍底线别删；弹窗统一 `openModal/closeModal`（焦点还原 + 计数式滚动锁 +
  `trapFocus`）、二次确认统一 `confirmAction`（🚫 不用原生 `window.confirm`）
- 卡片打开用 stretched link（`.card-link` + 伪元素 `inset:0`），不是 `role=button`（卡内还有按钮，ARIA 违规）；
  `.card-actions` 需 `z-index:2`
- 🚫 页面**没有上传入口 / 搜索 / 排序控件**（内容只从 WorkBuddy 推），排序固定最新优先（收藏不参与排序）

## 踩坑
- ⚠️⚠️ **同一文件在同一轮连发多个 Edit 会互相覆盖**（按旧快照并行写，只有最后一个落盘，前面几个静默丢失）
  → 串行改，或写「带唯一命中断言」的一次性 node 脚本批量替换
- ⚠️⚠️ **自检必须排在截图之前**：宿主批量删除守卫按整轮累计，超阈值后所有子进程的删除都被拦，
  自检「删除条目 / 删除后读不到」两项**假红**（`err.code` 为 undefined）；`shot.mjs` 已改成复用系统临时配置
  目录（`--fresh` 才清）；真遇假红，线上跑一遍即可确认
- ⚠️ 本地起过服务就**一定看 `inbox/`**：自检留下的「自检内容」不清理，发布会带上线变成「待入库」
  （已踩过一次）。**发布前清空 `inbox/`（只留 `.gitkeep`）**
- ⚠️ 拍照脚本长了必须用 `--script-file`（否则被 shell 引号咬）；**`--w 360` 拍不出窄屏**
  （Chrome 无头窗口有 500px 下限，截图和 `innerWidth` 都是 500）→ 用 `--vw 360 --vh 700` 设备模拟；
  合成 `element.click()` 会让随后的 `focus()` 画出焦点环（真实鼠标用户看不到），拍照前 `blur()`；
  焦点环有无要读 `getComputedStyle`，不能只看截图；
  **脚本里让页面自己跳走**（点链接换地址）时 CDP 报的是「Inspected target navigated or closed」，
  `shot.mjs` 只重试「context was destroyed / Cannot find context」两种 → 已把这条也加进重试；
  重试会把同一段脚本在新页面上**重跑一遍**，所以探针要写成「两个页面都能跑、按 pathname 分流」
- ⚠️ **3300 端口被 trandingos_v3（股票自选）占着** —— 用户自己在跑，**别 kill**；Windows 允许同端口重复绑定，
  **先绑定的接走请求**（自己的服务照常打印「已启动」，抓到的是别人的页面）→ 起临时服务挑 3517 这类冷门端口，
  起完先 fetch 用特征词自证
- 本机 shell 无 coreutils 且时好时坏（`tail` / `grep` / `sleep` 说没就没）→ 脚本一律用 node 写，
  要等就用 `node -e "setTimeout(()=>{},1500)"`，输出整段打印
- ⚠️ 后台起的 `server.js` **可能在两次 Bash 调用之间被杀**（不稳定）→ 跑自检 / 截图时把
  「起服务 + 验证 + kill」写在**同一次** Bash 调用里，别跨调用指望它还活着

## 常用命令
- 起服务 `PORT=3517 node server.js`（默认 3000）
- 自检 `node tools/selfcheck.mjs [--base <url>]` —— **本地 36 项 / 线上 38 项**全绿
  （「开放接口」组只对非 localhost 执行，线上多 2 项）
- 推送（默认直接入库、不带标签）`node tools/push.mjs --file a.html --title … --summary … --type report`；`--inbox` 走暂存
- 截图 `node tools/shot.mjs --out x.png [--script-file f] [--vw/--vh]`｜图标 `node tools/make-icons.mjs`
- 改完 `content/云端信息库-使用说明.html` 记得同步回库（id=2，REST `PATCH {content}`，回读校验）
