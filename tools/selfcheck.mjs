#!/usr/bin/env node
'use strict'

/**
 * 云端信息库 · 本地自检
 *
 * 用法： node tools/selfcheck.mjs [--base http://127.0.0.1:3000]
 * 覆盖：静态资源、顶栏入口（接口说明 / 留言板）、健康检查、
 *       收件箱增删查、鉴权与路径穿越防护。
 * 其中「标签由人工维护」一项会读本地 tools/push.mjs，用来守住「推送不写标签」这条规则；
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
    assert(html.includes('preview-star'), '预览页缺少收藏按钮')
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('data-fav'), '缺少收藏筛选按钮')
    assert(js.includes('view.starred'), '缺少收藏筛选状态')
    assert(js.includes('writeHash'), '缺少收藏深链写入')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(css.includes('.chip-star'), '缺少收藏筛选按钮样式')
    assert(css.includes('.card.is-starred'), '缺少已收藏卡片样式')
  })

  await check('标签由人工维护', async () => {
    // 页面要能「手动给每一条打标签」，并引导复用已有的词
    const html = await (await fetch(`${BASE}/`)).text()
    assert(html.includes('id="tag-input"'), '缺少标签编辑弹窗')
    assert(html.includes('id="tag-pool"'), '标签弹窗缺少「已有标签」候选区')
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('data-tagedit'), '卡片上缺少标签入口')
    assert(js.includes('data-tag="'), '顶部缺少按标签过滤的按钮')
    assert(js.includes('renderTagSuggest'), '缺少已有标签复用逻辑')
    // 推送工具必须强制写空标签
    const push = fs.readFileSync(new URL('../tools/push.mjs', import.meta.url), 'utf8')
    assert(/tags:\s*\[\]/.test(push), 'push.mjs 仍会把标签写进库里')
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
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(!css.includes('.select-wrap'), '样式里仍留着排序下拉样式')
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

  await check('留言功能已就位', async () => {
    const html = await (await fetch(`${BASE}/`)).text()
    assert(html.includes('id="msg-modal"'), '缺少留言弹窗')
    assert(html.includes('id="msg-body"'), '缺少留言输入框')
    assert(html.includes('id="msg-list"'), '缺少留言列表')
    assert(html.includes('id="msg-badge"'), '顶栏缺少留言条数角标')
    const js = await (await fetch(`${BASE}/app.js`)).text()
    assert(js.includes('openMsgBoard'), '缺少留言板逻辑')
    assert(js.includes("from('messages')"), '留言未接云数据库 messages 表')
    assert(js.includes('sendMessage') && js.includes('deleteMessage'), '缺少留言的发布/删除')
    const css = await (await fetch(`${BASE}/styles.css`)).text()
    assert(css.includes('.msg-item'), '缺少留言条目样式')
    assert(css.includes('.msg-compose'), '缺少留言输入区样式')
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
    assert(res.ok && data.ok, '删除失败')
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
