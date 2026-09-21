/* ═══════════════════════════════════════════════════════════
   云端信息库 · 前端逻辑
   无需登录，打开即看；内容正文直接存在云数据库里。
   内容的组织靠分类（报告 / 自选 / 计划），逐条在页面里调。
   顶栏另有「接口」（推送数据的开放接口说明）。
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict'

  const CFG = window.APP_CONFIG || {}
  const INGEST_KEY = 'iv_ing_7f3a9c2e5b8d4160a1f6e9c4b7d20385'
  const MAX_CONTENT = 2 * 1024 * 1024       // 单个内容上限 2MB

  const LIST_FIELDS = 'id,title,summary,doc_type,source,file_size,starred,created_at'

  /* 云数据库的裸 REST 端点（不涉及登录，用应用标识鉴权）。
     接口说明弹窗里的示例全部由它拼出来，避免文档和实际接口写岔。 */
  const REST_BASE = String(CFG.endpoint || '').replace(/\/+$/, '') + '/.cloud/database/rest'
  const API_URL = `${REST_BASE}/documents`

  /* 已读状态：站点公开、没有登录，所以「谁读的」无从区分，只记在本机浏览器里。
     存的是一组内容 id —— 读过就变灰；新推的内容 id 不在集合里，天然是未读。
     筛选条上的「只看未读」就是拿这个集合反着筛。
     （不再显示条数，已读/未读全靠卡片底色区分。） */
  const READ_KEY = 'iv_read'

  const TYPES = [
    { key: 'all', label: '全部' },
    { key: 'report', label: '报告' },
    { key: 'watchlist', label: '自选' },
    { key: 'plan', label: '计划' }
  ]
  const TYPE_LABEL = TYPES.reduce((m, t) => (m[t.key] = t.label, m), {})
  const TYPE_KEYS = TYPES.map((t) => t.key).filter((k) => k !== 'all')
  // 推送没带类型、或旧数据落在三类之外时归到这里（原来那套 dashboard/tool/page/other 已停用）
  const DEFAULT_TYPE = 'report'
  const typeOf = (d) => (TYPE_KEYS.includes(d.doc_type) ? d.doc_type : DEFAULT_TYPE)

  const STAR_PATH = 'M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.85z'
  const starSvg = (on) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`

  // 卡片上的「删除」入口（真正删之前一定会走站内二次确认）
  const delSvg =
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.6 7h14.8M9.6 7V5.5c0-.83.67-1.5 1.5-1.5h1.8c.83 0 1.5.67 1.5 1.5V7M6.6 7l.85 11.1c.07.9.82 1.6 1.72 1.6h5.66c.9 0 1.65-.7 1.72-1.6L17.4 7M10.4 10.9v5.2M13.6 10.9v5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

  const $ = (sel) => document.querySelector(sel)

  const el = {
    boot: $('#boot'),
    mainView: $('#main-view'),

    btnUnread: $('#btn-unread'),

    inboxBar: $('#inbox-bar'),
    inboxCount: $('#inbox-count'),
    inboxHint: $('#inbox-hint'),
    btnArchiveAll: $('#btn-archive-all'),
    btnDismissInbox: $('#btn-dismiss-inbox'),

    typeChips: $('#type-chips'),
    btnCat: $('#btn-cat'),
    statText: $('#stat-text'),
    grid: $('#doc-grid'),
    empty: $('#empty'),
    emptyTitle: $('#empty-title'),
    emptyDesc: $('#empty-desc'),

    preview: $('#preview'),
    previewFrame: $('#preview-frame'),

    editModal: $('#edit-modal'),
    editTitle: $('#edit-title'),
    editSummary: $('#edit-summary'),
    editType: $('#edit-type'),
    editMsg: $('#edit-msg'),
    editConfirm: $('#edit-confirm'),
    editCancel: $('#edit-cancel'),
    editClose: $('#edit-close'),

    catModal: $('#cat-modal'),
    catList: $('#cat-list'),
    catMsg: $('#cat-msg'),
    catDone: $('#cat-done'),
    catClose: $('#cat-close'),

    apiModal: $('#api-modal'),
    apiBody: $('#api-body'),
    apiClose: $('#api-close'),
    apiOk: $('#api-ok'),
    apiCopy: $('#api-copy'),

    confirmModal: $('#confirm-modal'),
    confirmTitle: $('#confirm-title'),
    confirmText: $('#confirm-text'),
    confirmOk: $('#confirm-ok'),
    confirmCancel: $('#confirm-cancel'),

    toast: $('#toast')
  }

  /* ── 状态 ─────────────────────────────────────────────── */
  let cloud = null
  let docs = []
  let inbox = []
  let editing = null
  let current = null
  let currentHtml = ''
  let loading = false
  let firstPaint = true       // 卡片入场动画只在首屏播一次，切筛选不重播
  let readIds = new Set()     // 已读的内容 id（本机 localStorage）

  // 三个筛选条件互相叠加：分类 / 只看收藏 / 只看未读
  const view = { type: 'all', unread: false }

  /* 详情页路由（2026-09-21 用户要求：点卡片「换地址打开」，不再用页内浮层）。
     真地址 = /doc/<id>，由 server.js 交给本页渲染 —— 地址栏里是真的地址，
     刷新 / 分享 / 后退 / 新窗口 / 右键「复制链接地址」全都天然成立。 */
  const DOC_ROUTE = (() => {
    const m = /^\/doc\/([^/]+)\/?$/.exec(location.pathname)
    return m ? decodeURIComponent(m[1]) : ''
  })()
  const docUrl = (id) => '/doc/' + encodeURIComponent(id)

  /* ── 通用工具 ─────────────────────────────────────────── */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function byteLength(s) {
    return new TextEncoder().encode(String(s)).length
  }

  const pad2 = (n) => String(n).padStart(2, '0')

  function fmtTime(input) {
    const d = new Date(input)
    if (isNaN(d.getTime())) return '—'
    const now = new Date()
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    if (d.toDateString() === now.toDateString()) return `今天 ${hm}`
    const y = new Date(now)
    y.setDate(now.getDate() - 1)
    if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`
    if (d.getFullYear() === now.getFullYear()) {
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`
    }
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  }

  function fmtSize(n) {
    const v = Number(n || 0)
    if (!v) return '—'
    if (v < 1024) return `${v} B`
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
    return `${(v / 1024 / 1024).toFixed(1)} MB`
  }

  /* ── 弹窗：焦点进出、Esc、遮罩点击统一走这几个函数 ── */

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
    'textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

  let lastFocus = null
  let scrollLocks = 0

  const isOpen = (node) => !!node && !node.classList.contains('is-hidden')

  function lockScroll() {
    scrollLocks += 1
    document.body.style.overflow = 'hidden'
  }
  function unlockScroll() {
    scrollLocks = Math.max(0, scrollLocks - 1)
    if (!scrollLocks) document.body.style.overflow = ''
  }

  /** 打开弹窗：记住来源焦点、锁滚动、把焦点送进去 */
  function openModal(node, focusEl) {
    const already = isOpen(node)
    node.classList.remove('is-hidden')
    if (!already) {
      lastFocus = document.activeElement
      lockScroll()
    }
    const target = focusEl || node.querySelector(FOCUSABLE)
    if (target) setTimeout(() => target.focus(), 40)
  }

  /** 关闭弹窗：焦点还给当初打开它的那个元素 */
  function closeModal(node) {
    if (!isOpen(node)) return
    node.classList.add('is-hidden')
    unlockScroll()
    const back = lastFocus
    lastFocus = null
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus()
  }

  /** 当前打开着的弹窗（Tab 焦点陷阱要用） */
  function activeModal() {
    const all = document.querySelectorAll('.modal')
    for (const m of all) if (!m.classList.contains('is-hidden')) return m
    return null
  }

  /** Tab 循环锁在弹窗内，别让焦点跑到背后的页面上去 */
  function trapFocus(e) {
    const modal = activeModal()
    if (!modal || e.key !== 'Tab') return
    const items = [...modal.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus() }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  /* ── 二次确认：替掉原生 confirm（样式不可控，移动端体验也差） ── */

  let confirmResolve = null

  function confirmAction(opts) {
    const o = opts || {}
    el.confirmTitle.textContent = o.title || '确认'
    el.confirmText.textContent = o.text || ''
    el.confirmOk.textContent = o.okText || '确定'
    el.confirmOk.className = 'btn ' + (o.tone === 'danger' ? 'btn-danger-solid' : 'btn-primary')
    openModal(el.confirmModal, el.confirmOk)
    return new Promise((resolve) => { confirmResolve = resolve })
  }

  function settleConfirm(answer) {
    const done = confirmResolve
    confirmResolve = null
    closeModal(el.confirmModal)
    if (done) done(answer)
  }

  /** 按钮加载态：转圈 + 禁点，顺手挡住重复提交 */
  function setBusy(btn, on) {
    if (!btn) return
    btn.classList.toggle('is-busy', !!on)
    btn.disabled = !!on
  }

  /** 首屏骨架：先给出形状，别让页面空着。形状跟着卡片走 —— 卡片只剩标题和操作图标 */
  function renderSkeleton(n) {
    const count = n || 8
    el.grid.innerHTML = Array.from({ length: count }, () =>
      '<div class="skeleton-card" aria-hidden="true">' +
        '<div class="sk sk-icons"></div>' +
        '<div class="sk sk-title"></div>' +
      '</div>').join('')
  }

  let toastTimer = null
  function toast(text, kind) {
    el.toast.textContent = text
    // 出错要让读屏立刻播报，普通提示排队播就行
    el.toast.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite')
    el.toast.className = 'toast is-on' + (kind ? ` is-${kind}` : '')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      el.toast.className = 'toast'
    }, kind === 'err' ? 4600 : 2600)
  }

  function modalNote(node, text, kind) {
    node.textContent = text || ''
    node.className = 'modal-msg' + (kind ? ` is-${kind}` : '')
  }

  /** 把云端错误翻译成人话 */
  function friendly(err) {
    if (!err) return '操作失败'
    const code = String(err.code || '')
    const msg = err.message || String(err)
    const has = (c) => code.includes(c)
    if (has('42501')) return '没有写入权限：云端权限策略可能未生效'
    if (has('42P01')) return '数据表不存在，需要在云端先建表'
    if (has('23505')) return '这个内容已经存在了'
    if (has('23514')) return '内容不符合要求：不能为空，也不能超过字数上限'
    if (has('PGRST116')) return '找不到这条内容'
    if (/Failed to fetch|NetworkError|network/i.test(msg)) return '网络不通，请检查连接后重试'
    return msg
  }

  function previewShell(inner) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%}
      body{display:grid;place-items:center;text-align:center;padding:24px;
        font:14px system-ui,-apple-system,"PingFang SC",sans-serif;color:#6b7280}
      b{display:block;color:#454b5c;margin-bottom:8px;font-size:15px;font-weight:600}
    </style></head><body><div>${inner}</div></body></html>`
  }

  /* ── 云端客户端 ───────────────────────────────────────── */

  function initCloud() {
    const WC = window.WorkBuddyCloud
    if (!WC || typeof WC.createWorkBuddyCloud !== 'function') {
      throw new Error('云端 SDK 未能加载，检查网络后刷新页面')
    }
    if (!CFG.endpoint || !CFG.publishableKey) {
      throw new Error('缺少云端配置（config.js）')
    }
    return WC.createWorkBuddyCloud({
      endpoint: CFG.endpoint,
      publishableKey: CFG.publishableKey
    })
  }

  /* ═══════════════ 列表 ═══════════════ */

  async function loadDocs(showToast) {
    if (loading) return
    loading = true
    el.grid.setAttribute('aria-busy', 'true')
    if (!docs.length) renderSkeleton()
    try {
      const { data, error } = await cloud.database
        .from('documents')
        .select(LIST_FIELDS)
        .order('created_at', { ascending: false })
        .limit(500)

      if (error) throw error
      docs = Array.isArray(data) ? data : []
      loadRead()
      pruneRead()
      renderFilters()
      renderDocs()
      if (showToast) toast(`已刷新，共 ${docs.length} 个内容`, 'ok')
    } catch (err) {
      docs = []
      renderFilters()
      renderDocs(err)
      toast(friendly(err), 'err')
    } finally {
      loading = false
      el.grid.setAttribute('aria-busy', 'false')
    }
  }

  function visibleDocs() {
    let list = docs.slice()

    if (view.type !== 'all') list = list.filter((d) => typeOf(d) === view.type)
    if (view.unread) list = list.filter((d) => !isRead(d.id))

    // 固定排序：只按时间倒序（最新优先）。
    // 收藏与否、读没读过，都不参与排序 —— 点收藏不会让卡片跳位。
    const byDate = (d) => new Date(d.created_at).getTime() || 0
    list.sort((a, b) => byDate(b) - byDate(a))
    return list
  }

  function renderFilters() {
    // 未读开关先叠上，分类计数按叠完之后的结果算。
    // 这样每个选项上的数字就是「点进去大概有几条」，不会点出一片空白。
    let after = docs
    if (view.unread) after = after.filter((d) => !isRead(d.id))

    // 开关在筛选条右侧（只有图标），这里只同步它的状态
    syncUnreadBtn(docs.filter((d) => !isRead(d.id)).length)

    const counts = { all: after.length }
    TYPE_KEYS.forEach((k) => {
      counts[k] = after.filter((d) => typeOf(d) === k).length
    })

    // 分类筛选收进一个分段控件：比一排散落的胶囊安静，选中态也更明确。
    // 分类固定就三类，0 条也照样列出来 —— 藏掉的话「自选 / 计划」会看起来不存在
    const segs = TYPES.map((t) => {
      const n = counts[t.key] || 0
      return `<button type="button" class="seg${view.type === t.key ? ' is-active' : ''}" data-type="${t.key}" aria-pressed="${view.type === t.key}">${t.label}<span class="seg-n">${n}</span></button>`
    }).join('')

    el.typeChips.innerHTML = `<div class="segmented" role="group" aria-label="按分类筛选">${segs}</div>`
  }

  /** 同步筛选条上「只看未读」开关：只有图标，开没开全靠颜色和填充表达 */
  function syncUnreadBtn(unreadN) {
    if (!el.btnUnread) return
    const on = view.unread
    el.btnUnread.classList.toggle('is-active', on)
    el.btnUnread.setAttribute('aria-pressed', on ? 'true' : 'false')
    const hint = unreadN ? `共 ${unreadN} 条未读` : '没有未读'
    el.btnUnread.title = on ? `${hint} · 点击看全部` : `只看未读（${hint}）`
    el.btnUnread.setAttribute('aria-label', on ? '正在只看未读，点击看全部内容' : '只看未读')
  }

  /** 条数不显示（用户 2026-09-19 要求取消），只留给读屏播报 */
  function renderStat(list) {
    if (!el.statText) return
    if (!docs.length) {
      el.statText.textContent = ''
      return
    }
    const shown = list.length
    const total = docs.length
    el.statText.textContent = shown === total
      ? `共 ${total} 个内容`
      : `当前显示 ${shown} 条，共 ${total} 条内容`
  }

  /* ── 已读 ─────────────────────────────────────────────── */

  let readLoaded = false

  /** 读出已读 id 集合；存坏了就当没读过，绝不因为一条本地记录把页面卡住 */
  function loadRead(force) {
    if (readLoaded && !force) return readIds
    readLoaded = true
    try {
      const raw = JSON.parse(localStorage.getItem(READ_KEY) || '[]')
      readIds = new Set((Array.isArray(raw) ? raw : []).map(String))
    } catch (_) {
      readIds = new Set()
    }
    return readIds
  }

  function saveRead() {
    try { localStorage.setItem(READ_KEY, JSON.stringify([...readIds])) } catch (_) { /* 隐私模式忽略 */ }
  }

  const isRead = (id) => loadRead().has(String(id))

  function findCard(id) {
    const cards = el.grid.querySelectorAll('.card')
    for (const c of cards) if (c.dataset.id === String(id)) return c
    return null
  }

  /** 打开内容就标记已读。只给这一张卡片加 class，不整屏重渲染（免得入场动画重播） */
  function markRead(id) {
    if (id === undefined || id === null) return
    loadRead()
    if (readIds.has(String(id))) return
    readIds.add(String(id))
    saveRead()
    const card = findCard(id)
    if (card) card.classList.add('is-read')
    // 未读计数跟着掉一个（顶栏那个开关的提示语要用）
    syncUnreadBtn(docs.filter((d) => !isRead(d.id)).length)
  }

  /** 列表刷新后顺手清掉已经不存在的 id，别让本地记录一直膨胀 */
  function pruneRead() {
    if (!readIds.size || !docs.length) return
    const alive = new Set(docs.map((d) => String(d.id)))
    let changed = false
    for (const id of readIds) {
      if (!alive.has(id)) { readIds.delete(id); changed = true }
    }
    if (changed) saveRead()
  }

  // 别的标签页读了内容，这边跟着变灰（storage 事件只在「其他页改动」时触发，不会自激）
  window.addEventListener('storage', (e) => {
    if (e.key !== READ_KEY) return
    loadRead(true)
    el.grid.querySelectorAll('.card').forEach((c) => c.classList.toggle('is-read', isRead(c.dataset.id)))
  })

  function renderDocs(error) {
    const list = visibleDocs()
    renderStat(list)

    if (!list.length) {
      el.grid.innerHTML = ''
      el.empty.classList.remove('is-hidden')
      if (error) {
        el.emptyTitle.textContent = '载入失败'
        el.emptyDesc.textContent = friendly(error)
        return
      }
      const filtering = view.type !== 'all'
      // 未读视角：可能是「刚好读完了」，也可能是被分类筛空了 —— 分开说
      if (view.unread) {
        el.emptyTitle.textContent = filtering ? '未读里没有匹配的内容' : '全部读完了'
        el.emptyDesc.textContent = filtering
          ? '换个分类，或点「全部」看看所有未读。'
          : '新推过来的内容会自动出现在这里；读过的会变灰，并离开这个列表。'
        return
      }
      el.emptyTitle.textContent = filtering ? '没有匹配的内容' : '还是空的'
      el.emptyDesc.textContent = filtering
        ? '换个分类，或点「全部」看看所有内容。'
        : 'WorkBuddy 推送过来的内容会出现在这里。要调分类，点列表上方那个文件夹图标。'
      return
    }

    el.empty.classList.add('is-hidden')

    // 入场动画只认首屏，之后切筛选直接出结果，不再抖一遍
    el.grid.classList.toggle('is-fresh', firstPaint)
    firstPaint = false

    el.grid.innerHTML = list.map((d, i) => {
      const type = typeOf(d)
      const delay = Math.min(i, 12) * 24
      const title = escapeHtml(d.title || '未命名')
      // 卡片只留「推送时间 + 标题」：摘要 / 分类这些详情一律不显示，一行一个内容
      // 已读的卡片整体压灰（.is-read），未读保持原样
      return `<article class="card${d.starred ? ' is-starred' : ''}${isRead(d.id) ? ' is-read' : ''}" data-id="${d.id}" data-type="${type}" style="animation-delay:${delay}ms">
        <div class="card-top">
          <time class="card-time" datetime="${escapeHtml(d.created_at || '')}" title="推送于 ${escapeHtml(fmtTime(d.created_at))}">${escapeHtml(fmtTime(d.created_at))}</time>
          <div class="card-actions">
            <button type="button" class="del-btn" data-del="${d.id}" title="删除" aria-label="删除《${title}》">
              ${delSvg}
            </button>
          </div>
        </div>
        <h3 class="card-title"><a class="card-link" href="${docUrl(d.id)}" data-open="${d.id}" title="打开内容（按住 Shift 在新窗口打开）">${title}</a></h3>
      </article>`
    }).join('')
  }

  /* ═══════════════ 预览 ═══════════════ */

  async function fetchContent(id) {
    const { data, error } = await cloud.database
      .from('documents')
      .select('content')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new Error('这条内容已经被删掉了')
    return String(data.content || '')
  }

  /** 详情页一次把标题和正文都取回来（标题要用来做浏览器标签的标题） */
  async function fetchDoc(id) {
    const { data, error } = await cloud.database
      .from('documents')
      .select('id,title,content')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) throw new Error('这条内容已经被删掉了')
    return data
  }

  /**
   * 详情页（/doc/<id>）—— 这里**不是浮层**，而是地址栏里真实存在的一张页面：
   * 页面本身就是 index.html，只是把列表整块收起来、把铺满整屏的 #preview 当整页用。
   * 所以刷新 / 分享 / 后退 / 新窗口全都天然成立。
   */
  async function renderDocPage(id) {
    document.body.classList.add('is-doc')
    el.boot.classList.add('is-hidden')
    el.mainView.classList.add('is-hidden')
    el.preview.classList.remove('is-hidden')
    // ⚠️⚠️ 这一页只在最后给 iframe 的 srcdoc 赋**一次**值。
    // 早前是先塞一个「正在载入…」的 srcdoc 占位页、正文回来再赋一次 —— 每多赋一次
    // 就往浏览器**联合历史**里多记一条，详情页的历史成了 [列表, 详情, 详情]，
    // 用户按一次返回只是回到「同一条详情」，得按两次才回得到列表。
    // 实测：给已有 iframe 赋一次 history.length 不动，连赋两次 1 → 3。
    // 所以「正在载入」用我们自己 DOM 上的 .is-loading 画，不往 iframe 里塞占位页；
    // 正文和失败兜底也先在本地拼好，最后统一赋一次。
    el.preview.classList.add('is-loading')
    lockScroll()
    // 页面上没有退出控件了，所以把焦点移进这一块：读屏能立刻念出「内容详情」，
    // 键盘用户也不用先穿过整个 iframe 才找到落脚点（Esc / 浏览器后退随时能退）
    setTimeout(() => el.preview.focus(), 40)

    let html = ''
    try {
      const doc = await fetchDoc(id)
      current = doc
      currentHtml = String(doc.content || '')
      html = currentHtml || previewShell('这条内容是空的')
      document.title = (doc.title ? doc.title + ' · ' : '') + '云端信息库'
      markRead(id)
    } catch (err) {
      html = previewShell(`<b>内容载入失败</b>${escapeHtml(friendly(err))}`)
    }

    el.previewFrame.srcdoc = html
    el.preview.classList.remove('is-loading')
  }

  /**
   * 退出详情页 —— Esc 走这里（页面上已经没有退出按钮了，主要靠浏览器后退）。
   * 详情页是真页面：从列表点进来的就原路退回（筛选还在），
   * 直接打开这个地址、没有站内来路的就回列表首页。
   */
  function leaveDoc() {
    if (DOC_ROUTE) {
      let sameSite = false
      try {
        sameSite = !!document.referrer && new URL(document.referrer).origin === location.origin
      } catch (e) { /* 来路解析不了就当没有，回首页 */ }
      if (sameSite && history.length > 1) history.back()
      else location.assign('/')
      return
    }
    closePreview()
  }

  function closePreview() {
    if (!isOpen(el.preview)) return
    el.preview.classList.add('is-hidden')
    el.previewFrame.srcdoc = ''
    current = null
    currentHtml = ''
    unlockScroll()
    const back = lastFocus
    lastFocus = null
    if (back && document.contains(back)) back.focus()
  }

  function downloadHtml(html, name) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(name || 'content').replace(/[\\/:*?"<>|]/g, '_')}.html`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  /**
   * 在新窗口打开内容（Shift + 点击 / Shift + 回车）。
   * 详情页有了真地址，这里直接开 /doc/<id> —— 同步、不用等正文再导航，
   * 所以不会再被弹窗拦截器盯上；右键「复制链接地址」拿到的也是这个地址。
   */
  function openInNewWindow(doc) {
    if (!doc) return
    markRead(doc.id)
    const win = window.open(docUrl(doc.id), '_blank')
    if (!win) toast('新窗口被浏览器拦住了，允许本站弹出窗口后再试', 'err')
  }

  /**
   * 详情页里的操作分发。
   *
   * ⚠️ 没有 UI 调用入口（2026-09-20 去掉整条顶栏 → 2026-09-21 详情页改成真页面 →
   * 卡片上的收藏星标、筛选条上的收藏开关都按用户要求去掉了）。保留它是因为
   * 「下载」「编辑信息」「收藏」都只在这里有实现 —— 删除与新窗口在卡片和
   * Shift + 点击上还能用。等定了入口再接回来。
   */
  async function actOnCurrent(act) {
    const doc = current
    if (!doc) return

    // 界面上已经没有收藏入口了，但这条分支留着 —— 它是 toggleStar 唯一的调用方
    if (act === 'star') {
      await toggleStar(doc.id)
      return
    }

    if (act === 'open') {
      await openInNewWindow(doc)
      return
    }

    if (act === 'download') {
      try {
        if (!currentHtml) currentHtml = await fetchContent(doc.id)
        downloadHtml(currentHtml, doc.title)
      } catch (err) {
        toast(friendly(err), 'err')
      }
      return
    }

    if (act === 'edit') {
      editing = doc
      el.editTitle.value = doc.title || ''
      el.editSummary.value = doc.summary || ''
      el.editType.value = typeOf(doc)
      modalNote(el.editMsg, '')
      openModal(el.editModal, el.editTitle)
      return
    }

    if (act === 'delete') {
      await deleteDoc(doc)
    }
  }

  /** 删除一条内容：预览页顶栏和卡片上的删除按钮，走的是同一条路 */
  async function deleteDoc(doc) {
    if (!doc) return
    const ok = await confirmAction({
      title: '删除内容',
      text: `删除《${doc.title || '未命名'}》？\n\n删除后无法恢复。`,
      okText: '删除',
      tone: 'danger'
    })
    if (!ok) return

    // 从卡片上删的时候，焦点会跟着按钮一起消失 —— 记下它是第几张，渲染完还回去
    const fromGrid = !!document.activeElement?.closest?.('.card')
    const index = visibleDocs().findIndex((d) => String(d.id) === String(doc.id))

    try {
      const del = await cloud.database.from('documents').delete().eq('id', doc.id).select('id')
      if (del.error) throw del.error
      if (!Array.isArray(del.data) || del.data.length === 0) {
        throw new Error('没有删掉，可能已经不存在了')
      }
      docs = docs.filter((d) => d.id !== doc.id)
      if (current && String(current.id) === String(doc.id)) closePreview()
      renderFilters()
      renderDocs()
      toast('已删除', 'ok')
      if (fromGrid) {
        const links = el.grid.querySelectorAll('.card-link')
        const target = links[Math.min(index, links.length - 1)] || $('#main-content')
        if (target) target.focus()
      }
    } catch (err) {
      toast(friendly(err), 'err')
    }
  }

  /* ═══════════════ 写入 ═══════════════ */

  async function archiveOne(item) {
    const html = String(item.html || '')
    if (!html.trim()) throw new Error('内容为空')

    const size = byteLength(html)
    if (size > MAX_CONTENT) throw new Error(`内容 ${fmtSize(size)} 超过 2MB 上限`)

    const row = {
      title: String(item.title || '未命名内容').slice(0, 200),
      summary: String(item.summary || '').slice(0, 500),
      // 标签功能已取消（2026-09-21 用户要求）；字段保留写空数组，只为兼容旧表结构
      tags: [],
      doc_type: TYPE_KEYS.includes(item.docType) ? item.docType : DEFAULT_TYPE,
      source: item.source || 'workbuddy',
      content: html,
      file_size: size
    }

    const ins = await cloud.database.from('documents').insert(row).select(LIST_FIELDS)
    if (ins.error) throw ins.error
    if (!Array.isArray(ins.data) || !ins.data.length) throw new Error('保存失败，云端没返回记录')
    return ins.data[0]
  }

  /* ═══════════════ 收件箱 ═══════════════ */

  async function inboxFetch(path, options) {
    const res = await fetch(path, {
      ...(options || {}),
      headers: { 'x-ingest-key': INGEST_KEY, ...((options && options.headers) || {}) }
    })
    const text = await res.text()
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text) }
    } catch {
      return { ok: false, status: res.status, data: null }
    }
  }

  async function loadInbox() {
    try {
      const res = await inboxFetch('/api/inbox')
      if (!res.ok || !res.data || !res.data.ok) {
        el.inboxBar.classList.add('is-hidden')
        return
      }
      inbox = res.data.items || []
      if (!inbox.length) {
        el.inboxBar.classList.add('is-hidden')
        return
      }
      el.inboxCount.textContent = inbox.length
      const names = inbox.slice(0, 3).map((i) => i.title).join('、')
      el.inboxHint.textContent = inbox.length > 3 ? `${names} 等` : names
      el.inboxBar.classList.remove('is-hidden')
    } catch {
      el.inboxBar.classList.add('is-hidden')
    }
  }

  async function archiveAllInbox() {
    if (!inbox.length) return
    setBusy(el.btnArchiveAll, true)
    el.btnArchiveAll.textContent = '归档中…'
    let done = 0
    let failed = 0
    let lastErr = null

    for (const item of inbox.slice()) {
      try {
        const res = await inboxFetch(`/api/inbox/${item.id}`)
        if (!res.ok || !res.data || !res.data.ok) throw new Error('读取收件箱失败')
        const meta = res.data.meta || {}
        await archiveOne({
          html: res.data.html,
          title: meta.title || item.title,
          summary: meta.summary || item.summary,
          tags: [],                       // 标签功能已取消，见 archiveOne 里的说明
          docType: meta.docType || item.docType,
          source: 'workbuddy'
        })
        await inboxFetch(`/api/inbox/${item.id}`, { method: 'DELETE' })
        done += 1
      } catch (err) {
        failed += 1
        lastErr = err
        console.warn('归档失败', item.id, err && err.message)
      }
    }

    setBusy(el.btnArchiveAll, false)
    el.btnArchiveAll.textContent = '全部入库'

    if (done) {
      toast(`已归档 ${done} 个${failed ? `，${failed} 个失败` : ''}`, failed ? 'err' : 'ok')
    } else if (failed) {
      toast(friendly(lastErr), 'err')
    }

    await Promise.all([loadDocs(), loadInbox()])
  }

  async function clearInbox() {
    const ok = await confirmAction({
      title: '忽略收件箱',
      text: `忽略收件箱里的 ${inbox.length} 个内容？\n\n它们不会被入库，并会从收件箱移除。`,
      okText: '忽略',
      tone: 'danger'
    })
    if (!ok) return
    await inboxFetch('/api/inbox', { method: 'DELETE' })
    toast('已忽略收件箱内容', 'ok')
    await loadInbox()
  }

  /* ═══════════════ 编辑信息 ═══════════════ */

  async function confirmEdit() {
    if (!editing) return
    const patch = {
      title: el.editTitle.value.trim().slice(0, 200) || '未命名',
      summary: el.editSummary.value.trim().slice(0, 500),
      doc_type: TYPE_KEYS.includes(el.editType.value) ? el.editType.value : DEFAULT_TYPE,
      updated_at: new Date().toISOString()
    }

    setBusy(el.editConfirm, true)
    el.editConfirm.textContent = '保存中…'

    try {
      const res = await cloud.database.from('documents').update(patch).eq('id', editing.id).select('id')
      if (res.error) throw res.error
      if (!Array.isArray(res.data) || res.data.length === 0) throw new Error('没有保存成功')

      const idx = docs.findIndex((d) => String(d.id) === String(editing.id))
      if (idx >= 0) docs[idx] = { ...docs[idx], ...patch }
      if (current && String(current.id) === String(editing.id)) {
        current = idx >= 0 ? docs[idx] : { ...current, ...patch }
      }

      closeModal(el.editModal)
      editing = null
      renderFilters()
      renderDocs()
      toast('已保存', 'ok')
    } catch (err) {
      modalNote(el.editMsg, friendly(err), 'error')
    } finally {
      setBusy(el.editConfirm, false)
      el.editConfirm.textContent = '保存'
    }
  }

  /* ═══════════════ 分类编辑 ═══════════════
     工具栏右侧的图标打开，逐条把内容归到 报告 / 自选 / 计划。
     推送来的内容默认都是「报告」，要挪到「自选」「计划」就在这里点一下。 */

  function openCatEditor() {
    renderCatList()
    modalNote(el.catMsg, '')
    openModal(el.catModal, el.catDone)
  }

  /** 一行一条：左边标题，右边三个分类按钮，当前分类高亮 */
  function renderCatList() {
    if (!docs.length) {
      el.catList.innerHTML = '<p class="cat-empty">还没有内容。</p>'
      return
    }
    el.catList.innerHTML = docs.map((d) => {
      const cur = typeOf(d)
      const title = escapeHtml(d.title || '未命名')
      const opts = TYPE_KEYS.map((k) => {
        const on = k === cur
        return `<button type="button" class="cat-opt${on ? ' is-on' : ''}" data-set="${k}" aria-pressed="${on ? 'true' : 'false'}">${TYPE_LABEL[k]}</button>`
      }).join('')
      return `<div class="cat-row" data-id="${d.id}">
        <span class="cat-title" title="${title}">${title}</span>
        <div class="cat-seg" role="group" aria-label="《${title}》的分类">${opts}</div>
      </div>`
    }).join('')
  }

  /** 只重画一行 —— 不整屏重渲染，弹窗里的滚动位置不会跳 */
  function paintCatRow(doc) {
    const row = el.catList.querySelector(`.cat-row[data-id="${doc.id}"]`)
    if (!row) return
    const cur = typeOf(doc)
    row.querySelectorAll('.cat-opt').forEach((b) => {
      const on = b.dataset.set === cur
      b.classList.toggle('is-on', on)
      b.setAttribute('aria-pressed', on ? 'true' : 'false')
    })
  }

  /** 分类变了：分段控件上的计数和底下那份列表都要跟着变 */
  function afterTypeChange() {
    renderFilters()
    renderDocs()
  }

  /** 改一条的分类：界面先动（乐观），写库失败再回滚并说明原因 */
  async function setDocType(doc, type) {
    const prev = typeOf(doc)
    if (prev === type) return
    doc.doc_type = type
    paintCatRow(doc)
    afterTypeChange()
    modalNote(el.catMsg, '')
    try {
      const res = await cloud.database.from('documents')
        .update({ doc_type: type, updated_at: new Date().toISOString() })
        .eq('id', doc.id)
        .select('id')
      if (res.error) throw res.error
      if (!Array.isArray(res.data) || !res.data.length) throw new Error('没有改到，这条可能已经不在了')
    } catch (err) {
      doc.doc_type = prev
      paintCatRow(doc)
      afterTypeChange()
      modalNote(el.catMsg, friendly(err), 'error')
    }
  }

  /* ═══════════════ 收藏 ═══════════════
     界面上已经没有入口了（2026-09-21 用户要求「取消卡片页上面的收藏」+「取消收藏过滤」），
     留着是因为 actOnCurrent('star') 还挂着它；documents.starred 字段一并在库里保留。 */


  async function toggleStar(id) {
    const doc = docs.find((d) => String(d.id) === String(id))
    if (!doc) return
    const next = !doc.starred
    doc.starred = next
    renderFilters()
    renderDocs()
    try {
      const res = await cloud.database.from('documents').update({ starred: next }).eq('id', doc.id).select('id')
      if (res.error) throw res.error
      if (!Array.isArray(res.data) || res.data.length === 0) throw new Error('未生效')
      toast(next ? '已加入收藏' : '已取消收藏', 'ok')
    } catch (err) {
      doc.starred = !next
      renderFilters()
      renderDocs()
      toast('收藏更新失败', 'err')
    }
  }

  /* ═══════════════ 视角深链 ═══════════════
     地址栏带 #unread 时直接进未读视角，方便存成书签一步到达。 */

  function readHash() {
    const h = decodeURIComponent(String(location.hash || '')).replace(/^#/, '').trim().toLowerCase()
    return {
      unread: h === 'unread' || h === '未读'
    }
  }

  function writeHash() {
    const clean = location.pathname + location.search
    const next = view.unread ? '#unread' : ''
    if (next && location.hash !== next) history.replaceState(null, '', clean + next)
    else if (!next && location.hash) history.replaceState(null, '', clean)
  }

  /* ═══════════════ 推送数据开放接口说明 ═══════════════
     文档里的端点、密钥、示例全部由真实配置拼出来，只写实测可用的用法。 */

  const API_FIELDS = [
    ['title', '必填', '标题，显示在卡片上'],
    ['content', '必填', 'HTML 源码全文'],
    ['summary', '选填', '一句话摘要，卡片上展示'],
    ['doc_type', '选填', '分类：report / watchlist / plan，默认 report'],
    ['source', '选填', '来源标记，例如自己的脚本名'],
    ['file_size', '选填', '内容字节数']
  ]

  function openApiDoc() {
    renderApiDoc()
    openModal(el.apiModal, el.apiOk)
  }

  function closeApiDoc() {
    if (!isOpen(el.apiModal)) return
    closeModal(el.apiModal)
  }

  function renderApiDoc() {
    const key = CFG.publishableKey || '(缺少 publishableKey)'
    const k = escapeHtml(key)
    const url = escapeHtml(API_URL)
    const rest = escapeHtml(REST_BASE)
    const sample = escapeHtml(JSON.stringify({
      title: '美股盘前快报 · 9月19日',
      summary: '隔夜三大指数收涨',
      doc_type: 'report',
      source: 'my-script',
      content: '<!DOCTYPE html><html>…</html>'
    }))
    el.apiBody.innerHTML = `
      <p class="api-lead">任何能发 HTTP 请求的地方都能往这里推内容 —— 不需要账号，推完立刻出现在页面上。</p>

      <h4 class="api-h">端点</h4>
      <pre class="api-code">POST ${url}</pre>

      <h4 class="api-h">请求头</h4>
      <pre class="api-code">x-wb-webapp-access-key: ${k}
content-type: application/json
Prefer: return=representation</pre>

      <h4 class="api-h">字段</h4>
      <div class="api-fields">${API_FIELDS.map(([n, req, desc]) =>
        `<div class="api-field"><code>${n}</code><span class="api-req${req === '必填' ? ' is-need' : ''}">${req}</span><span class="api-desc">${desc}</span></div>`
      ).join('')}</div>

      <h4 class="api-h">推送一条内容</h4>
      <pre class="api-code">curl -X POST '${url}' \\
  -H 'x-wb-webapp-access-key: ${k}' \\
  -H 'content-type: application/json' \\
  -H 'Prefer: return=representation' \\
  -d '${sample}'</pre>

      <h4 class="api-h">读取</h4>
      <pre class="api-code"># 列表（不带正文，返回快）
GET ${rest}/documents?select=id,title,doc_type&order=created_at.desc

# 单条正文
GET ${rest}/documents?select=content&id=eq.1</pre>

      <h4 class="api-h">删除</h4>
      <pre class="api-code">DELETE ${rest}/documents?id=eq.1</pre>

      <h4 class="api-h">说明</h4>
      <ul class="api-notes">
        <li>失败时响应体里有 <code>code</code> 与 <code>message</code>，照它排查即可。</li>
        <li>建议单条内容控制在 2MB 以内 —— 页面入库时按同一上限校验。</li>
        <li>仓库里的 <code>tools/push.mjs</code> 走的就是这个接口。</li>
        <li><strong>这个密钥是公开的</strong>：它随页面发给了每个访客，所以把站点地址给谁，就等于允许谁写入。</li>
      </ul>`
  }

  async function copyApiUrl() {
    try {
      await navigator.clipboard.writeText(API_URL)
      toast('接口地址已复制', 'ok')
    } catch (_) {
      // 非安全上下文或权限被拒时退回手选
      const ta = document.createElement('textarea')
      ta.value = API_URL
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy'); toast('接口地址已复制', 'ok') }
      catch (e) { toast('复制失败，请手动选中', 'err') }
      ta.remove()
    }
  }

  /* ═══════════════ 事件绑定 ═══════════════ */

  function bindEvents() {
    // 接口说明弹窗：2026-09-21 底栏整条去掉后暂时没有入口（实现与文档都留着，
    // 里面的端点 / 密钥 / 示例仍然是查接口的地方），要入口随时接回来。
    el.apiClose.addEventListener('click', closeApiDoc)
    el.apiOk.addEventListener('click', closeApiDoc)
    el.apiCopy.addEventListener('click', copyApiUrl)

    // 筛选条右侧只剩「只看未读」一个视角开关（只有图标）
    const toggleView = (key) => {
      view[key] = !view[key]
      writeHash()
      renderFilters()
      renderDocs()
    }
    if (el.btnUnread) el.btnUnread.addEventListener('click', () => toggleView('unread'))

    el.typeChips.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-type]')
      if (!btn) return
      view.type = btn.dataset.type
      renderFilters()
      renderDocs()
    })

    el.grid.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]')
      if (del) {
        e.stopPropagation()
        const doc = docs.find((d) => String(d.id) === del.dataset.del)
        if (doc) deleteDoc(doc)
        return
      }
      // 卡片正文是铺满整卡的链接。2026-09-21 用户要求「换地址打开」，
      // 所以这里**不拦默认跳转**：让浏览器自己按 <a href="/doc/<id>"> 走 ——
      // 普通点击换地址、Shift + 点击开新窗口、中键 / 右键「复制链接地址」，全都天然可用；
      // 键盘 Tab + 回车也是原生行为，不再需要额外的 keydown 处理。
      // 这里唯一要做的就是把「已读」记下来（localStorage 是同步写，跳走也来得及）。
      const link = e.target.closest('a.card-link')
      if (link) markRead(link.dataset.open)
    })

    // 分类编辑：工具栏右侧的图标打开，点一下就改一条、即改即存
    el.btnCat.addEventListener('click', openCatEditor)
    el.catDone.addEventListener('click', () => closeModal(el.catModal))
    el.catClose.addEventListener('click', () => closeModal(el.catModal))
    el.catList.addEventListener('click', (e) => {
      const opt = e.target.closest('.cat-opt[data-set]')
      if (!opt) return
      const row = opt.closest('.cat-row')
      if (!row) return
      const doc = docs.find((d) => String(d.id) === row.dataset.id)
      if (doc) setDocType(doc, opt.dataset.set)
    })

    const discardEdit = () => { closeModal(el.editModal); editing = null }
    el.editClose.addEventListener('click', discardEdit)
    el.editCancel.addEventListener('click', discardEdit)
    el.editConfirm.addEventListener('click', confirmEdit)

    // 二次确认弹窗的两个出口
    el.confirmOk.addEventListener('click', () => settleConfirm(true))
    el.confirmCancel.addEventListener('click', () => settleConfirm(false))

    el.btnArchiveAll.addEventListener('click', archiveAllInbox)
    el.btnDismissInbox.addEventListener('click', clearInbox)

    document.addEventListener('keydown', (e) => {
      // Tab 锁在弹窗内，别让焦点跑到背后的列表上
      if (e.key === 'Tab') return trapFocus(e)
      if (e.key !== 'Escape') return
      if (isOpen(el.confirmModal)) return settleConfirm(false)
      if (isOpen(el.apiModal)) return closeApiDoc()
      if (isOpen(el.editModal)) { closeModal(el.editModal); editing = null; return }
      if (isOpen(el.preview)) return leaveDoc()
    })

    window.addEventListener('hashchange', () => {
      const next = readHash()
      if (next.unread === view.unread) return
      view.unread = next.unread
      renderFilters()
      renderDocs()
    })

    // 点遮罩关闭
    const closers = new Map([
      [el.editModal, discardEdit],
      [el.apiModal, closeApiDoc],
      [el.confirmModal, () => settleConfirm(false)]
    ])
    closers.forEach((close, modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) close()
      })
    })
  }

  /* ═══════════════ 启动 ═══════════════ */

  function start() {
    bindEvents()

    try {
      cloud = initCloud()
    } catch (err) {
      el.boot.innerHTML = `<p style="color:#dc2626;max-width:340px;text-align:center;line-height:1.6">${escapeHtml(err.message)}</p>`
      return
    }

    // 详情页：只渲染这一条正文，列表那一块不加载（也少一次列表请求）
    if (DOC_ROUTE) {
      renderDocPage(DOC_ROUTE)
      return
    }

    const hash = readHash()
    view.unread = hash.unread

    el.boot.classList.add('is-hidden')
    el.mainView.classList.remove('is-hidden')
    renderSkeleton()
    loadDocs()
    loadInbox()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
