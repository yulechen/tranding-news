#!/usr/bin/env node
'use strict'

/**
 * 云端信息库 · 本地自检
 *
 * 用法： node tools/selfcheck.mjs [--base http://127.0.0.1:3000]
 * 覆盖：静态资源、顶栏入口（未读过滤 / 收藏 / 接口说明）、健康检查、
 *       收件箱增删查、鉴权与路径穿越防护。
 * 其中「标签功能已取消」一项会读本地 tools/push.mjs，用来守住「推送不写标签」这条规则；
 * 「开放接口」一组只在非 localhost 的地址上执行（/.cloud 路径由平台网关照管）。
 */

import fs from 'node:fs'

const BASE = (process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://127.0.0.1:3000').replace(/\/+$/, '')
const KEY = process.env.INGEST_KEY || 'iv_ing_7f3a9c2e5b8d4160a1f6e9c4b7d20385'

let pass = 0
let fail = 0

async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败')
}

async function waitForServer(attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch (_) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function main() {
  console.log(`\n云端信息库 · 自检 @ ${BASE}\n`)

  const alive = await waitForServer()
  if (!alive) {
    console.error('服务未响应，请先运行： node server.js')
    process.exitCode = 1
    return
  }

  console.log('静态资源')
  const files = [
    ['/', 'text/html'],
    ['/index.html', 'text/html'],
    ['/styles.css', 'text/css'],
    ['/app.js', 'text/javascript'],
    ['/config.js', 'text/javascript'],
    ['/vendor/workbuddy-cloud-sdk.js', 'text/javascript'],
    ['/favicon.svg', 'image/svg+xml']
  ]
  for (const [p, type] of files) {
    await check(`GET ${p}`, async () => {
      const res = await fetch(BASE + p)
      assert(res.ok, `HTTP ${res.status}`)
      const ct = res.headers.get('content-type') || ''
      assert(ct.includes(type), `content-type 应为 ${type}，实际 ${ct}`)
      const body = await res.text()
      assert(body.length > 100, '响应内容过短')
    })
  }

  await check('首页包含 SDK 全局名', async () => {
    const html = await (await fetch(`${BASE}/`)).text()
    assert(html.includes('app.js'), '未引入 app.js')
    const sdk = await (await fetch(`${BASE}/vendor/workbuddy-cloud-sdk.js`)).text()
    assert(sdk.includes('WorkBuddyCloud'), 'SDK 全局名缺失')
  })

  await check('图标引用正确', async () => {
    const html = await (await fetch(`${BASE}/`)).text()
    assert(html.includes('rel="icon"'), '未声明 favicon')
    assert(html.includes('favicon.svg'), 'favicon 未指向 favicon.svg')
    const icon = await (await fetch(`${BASE}/favicon.svg`)).text()
    assert(icon.includes('<svg'), 'favicon 不是 SVG')
    assert(icon.includes('linearGradient'), 'favicon 缺少品牌渐变')
  })

  await check('收藏入口已就位', async () => {
    const html = await (await fetch(`${BASE}/`)).text()
    // 顶栏没有品牌了（2026-09-21），只剩居中按钮组：收藏开关紧跟「接口」左边
    const topbar = html.slice(html.indexOf('<header class="topbar"'), html.indexOf('</header>'))
    assert(html.includes('id="preview-close"'), '预览页缺少退出入口（悬浮关闭钮）')
    assert(topbar.includes('id="btn-fav"'), '顶栏缺少收藏筛选按钮')
    assert(/id="btn-fav"[^>]*aria-pressed/.test(topbar), '收藏按钮缺少 aria-pressed 状态')
    assert(topbar.indexOf('id="btn-fav"') < topbar.indexOf('id="btn-api"'), '收藏开关没放在「接口」左边')
    // 收藏开关只留图标，不能有汉字
    const favBtn = topbar.slice(topbar.indexOf('id="btn-fav"'))
    const favTag = favBtn.slice(0, favBtn.indexOf('</button>'))
    assert(!favTag.includes('<span'), '顶栏收藏按钮里还带着文字')
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('view.starred'), '缺少收藏筛选状态')
    assert(js.includes('writeHash'), '缺少收藏深链写入')
    assert(js.includes('syncFavBtn'), '缺少收藏按钮状态同步')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(css.includes('.fav-btn'), '缺少顶栏收藏按钮样式')
    assert(css.includes('.card.is-starred'), '缺少已收藏卡片样式')
  })

  await check('顶栏无品牌标识、图标整体居中', async () => {
    // 2026-09-21 用户要求：去掉顶栏的网站标识（云朵图标 + 站名），整条只留一排图标按钮并居中。
    // 这条是反向断言：品牌不许再长回来。
    const html = await (await fetch(`${BASE}/`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    const topbar = html.slice(html.indexOf('<header class="topbar"'), html.indexOf('</header>'))
    assert(!topbar.includes('brand'), '顶栏又长回了品牌标识')
    assert(!css.includes('.brand'), '样式里仍留着品牌标识的规则')
    assert(!/<h1|<img/i.test(topbar), '顶栏又挂回了网站标识')
    // 居中：顶栏唯一的在流子元素是按钮组，靠 .topbar 的 justify-content 居中
    assert(/\.topbar \{[^}]*justify-content: center/.test(css), '顶栏图标没有水平居中')
    assert(!/\.topbar-actions \{[^}]*margin-left: auto/.test(css), '顶栏按钮组又被推到右边了')
    assert(topbar.includes('class="topbar-actions"'), '顶栏按钮组丢了')
    assert(css.includes('.topbar-actions'), '缺少顶栏按钮组样式')
  })

  await check('顶栏不显示条数（只留读屏播报）', async () => {
    // 用户 2026-09-19 要求取消顶栏那个数字；条数只播报给读屏，视觉上不出现
    const html = await (await fetch(`${BASE}/`)).text()
    const topbar = html.slice(html.indexOf('<header class="topbar"'), html.indexOf('</header>'))
    assert(topbar.includes('id="stat-text"'), '条数播报节点丢了（读屏会听不到列表条数）')
    assert(!/class="stat"/.test(topbar), '顶栏又出现了可见的统计数字')
    assert(!html.includes('topbar-status'), '顶栏又挂回了统计容器')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(!/^\.stat \{/m.test(css), '样式里仍留着顶栏统计数字的样式')
    assert(!css.includes('.topbar-status'), '样式里仍留着顶栏统计容器')
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('renderStat'), '缺少条数播报逻辑')
    assert(!/<span aria-hidden="true">\$\{shown\}<\/span>/.test(js), '顶栏统计又渲染回了可见数字')
  })

  await check('顶栏未读过滤', async () => {
    // 2026-09-21 用户要求：顶栏加一个「只看未读」，跟收藏开关同一套语言
    const html = await (await fetch(`${BASE}/`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    const topbar = html.slice(html.indexOf('<header class="topbar"'), html.indexOf('</header>'))
    assert(topbar.includes('id="btn-unread"'), '顶栏缺少未读过滤开关')
    assert(/id="btn-unread"[^>]*aria-pressed/.test(topbar), '未读开关缺少 aria-pressed 状态')
    assert(topbar.indexOf('id="btn-unread"') < topbar.indexOf('id="btn-fav"'), '未读开关没排在收藏开关前面')
    assert(topbar.indexOf('id="btn-fav"') < topbar.indexOf('id="btn-api"'), '两个开关没放在「接口」左边')
    // 只留图标，不许有文字
    const btn = topbar.slice(topbar.indexOf('id="btn-unread"'))
    assert(!btn.slice(0, btn.indexOf('</button>')).includes('<span'), '未读开关里带着文字')
    assert(js.includes('syncUnreadBtn'), '缺少未读开关的状态同步')
    assert(/view\.unread/.test(js), '缺少未读筛选状态')
    assert(js.includes('!isRead(d.id)'), '未读筛选没有按已读记录反着筛')
    assert(css.includes('.unread-btn'), '缺少未读开关样式')
    assert(/\.fav-btn, \.unread-btn \{/.test(css), '未读开关没跟收藏开关共用同一套骨架')
  })

  await check('已读状态：打开即已读，已读卡片变灰', async () => {
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    // 只记在本机（站点公开、无登录，区分不了「谁读的」）
    assert(/READ_KEY = 'iv_read'/.test(js), '缺少已读状态的本地存储键')
    assert(js.includes('localStorage.setItem(READ_KEY'), '已读状态没有落到本机')
    assert(js.includes('function markRead'), '缺少标记已读的实现')
    assert(/const isRead = \(id\) =>/.test(js), '缺少已读判断')
    // 卡片要带上已读标记
    assert(/isRead\(d\.id\) \? ' is-read'/.test(js), '卡片渲染没用上已读状态')
    // 两条打开路径（新窗口 / 页内预览）都必须标记已读
    const newWin = js.slice(js.indexOf('async function openInNewWindow'))
    assert(/markRead\(doc\.id\)/.test(newWin.slice(0, 500)), '新窗口打开时没标记已读')
    const preview = js.slice(js.indexOf('async function openPreview'))
    assert(/markRead\(doc\.id\)/.test(preview.slice(0, 400)), '页内预览时没标记已读')
    // 已读只压视觉，不能把卡片藏起来或者禁用掉
    assert(css.includes('.card.is-read'), '缺少已读卡片的样式')
    assert(/\.card\.is-read \.card-title \{ color: var\(--ink-3\)/.test(css), '已读卡片标题没压灰（或用了对比度不够的色阶）')
  })

  await check('分类只有 报告 / 自选 / 计划，可逐条编辑', async () => {
    // 2026-09-20 用户定的：分类收敛成三类，并在列表上方给一个逐条改分类的入口
    const html = await (await fetch(`${BASE}/`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()

    // ① 分类就三类，旧的那套（看板 / 工具 / 页面 / 其他）不能再露头
    const types = js.slice(js.indexOf('const TYPES = ['), js.indexOf('const TYPE_LABEL'))
    assert(/'report'/.test(types) && /'watchlist'/.test(types) && /'plan'/.test(types), '三类分类没齐（报告 / 自选 / 计划）')
    assert(!/'dashboard'|'tool'|'page'|'other'/.test(types), '旧分类（看板 / 工具 / 页面 / 其他）还在')
    assert(js.includes("const DEFAULT_TYPE = 'report'"), '缺省分类不是「报告」')

    // ② 入口在卡片列表上方：工具栏里、紧跟着筛选控件
    const barStart = html.indexOf('<section class="toolbar"')
    const toolbar = html.slice(barStart, html.indexOf('</section>', barStart))
    assert(toolbar.includes('id="btn-cat"'), '工具栏里没有分类编辑入口')
    assert(toolbar.indexOf('id="type-chips"') < toolbar.indexOf('id="btn-cat"'), '分类编辑入口没跟在筛选控件后面')

    // ③ 弹窗里逐条改，改动写回 doc_type
    assert(html.includes('id="cat-modal"') && html.includes('id="cat-list"'), '缺少分类编辑弹窗')
    assert(js.includes('function renderCatList') && js.includes('function setDocType'), '缺少分类编辑的实现')
    assert(/update\(\{ doc_type: type/.test(js), '改了分类却没写回 doc_type')

    // ④ 「编辑信息」弹窗里的下拉也得只剩三项
    const selStart = html.indexOf('id="edit-type"')
    const sel = html.slice(selStart, html.indexOf('</select>', selStart))
    assert(sel.includes('value="watchlist"') && sel.includes('value="plan"'), '编辑信息弹窗里的分类没更新')
    assert(!/value="(dashboard|tool|page|other)"/.test(sel), '编辑信息弹窗里还留着旧分类')

    assert(css.includes('.cat-btn'), '缺少分类编辑入口的样式')
    assert(css.includes('.cat-opt'), '缺少分类按钮样式')
  })

  await check('标签功能已取消', async () => {
    // 2026-09-21 用户要求：标签整个下线 —— 卡片入口、筛选行、编辑弹窗、编辑信息里的字段都不再有
    const html = await (await fetch(`${BASE}/`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(!html.includes('tag-modal'), '标签编辑弹窗又回来了')
    assert(!html.includes('tag-row'), '标签筛选行又回来了')
    assert(!html.includes('edit-tags'), '「编辑信息」里又出现标签字段')
    assert(!js.includes('openTagEditor'), '标签编辑逻辑没删干净')
    assert(!js.includes('data-tagedit'), '卡片上又出现标签按钮')
    assert(!js.includes('data-tag='), '顶部又出现按标签过滤的按钮')
    assert(!/view\.tag/.test(js), '筛选状态里又留着标签')
    assert(!/\.tag-/.test(css), '样式里仍留着标签相关规则')
    // 数据库那一列还在，但页面与推送都不再往里写标签内容
    const push = fs.readFileSync(new URL('../tools/push.mjs', import.meta.url), 'utf8')
    assert(/tags:\s*\[\]/.test(push), 'push.mjs 又往库里写标签了')
    assert(!/payload\.tags\.slice/.test(push), 'push.mjs 仍在透传标签')
  })

  await check('页面不含上传入口与搜索', async () => {
    // 内容只从 WorkBuddy 推过来；查找全靠标签，所以页面不该再留这两样
    const html = await (await fetch(`${BASE}/`)).text()
    assert(!html.includes('id="btn-upload"'), '仍存在「添加内容」按钮')
    assert(!html.includes('upload-modal'), '仍存在上传弹窗')
    assert(!html.includes('id="search"'), '仍存在搜索框')
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(!js.includes('btn-upload'), 'app.js 仍在绑定上传按钮')
    assert(!js.includes('el.search'), 'app.js 仍在读取搜索框')
  })

  await check('固定最新优先，无排序控件', async () => {
    // 排序只保留一种：按时间倒序（最新优先）。工具栏不再提供切换入口。
    const html = await (await fetch(`${BASE}/`)).text()
    assert(!html.includes('id="sort"'), '仍存在排序下拉')
    assert(!html.includes('select-wrap'), '仍存在排序下拉外壳')
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(!js.includes('view.sort'), 'app.js 仍保留排序状态')
    assert(!js.includes("sort: 'new'"), 'app.js 状态里仍留着排序字段')
    assert(js.includes('byDate(b) - byDate(a)'), 'app.js 未按最新优先排序')
    // 收藏不参与排序：点收藏不会让卡片跳位，收藏视角里也是时间序
    assert(!js.includes('星标置顶'), 'app.js 仍在把收藏置顶')
    assert(!/Number\(!!b\.starred\) - Number\(!!a\.starred\)/.test(js), '收藏仍在参与排序')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(!css.includes('.select-wrap'), '样式里仍留着排序下拉样式')
  })

  await check('卡片操作收在卡片顶部', async () => {
    // 收藏 / 标签 / 删除 三个入口长在卡片自己身上；页内预览改成 Shift + 点击卡片（不再挂眼睛图标）
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('class="card-actions"'), '卡片缺少顶部操作区')
    assert(!js.includes('data-preview'), '卡片上又出现了页内预览（眼睛）按钮')
    assert(!js.includes('pv-btn'), '页内预览按钮的代码没清干净')
    assert(js.includes('e.shiftKey') && js.includes('openPreview(doc)'), '页内预览没有保留 Shift + 点击入口')
    // 卡片顶部左侧显示推送时间（除标题外卡片上唯一的文字）
    assert(js.includes('class="card-time"'), '卡片缺少推送时间')
    assert(/card-time[\s\S]{0,200}fmtTime\(/.test(js), '卡片时间没有用统一的时间格式化')
    assert(js.includes('data-star='), '卡片缺少收藏按钮')
    assert(js.includes('data-del='), '卡片缺少删除按钮')
    assert(js.includes('async function deleteDoc'), '缺少共用的删除实现')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(css.includes('.card-time'), '缺少卡片时间的样式')
    assert(!css.includes('.pv-btn'), '样式里仍留着页内预览按钮')
    assert(css.includes('.del-btn'), '缺少删除按钮样式')
    assert(/\.del-btn::after/.test(css), '删除按钮没有撑出触摸热区')
  })

  await check('界面保持精简（顶栏 / 卡片）', async () => {
    // 用户 2026-09-19 定的调子：能省的装饰都省掉，只留内容和操作
    const html = await (await fetch(`${BASE}/`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()

    // ① 顶栏不挂「公开可看」徽标
    assert(!html.includes('pub-badge'), '顶栏又出现了「公开可看」徽标')
    assert(!css.includes('.pub-badge'), '样式里仍留着「公开可看」徽标')

    // ② 卡片边框一律一样，不按内容类型上色
    assert(!/\.card\[data-type=/.test(css), '卡片仍在按类型上色')
    assert(!css.includes('.card::before'), '卡片左侧那条类型色条又回来了')

    // ③ 卡片只留「推送时间 + 标题」：类型徽标 / 摘要 / 标签 / 页脚都不再渲染
    assert(!js.includes('type-badge'), '卡片又渲染了类型徽标')
    assert(!js.includes('card-summary'), '卡片又渲染了摘要')
    assert(!js.includes('card-tags'), '卡片又渲染了标签')
    assert(!js.includes('card-foot'), '卡片又渲染了时间 / 大小 / 来源那一条页脚')
    assert(/class="card-title"/.test(js), '卡片标题丢了')
    assert(css.includes('.card-title'), '缺少卡片标题样式')

    // ④ 标签相关的东西已整体下线（见「标签功能已取消」一项）
    assert(!js.includes('tag-row-label'), '标签行又出现了「标签」字样')
    assert(!css.includes('.tag-row-label'), '样式里仍留着标签行文字样式')
  })

  await check('无障碍与键盘可用', async () => {
    // 生产底线：键盘能走完全流程、弹窗焦点不逃逸、读屏能听到反馈
    const html = await (await fetch(`${BASE}/`)).text()
    assert(html.includes('class="skip-link"'), '缺少跳到主内容的跳转链接')
    assert(html.includes('aria-modal="true"'), '弹窗未声明 aria-modal')
    assert(html.includes('role="dialog"'), '弹窗缺少 dialog 角色')
    assert(html.includes('aria-live'), '缺少 live region（toast / 状态提示）')
    assert(html.includes('aria-busy'), '列表未声明加载中状态')
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('trapFocus'), '弹窗未做 Tab 焦点陷阱')
    assert(js.includes('aria-pressed'), '筛选 / 收藏状态未暴露给辅助技术')
    assert(js.includes('card-link'), '卡片缺少可聚焦的打开入口')
    assert(!js.includes('window.confirm'), '仍在用原生 confirm')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(css.includes(':focus-visible'), '缺少键盘焦点样式')
    assert(css.includes('prefers-reduced-motion'), '未尊重系统的减弱动态效果')
  })

  await check('打开方式：卡片默认在当前页打开', async () => {
    const js = await (await fetch(`${BASE}/app.js`)).text()
    // 用户 2026-09-20：点卡片默认在当前页的预览浮层里打开，不再默认新开标签页
    const at = js.indexOf("el.grid.addEventListener('click'")
    assert(at > 0, '找不到卡片点击处理')
    const cardClick = js.slice(at, at + 2600)
    assert(cardClick.includes('openPreview(doc)'), '点击卡片默认没有在当前页打开')
    assert(/if \(e\.shiftKey\) \{ openInNewWindow\(doc\); return \}/.test(cardClick), 'Shift + 点击没有走新窗口')

    // 新窗口这条路仍然留着（Shift + 点击 / Shift + 回车），
    // 且必须**同步**开窗，否则 await 拉正文之后 window.open 会被弹窗拦截器拦掉
    assert(js.includes('openInNewWindow'), '「新窗口打开」的实现被删了')
    assert(js.includes(`window.open('', '_blank')`), '新窗口不是同步开的，会被浏览器当弹窗拦掉')

    // 键盘两种按法要和鼠标对齐
    const kat = js.indexOf("el.grid.addEventListener('keydown'")
    assert(kat > 0, '找不到卡片的键盘处理')
    const cardKey = js.slice(kat, kat + 1200)
    assert(cardKey.includes('if (e.shiftKey) openInNewWindow(doc)'), 'Shift + 回车没有走新窗口')
    assert(/else openPreview\(doc\)/.test(cardKey), '回车默认没有在当前页打开')

    // 卡片链接的提示文案要跟默认行为一致，别还说「新窗口打开」
    assert(js.includes('在当前页面打开'), '卡片链接的提示文案没跟着改')

    // 预览页刻意不做顶栏（2026-09-20 用户要求）：内容是主角，页面铺满。
    // 退出只认悬浮关闭钮 + Esc，别把「返回 / 收藏 / 标签 / 新窗口 / 下载 / 编辑信息 / 删除」那一排加回来
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    const html = await (await fetch(`${BASE}/`)).text()
    assert(!html.includes('preview-bar'), '预览页又长出了顶栏')
    assert(!html.includes('preview-back'), '预览页又长出了「返回」按钮')
    assert(html.includes('id="preview-close"'), '预览页缺少悬浮关闭钮')
    assert(!css.includes('.preview-bar'), '样式里仍留着预览顶栏')
    assert(!css.includes('.preview-actions'), '样式里仍留着预览顶栏的操作区')
    assert(/\.preview-close \{[^}]*position: absolute/.test(css), '关闭钮没有脱离文档流（会挤压预览区域）')
    // 关闭钮在页面底部正中（2026-09-21 用户要求；演变：右上角 → 顶部正中 → 底部正中）
    assert(/\.preview-close \{[^}]*left: 50%/.test(css), '关闭钮没在页面底部中间')
    assert(/\.preview-close \{[^}]*bottom: var\(--sp-[23]\)/.test(css), '关闭钮没落在页面底部')
    assert(!/\.preview-close \{[^}]*top: /.test(css), '关闭钮又回到顶部了')
    assert(!/\.preview-close \{[^}]*right: /.test(css), '关闭钮又贴回右上角了')
    // 只留一个「×」（2026-09-21 用户要求）：去掉圆形底盘 —— 无描边 / 圆底 / 阴影
    assert(!/\.preview-close \{[^}]*border-radius/.test(css), '关闭钮又长出圆形底盘了')
    assert(/\.preview-close \{[^}]*border: 0/.test(css), '关闭钮又带上描边了')
    assert(/\.preview-close \{[^}]*background: none/.test(css), '关闭钮又加回底色了')
  })

  await check('接口说明用真实端点，不写死', async () => {
    const html = await (await fetch(`${BASE}/`)).text()
    assert(html.includes('id="api-modal"'), '缺少接口说明弹窗')
    assert(html.includes('id="api-body"'), '接口说明缺少内容容器')
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('openApiDoc'), '缺少接口说明逻辑')
    assert(js.includes("'/.cloud/database/rest'"), '未从配置拼出 REST 端点')
    // 文档里的端点必须由 CFG.endpoint 推导，不能写死某个域名
    const a = js.indexOf('function renderApiDoc')
    const b = js.indexOf('async function copyApiUrl')
    assert(a > 0 && b > a, '找不到 renderApiDoc 片段')
    const doc = js.slice(a, b)
    assert(!/https?:\/\//.test(doc), '接口说明里写死了域名，应由配置推导')
    assert(doc.includes('x-wb-webapp-access-key'), '接口说明缺少鉴权头')
    assert(doc.includes('title') && doc.includes('content'), '接口说明缺少字段清单')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(css.includes('.api-code'), '缺少接口说明的代码块样式')
  })

  await check('留言功能已移除', async () => {
    // 2026-09-21 用户要求：留言板整体下线（顶栏入口、弹窗、逻辑、样式都不再出现）
    const html = await (await fetch(`${BASE}/`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(!html.includes('msg-modal'), '留言弹窗又回来了')
    assert(!html.includes('btn-msg'), '顶栏又出现留言入口')
    assert(!html.includes('msg-badge'), '顶栏又出现留言角标')
    assert(!js.includes('openMsgBoard'), '留言板逻辑没删干净')
    assert(!js.includes("from('messages')"), 'app.js 仍在读写留言表')
    assert(!/\.msg-/.test(css), '样式里仍留着留言相关规则')
  })

  console.log('\n健康检查')
  await check('GET /api/health', async () => {
    const res = await fetch(`${BASE}/api/health`)
    const data = await res.json()
    assert(res.ok && data.ok === true, '健康检查未通过')
  })

  console.log('\n收件箱')
  let createdId = null

  await check('无密钥写入被拒绝 (401)', async () => {
    const res = await fetch(`${BASE}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', html: '<h1>x</h1>' })
    })
    assert(res.status === 401, `期望 401，实际 ${res.status}`)
  })

  await check('错误密钥写入被拒绝 (401)', async () => {
    const res = await fetch(`${BASE}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-key': 'wrong-key' },
      body: JSON.stringify({ title: 'x', html: '<h1>x</h1>' })
    })
    assert(res.status === 401, `期望 401，实际 ${res.status}`)
  })

  await check('正确密钥写入成功', async () => {
    const res = await fetch(`${BASE}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-key': KEY },
      body: JSON.stringify({
        title: '自检内容',
        summary: '来自 selfcheck',
        tags: ['自检', 'test'],
        docType: 'report',
        html: '<!DOCTYPE html><html><head><title>t</title></head><body><h1>hello</h1></body></html>'
      })
    })
    const data = await res.json()
    assert(res.ok && data.ok, data.error || '写入失败')
    assert(typeof data.id === 'string' && data.id.length > 8, 'id 异常')
    createdId = data.id
  })

  await check('列表能读到该条目且不含正文', async () => {
    const res = await fetch(`${BASE}/api/inbox`, { headers: { 'x-ingest-key': KEY } })
    const data = await res.json()
    assert(data.ok, '列表失败')
    const hit = data.items.find((i) => i.id === createdId)
    assert(hit, '未找到刚写入的条目')
    assert(hit.title === '自检内容', '标题不符')
    assert(Array.isArray(hit.tags) && hit.tags.includes('自检'), '标签不符')
    assert(!('html' in hit), '列表不应包含正文')
  })

  await check('按 id 读取正文', async () => {
    const res = await fetch(`${BASE}/api/inbox/${createdId}`, { headers: { 'x-ingest-key': KEY } })
    const data = await res.json()
    assert(data.ok && data.html.includes('<h1>hello</h1>'), '正文读取失败')
    assert(data.meta.title === '自检内容', '元数据不符')
  })

  await check('空内容被拒绝 (400)', async () => {
    const res = await fetch(`${BASE}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-key': KEY },
      body: JSON.stringify({ title: '空', html: '   ' })
    })
    assert(res.status === 400, `期望 400，实际 ${res.status}`)
  })

  await check('删除条目', async () => {
    const res = await fetch(`${BASE}/api/inbox/${createdId}`, {
      method: 'DELETE',
      headers: { 'x-ingest-key': KEY }
    })
    const data = await res.json()
    assert(res.ok && data.ok, data.error || '删除失败')
  })

  await check('删除后读不到', async () => {
    const res = await fetch(`${BASE}/api/inbox/${createdId}`, { headers: { 'x-ingest-key': KEY } })
    assert(res.status === 404, `期望 404，实际 ${res.status}`)
  })

  console.log('\n开放接口')
  const configJs = await (await fetch(`${BASE}/config.js`)).text()
  const pk = (configJs.match(/publishableKey:\s*'([^']+)'/) || [])[1]
  if (/127\.0\.0\.1|localhost/.test(BASE)) {
    console.log('  – 跳过：/.cloud 由平台网关照管，本地服务没有这个路径（跑线上地址时会执行）')
  } else {
    await check('REST 端点可匿名读写 messages', async () => {
      assert(pk, 'config.js 里读不到 publishableKey')
      const H = { 'x-wb-webapp-access-key': pk, 'content-type': 'application/json' }
      const url = `${BASE}/.cloud/database/rest/messages`
      const ins = await fetch(url, {
        method: 'POST',
        headers: { ...H, Prefer: 'return=representation' },
        body: JSON.stringify({ author: '自检', body: 'selfcheck probe' })
      })
      assert(ins.status === 201, `写入期望 201，实际 ${ins.status}`)
      const row = (await ins.json())[0]
      assert(row && row.id, '写入未返回新行')
      const del = await fetch(`${url}?id=eq.${row.id}`, { method: 'DELETE', headers: H })
      assert(del.status === 204, `删除期望 204，实际 ${del.status}`)
      const back = await fetch(`${url}?select=id&id=eq.${row.id}`, { headers: H })
      assert((await back.json()).length === 0, '删除后仍能读到，清理不干净')
    })

    await check('REST 无密钥访问被拒绝 (401)', async () => {
      const res = await fetch(`${BASE}/.cloud/database/rest/messages?select=id&limit=1`)
      assert(res.status === 401, `期望 401，实际 ${res.status}`)
    })
  }

  console.log('\n安全')
  await check('路径穿越被挡住', async () => {
    for (const p of [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e/server.js',
      '/vendor/../../server.js'
    ]) {
      const res = await fetch(BASE + p)
      assert(!res.ok || !(await res.text()).includes('INGEST_KEY'), `路径 ${p} 泄露了源码`)
    }
  })

  await check('未知路径返回 404', async () => {
    const res = await fetch(`${BASE}/definitely-not-here.html`)
    assert(res.status === 404, `期望 404，实际 ${res.status}`)
  })

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n自检异常：', err && err.message ? err.message : err)
  process.exitCode = 1
})
