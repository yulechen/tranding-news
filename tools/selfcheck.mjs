#!/usr/bin/env node
'use strict'

/**
 * 云端信息库 · 本地自检
 *
 * 用法： node tools/selfcheck.mjs [--base http://127.0.0.1:3000]
 * 覆盖：静态资源、筛选条入口（分类 / 未读）、健康检查、
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

// 筛选条片段：起于 <section class="toolbar">，止于它自己的收尾 ——
// 断言只在这段里找按钮，不会误抓到弹窗里同名的节点
function toolbarOf(html) {
  const start = html.indexOf('<section class="toolbar"')
  assert(start > -1, '页面缺少筛选条 .toolbar')
  const end = html.indexOf('</section>', start)
  assert(end > start, '筛选条片段没有正常收尾')
  return html.slice(start, end)
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

  await check('收藏过滤已取消（筛选条只剩未读 + 分类编辑）', async () => {
    // 2026-09-21 用户要求「取消收藏过滤」：筛选条上那颗星标开关整体下线。
    // 演变链：底栏的收藏按钮 → 搬进筛选条 → 取消。卡片上的星标更早就删掉了，
    // 所以整站现在没有任何收藏入口。
    // ⚠️ 底层还留着（toggleStar / actOnCurrent('star') / documents.starred 字段），
    //    跟「接口说明」「刷新」一样是「实现留着、没有入口」，别当死代码删。
    const html = await (await fetch(`${BASE}/`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(!html.includes('preview-close'), '详情页又长出了关闭钮')
    const tool = toolbarOf(html)
    assert(!tool.includes('id="btn-fav"'), '筛选条又长出了收藏开关')
    assert(!tool.includes('fav-btn'), '筛选条里还留着收藏按钮')
    assert(!css.includes('.fav-btn'), '样式里仍留着收藏开关')
    assert(!js.includes('syncFavBtn'), 'app.js 里仍留着收藏开关的状态同步')
    assert(!js.includes('view.starred'), 'app.js 里仍留着收藏筛选状态')
    assert(!js.includes('#fav'), '收藏深链 #fav 没清掉')
    // 卡片上也不许有星标（2026-09-21「取消卡片页上面的收藏」）
    assert(!js.includes('data-star='), '卡片上又出现了收藏星标')
    assert(!css.includes('.star-btn'), '样式里仍留着卡片星标')
  })


  await check('底栏已整条去掉', async () => {
    // 2026-09-21 用户要求「取消底栏功能」：原来固定在视口底部的那条横条整体下线 ——
    // 里面的「未读 / 收藏 / 接口 / 刷新」不再单独占一行；未读与收藏搬进筛选条，
    // 「接口说明」和「刷新」的入口一并收掉（实现留着，只是没有入口可点）。
    const html = await (await fetch(`${BASE}/`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(!html.includes('bottombar'), '页面里还有底栏的痕迹')
    assert(!css.includes('bottombar'), '样式里仍留着底栏的规则')
    assert(!css.includes('--bottombar'), '样式里仍留着底栏高度 token')
    assert(!html.includes('topbar') && !css.includes('topbar'), '还留着顶栏的旧命名')
    assert(!html.includes('id="btn-api"'), '底栏去掉后「接口」入口还留在页面上')
    assert(!html.includes('id="btn-refresh"'), '底栏去掉后「刷新」还留在页面上')
    // 内容底部仍要给 iPhone 安全区留白（底栏没了，这一条不能跟着没）
    assert(/\.content \{[^}]*padding:[^;]*env\(safe-area-inset-bottom/.test(css), '内容底部没留 iPhone 安全区')
  })


  await check('筛选条右侧：未读 · 分类编辑两个入口', async () => {
    // 2026-09-21 用户要求「底栏整条去掉」+「已读未读过滤放在编辑分类旁边」；
    // 之后「取消收藏过滤」，这一排只剩未读 + 分类编辑两个按钮。
    const html = await (await fetch(`${BASE}/`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const tool = toolbarOf(html)
    assert(tool.includes('class="tool-actions"'), '筛选条缺少右侧按钮组')
    const group = tool.slice(tool.indexOf('class="tool-actions"'))
    assert(group.includes('id="btn-unread"'), '筛选条缺少未读过滤开关')
    assert(/id="btn-unread"[^>]*aria-pressed/.test(group), '未读开关缺少 aria-pressed 状态')
    assert(group.includes('id="btn-cat"'), '筛选条缺少分类编辑入口')
    // 顺序：未读 → 分类编辑（未读过滤就贴在分类编辑旁边）
    assert(group.indexOf('id="btn-unread"') < group.indexOf('id="btn-cat"'), '未读开关没排在分类编辑前面')
    // 都只有图标，不许带文字
    const unreadBtn = group.slice(group.indexOf('id="btn-unread"'))
    assert(!unreadBtn.slice(0, unreadBtn.indexOf('</button>')).includes('<span'), '未读开关里带着文字')
    // 按钮组靠自动外边距顶到另一头，跟左边可横滑的分段控件各占一头
    assert(/\.tool-actions \{[^}]*margin-left: auto/.test(css), '按钮组没顶到筛选条右边')
    assert(/\.tool-actions \{[^}]*flex: none/.test(css), '按钮组没锁住宽度（会被分段控件压扁）')
    assert(!/\.cat-btn \{[^}]*margin-left: auto/.test(css), '分类入口还在自己往右顶（该由按钮组统一顶）')
    // 两个按钮同一副骨架、同一档尺寸，尺寸走 --tool-btn token
    assert(/--tool-btn: 34px/.test(css), '缺少筛选条按钮尺寸 token')
    assert(/\.unread-btn \{[^}]*width: var\(--tool-btn\)/.test(css), '未读开关没跟分类入口同一档尺寸')
    assert(/\.cat-btn \{[^}]*width: var\(--tool-btn\)/.test(css), '分类入口尺寸没走 token')
    assert(!/\.unread-btn \{[^}]*38px/.test(css), '开关又长回 38px 了')
    assert(js.includes('syncUnreadBtn'), '缺少未读开关的状态同步')
    assert(/view\.unread/.test(js), '缺少未读筛选状态')
    assert(js.includes('!isRead(d.id)'), '未读筛选没有按已读记录反着筛')
  })

  await check('条数只播报给读屏（视觉上没有数字）', async () => {
    // 用户 2026-09-19 要求取消那个数字；2026-09-21 底栏去掉后，播报节点搬进筛选条
    const html = await (await fetch(`${BASE}/`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const tool = toolbarOf(html)
    assert(tool.includes('id="stat-text"'), '条数播报节点丢了（读屏会听不到列表条数）')
    assert(/<span class="visually-hidden" id="stat-text"/.test(tool), '条数节点不再是无障碍隐藏的')
    assert(!/class="stat"/.test(tool), '筛选条里出现了可见的统计数字')
    assert(!/^\.stat \{/m.test(css), '样式里仍留着统计数字的样式')
    assert(!css.includes('.topbar-status'), '样式里仍留着统计容器')
    assert(js.includes('renderStat'), '缺少条数播报逻辑')
    assert(!/<span aria-hidden="true">\$\{shown\}<\/span>/.test(js), '统计又渲染回了可见数字')
  })

  await check('已读状态：云端保存，本地缓存兜底，已读卡片变灰', async () => {
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(/LIST_FIELDS = '[^']*tags/.test(js), '列表没有读取云端 tags')
    assert(js.includes("const READ_TAG = '__iv_read__'"), '缺少云端已读保留标记')
    assert(js.includes('.update({ tags })'), '打开内容没有更新云端已读标记')
    assert(js.includes('syncReadFromCloud'), '缺少云端已读状态同步')
    assert(/READ_KEY = 'iv_read'/.test(js), '缺少已读状态的本地缓存键')
    assert(js.includes('localStorage.setItem(READ_KEY'), '已读状态没有落到本地缓存')
    assert(js.includes('function markRead'), '缺少标记已读的实现')
    assert(/const isRead = \(id\) =>/.test(js), '缺少已读判断')
    // 卡片要带上已读标记
    assert(/isRead\(d\.id\) \? ' is-read'/.test(js), '卡片渲染没用上已读状态')
    // 三条打开路径（详情页 / 新窗口 / 卡片链接）都必须标记已读
    const docPage = js.slice(js.indexOf('async function renderDocPage'))
    assert(/markRead\(id\)/.test(docPage.slice(0, 1500)), '详情页打开时没标记已读')
    const newWin = js.slice(js.indexOf('function openInNewWindow'))
    assert(/markRead\(doc\.id\)/.test(newWin.slice(0, 400)), '新窗口打开时没标记已读')
    assert(/if \(link\) void markRead\(link\.dataset\.open\)/.test(js), '点卡片链接时没标记已读')
    // 已读只压视觉，不能把卡片藏起来或者禁用掉
    assert(css.includes('.card.is-read'), '缺少已读卡片的样式')
    assert(/\.card\.is-read \.card-title \{ color: var\(--ink-3\)/.test(css), '已读卡片标题没压灰（或用了对比度不够的色阶）')
    // ⚠️ 已读之后 hover / 聚焦不许再恢复白底：2026-09-21 报过的 bug ——
    // 点完卡片鼠标还停在上面（焦点也还留在链接上），卡片那一瞬又变回白底 + 投影，
    // 看起来就是「刚变成已读、又变回未读」。只允许换描边色当「可点」提示。
    const hoverRule = css.slice(css.indexOf('.card.is-read:hover'), css.indexOf('}', css.indexOf('.card.is-read:hover')))
    assert(/\.card\.is-read:hover,\s*\n\.card\.is-read:focus-within \{/.test(css), '已读卡片的 hover / 聚焦规则丢了')
    assert(!hoverRule.includes('background'), '已读卡片 hover 又变回白底（会被看成「又变未读」）')
    assert(!hoverRule.includes('box-shadow'), '已读卡片 hover 又加回投影了')
    assert(!/\.card\.is-read:hover \.card-title[\s\S]{0,80}color: var\(--ink\)/.test(css), '已读卡片 hover 标题又提回深色了')
  })


  await check('分类包含五类，可逐条编辑', async () => {
    // 分类在列表上方提供逐条修改入口
    const html = await (await fetch(`${BASE}/`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()

    // ① 分类包含五类，旧的那套（看板 / 工具 / 页面 / 其他）不能再露头
    const types = js.slice(js.indexOf('const TYPES = ['), js.indexOf('const TYPE_LABEL'))
    assert(/'report'/.test(types) && /'watchlist'/.test(types) && /'plan'/.test(types) && /'holdings'/.test(types) && /'deep'/.test(types), '五类分类没齐')
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

    // ④ 「编辑信息」弹窗里的下拉也得包含五项
    const selStart = html.indexOf('id="edit-type"')
    const sel = html.slice(selStart, html.indexOf('</select>', selStart))
    assert(sel.includes('value="watchlist"') && sel.includes('value="plan"') && sel.includes('value="holdings"') && sel.includes('value="deep"'), '编辑信息弹窗里的分类没更新')
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
    // 卡片自己身上只留「删除」；页内预览改成 Shift + 点击卡片（不再挂眼睛图标）
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('class="card-actions"'), '卡片缺少顶部操作区')
    assert(!js.includes('data-preview'), '卡片上又出现了页内预览（眼睛）按钮')
    assert(!js.includes('pv-btn'), '页内预览按钮的代码没清干净')
    assert(js.includes('class="card-link"'), '卡片缺少整卡链接')
    assert(!js.includes('openPreview'), '页内浮层的代码没清干净')
    // 卡片顶部左侧显示推送时间（除标题外卡片上唯一的文字）
    assert(js.includes('class="card-time"'), '卡片缺少推送时间')
    assert(/card-time[\s\S]{0,200}fmtTime\(/.test(js), '卡片时间没有用统一的时间格式化')
    // 2026-09-21 用户要求「取消卡片页上面的收藏」：卡片顶部只剩删除
    assert(!js.includes('data-star='), '卡片上又出现了收藏星标')
    assert(/card-actions[\s\S]{0,400}data-del=/.test(js), '删除按钮没在卡片顶部操作区')
    assert(js.includes('data-del='), '卡片缺少删除按钮')
    assert(js.includes('async function deleteDoc'), '缺少共用的删除实现')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(css.includes('.card-time'), '缺少卡片时间的样式')
    assert(!css.includes('.pv-btn'), '样式里仍留着页内预览按钮')
    assert(css.includes('.del-btn'), '缺少删除按钮样式')
    assert(/\.del-btn::after/.test(css), '删除按钮没有撑出触摸热区')
  })

  await check('界面保持精简（筛选条 / 卡片）', async () => {
    // 用户 2026-09-19 定的调子：能省的装饰都省掉，只留内容和操作
    const html = await (await fetch(`${BASE}/`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()

    // ① 不挂「公开可看」徽标
    assert(!html.includes('pub-badge'), '又出现了「公开可看」徽标')
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

  await check('打开方式：点卡片换地址打开（/doc/<id>）', async () => {
    // 2026-09-21 用户要求：点卡片「地址栏切换新的地址打开」，不再用页内浮层
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const html = await (await fetch(`${BASE}/`)).text()

    // 卡片链接就是真链接：普通点击换地址、Shift + 点击开新窗口、中键 / 右键「复制链接地址」
    // 全都天然可用 —— 所以点击处理里**不能**再拦默认跳转
    assert(js.includes('const docUrl = (id) =>'), '缺少详情页地址生成函数')
    assert(js.includes('href="${docUrl(d.id)}"'), '卡片链接不是 /doc/<id> 真地址')
    assert(!/card-link'\)\) e\.preventDefault/.test(js), '卡片点击又拦住了默认跳转')
    assert(!js.includes('openPreview('), '页内浮层的打开入口没删干净')
    assert(!js.includes("el.grid.addEventListener('keydown'"), '卡片键盘处理没删掉（原生 <a> 已够用）')

    // 键盘 / 读屏仍然能走通：整卡链接可聚焦，回车是原生行为
    assert(js.includes('class="card-link"'), '卡片缺少可聚焦的打开入口')

    // 新窗口这条路还在（Shift + 点击），并且同步开窗 —— 不能先 await 再 open
    assert(js.includes('function openInNewWindow'), '「新窗口打开」的实现被删了')
    assert(/window\.open\(docUrl\(doc\.id\), '_blank'\)/.test(js), '新窗口没有同步开真地址')
    assert(!js.includes('windowShell'), 'blob 占位页的旧实现没删干净')

    // 卡片链接的提示文案要跟新行为一致
    assert(js.includes('title="打开内容（按住 Shift 在新窗口打开）"'), '卡片链接的提示文案没跟着改')

    // 预览页刻意不做顶栏（2026-09-20 用户要求）：内容是主角，页面铺满。
    // 2026-09-21 用户要求：连那颗悬浮「×」也去掉 —— 这已经是地址栏里的真页面了，
    // 退出交给浏览器自带的后退 / Esc，页面上不该再有任何退出控件。
    // 演变：右上角圆钮 → 顶部正中 → 底部正中裸「×」→ 全部去掉，别再加回来。
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(!html.includes('preview-bar'), '预览页又长出了顶栏')
    assert(!html.includes('preview-back'), '预览页又长出了「返回」按钮')
    assert(!html.includes('preview-close'), '详情页又长出了关闭钮（这版不该有退出控件）')
    assert(!js.includes('previewClose'), '关闭钮的脚本没删干净')
    assert(!css.includes('preview-close'), '样式里仍留着关闭钮')
    assert(!css.includes('.preview-bar'), '样式里仍留着预览顶栏')
    assert(!css.includes('.preview-actions'), '样式里仍留着预览顶栏的操作区')
    // 焦点依旧有落点：脚本把焦点移进 #preview（tabindex="-1"），读屏能念出这个区域
    assert(/id="preview"[^>]*tabindex="-1"/.test(html), '详情页容器没留 tabindex（焦点没有落点）')
    assert(js.includes('el.preview.focus()'), '进详情页时没有把焦点移进来')
    assert(/#preview:focus \{ outline: none; \}/.test(css), '全屏容器没关掉焦点环（会贴边画一圈蓝框）')
  })

  await check('详情页 /doc/<id> 是一张真页面', async () => {
    // 2026-09-21 用户要求：换地址打开。地址栏里就是这个地址，
    // 所以 server.js 必须把 /doc/<任意 id> 交给前端页面，而不是 404
    const res = await fetch(`${BASE}/doc/56`)
    assert(res.status === 200, `详情页期望 200，实际 ${res.status}`)
    const body = await res.text()
    assert(body.includes('id="preview-frame"'), '详情页没带着正文容器')
    // 页面上没有退出控件了（2026-09-21 用户要求）：退出靠浏览器后退 / Esc
    assert(!body.includes('preview-close'), '详情页又长出了关闭钮')
    // /doc/x 下的相对路径会解析成 /doc/styles.css，所以静态资源必须写绝对路径
    assert(body.includes('href="/styles.css"'), '样式表不是绝对路径（详情页会 404）')
    assert(body.includes('src="/app.js"'), 'app.js 不是绝对路径（详情页会 404）')
    assert(!/(?:src|href)="\.\//.test(body), '还有 ./ 相对路径的资源引用（详情页会 404）')
    // 同一个 id 仍然能拿到内容：详情页正文是前端按 id 拉的，这里只认页面本身
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('renderDocPage(DOC_ROUTE)'), '启动时没有按地址分流出详情页')
    assert(js.includes('classList.add(\'is-doc\')'), '详情页没收起列表那一块')

    // ⚠️⚠️ 详情页里 iframe 的 srcdoc 只在**正文到手之后**赋一次。
    // 早前是先塞一个「正在载入…」的 srcdoc 占位页、正文回来再赋一次 —— 每多赋一次
    // 就往浏览器**联合历史**里多记一条，详情页的历史成了 [列表, 详情, 详情]，
    // 用户按一次返回只是回到「同一条详情」，得按两次才回得到列表。
    // 实测（Chrome 无头 + Page.getNavigationHistory）：给已有 iframe 赋一次不动历史，
    // 连赋两次 history.length 1 → 3；页面级导航事件里主框架其实只跳了一次。
    // 所以「正在载入」改成画在自己 DOM 上的 .is-loading，不往 iframe 里塞占位页。
    const start = js.indexOf('async function renderDocPage')
    const render = js.slice(start, js.indexOf('function leaveDoc', start))
    assert(render.length > 300, '定位不到 renderDocPage 的实现')
    const fetchAt = render.indexOf('await fetchDoc')
    assert(fetchAt > 0, '详情页没按 id 拉正文了？')
    const assigns = (render.match(/\.srcdoc\s*=/g) || []).length
    assert(assigns === 1, `详情页里 srcdoc 赋了 ${assigns} 次（只该 1 次，多赋一次就多一条历史，返回要多按一次）`)
    assert(render.indexOf('.srcdoc =') > fetchAt, '在正文到手之前就给 iframe 赋了 srcdoc（占位页会多记一条历史）')
    assert(/currentHtml \|\| previewShell/.test(render), '正文为空时没有兜底内容')
    assert(/catch \(err\) \{[\s\S]*previewShell\(/.test(render), '载入失败时没有兜底内容')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(render.includes("classList.add('is-loading')"), '载入占位没画在自己的 DOM 上')
    assert(/\.srcdoc = html[\s\S]*classList\.remove\('is-loading'\)/.test(render), '赋完正文没有撤掉载入占位')
    assert(/\.preview\.is-loading \.preview-body::after/.test(css), '缺少载入占位的样式')
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
    // 2026-09-21 用户要求：留言板整体下线（底栏入口、弹窗、逻辑、样式都不再出现）
    const html = await (await fetch(`${BASE}/`)).text()
    const js = await (await fetch(`${BASE}/app.js`)).text()
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(!html.includes('msg-modal'), '留言弹窗又回来了')
    assert(!html.includes('btn-msg'), '底栏又出现留言入口')
    assert(!html.includes('msg-badge'), '底栏又出现留言角标')
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
