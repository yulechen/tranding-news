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
     顶栏的「只看未读」就是拿这个集合反着筛。
     （顶栏不再显示条数，已读/未读全靠卡片底色区分。） */
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

    btnRefresh: $('#btn-refresh'),
    btnApi: $('#btn-api'),
    btnFav: $('#btn-fav'),
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
    previewClose: $('#preview-close'),

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
  const view = { type: 'all', starred: false, unread: false }

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
    if (showToast) setBusy(el.btnRefresh, true)
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
      setBusy(el.btnRefresh, false)
    }
  }

  function visibleDocs() {
    let list = docs.slice()

    if (view.type !== 'all') list = list.filter((d) => typeOf(d) === view.type)
    if (view.starred) list = list.filter((d) => !!d.starred)
    if (view.unread) list = list.filter((d) => !isRead(d.id))

    // 固定排序：只按时间倒序（最新优先）。
    // 收藏与否、读没读过，都不参与排序 —— 点收藏不会让卡片跳位。
    const byDate = (d) => new Date(d.created_at).getTime() || 0
    list.sort((a, b) => byDate(b) - byDate(a))
    return list
  }

  function renderFilters() {
    // 两个视角开关（收藏 / 未读）先叠上，分类计数按叠完之后的结果算。
    // 这样每个选项上的数字就是「点进去大概有几条」，不会点出一片空白。
    let after = docs
    if (view.starred) after = after.filter((d) => !!d.starred)
    if (view.unread) after = after.filter((d) => !isRead(d.id))

    const starredN = docs.filter((d) => !!d.starred).length
    const unreadN = docs.filter((d) => !isRead(d.id)).length

    // 两个开关都在顶栏（只有图标），这里只同步它们的状态
    syncFavBtn(starredN)
    syncUnreadBtn(unreadN)

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

  /** 同步顶栏收藏开关的状态：只有一个图标，开没开全靠颜色和填充表达 */
  function syncFavBtn(starredN) {
    if (!el.btnFav) return
    const on = view.starred
    el.btnFav.classList.toggle('is-active', on)
    el.btnFav.setAttribute('aria-pressed', on ? 'true' : 'false')
    const hint = starredN ? `共 ${starredN} 条收藏` : '还没有收藏'
    el.btnFav.title = on ? `${hint} · 点击看全部` : `只看收藏（${hint}）`
    el.btnFav.setAttribute('aria-label', on ? '正在只看收藏，点击看全部内容' : '只看收藏')
  }

  /** 同步顶栏「只看未读」开关：跟收藏开关同一套，点亮用蓝色（收藏是琥珀） */
  function syncUnreadBtn(unreadN) {
    if (!el.btnUnread) return
    const on = view.unread
    el.btnUnread.classList.toggle('is-active', on)
    el.btnUnread.setAttribute('aria-pressed', on ? 'true' : 'false')
    const hint = unreadN ? `共 ${unreadN} 条未读` : '没有未读'
    el.btnUnread.title = on ? `${hint} · 点击看全部` : `只看未读（${hint}）`
    el.btnUnread.setAttribute('aria-label', on ? '正在只看未读，点击看全部内容' : '只看未读')
  }

  /** 条数不再显示在顶栏（用户 2026-09-19 要求取消），只留给读屏播报 */
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
      if (view.starred) {
        el.emptyTitle.textContent = filtering ? '收藏里没有匹配的内容' : '收藏夹是空的'
        el.emptyDesc.textContent = filtering
          ? '换个分类，或点「全部」看看全部收藏。'
          : '点卡片右上角的星标就能收藏；收藏的内容会集中到这里，随时能翻出来。'
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
            <button type="button" class="star-btn${d.starred ? ' is-on' : ''}" data-star="${d.id}" title="${d.starred ? '取消收藏' : '收藏'}" aria-label="${d.starred ? '取消收藏' : '收藏'}《${title}》" aria-pressed="${d.starred ? 'true' : 'false'}">
              ${starSvg(!!d.starred)}
            </button>
            <button type="button" class="del-btn" data-del="${d.id}" title="删除" aria-label="删除《${title}》">
              ${delSvg}
            </button>
          </div>
        </div>
        <h3 class="card-title"><a class="card-link" href="#doc-${d.id}" data-open="${d.id}" title="在当前页面打开（按住 Shift 在新窗口打开）">${title}</a></h3>
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

  async function openPreview(doc) {
    if (!doc) return
    markRead(doc.id)
    current = doc
    currentHtml = ''
    el.previewFrame.srcdoc = previewShell('正在载入…')
    const already = isOpen(el.preview)
    el.preview.classList.remove('is-hidden')
    if (!already) {
      lastFocus = document.activeElement
      lockScroll()
    }
    // 键盘用户进来后焦点落在关闭钮上，看完直接回车就退出去
    setTimeout(() => el.previewClose.focus(), 40)

    try {
      const html = await fetchContent(doc.id)
      currentHtml = html
      el.previewFrame.srcdoc = html || previewShell('这条内容是空的')
    } catch (err) {
      el.previewFrame.srcdoc = previewShell(`<b>内容载入失败</b>${escapeHtml(friendly(err))}`)
    }
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

  // 新窗口的占位页：极简、不依赖站内样式，正文到之前先让用户看到「在载入」
  function windowShell(title, message) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title || '内容')}</title><style>` +
      `html,body{margin:0;height:100%}` +
      `body{display:grid;place-items:center;background:#f4f5f7;color:#6b7280;` +
      `font:15px/1.7 system-ui,-apple-system,"PingFang SC",sans-serif}` +
      `.box{text-align:center;padding:40px 24px;max-width:34em}` +
      `.spin{width:26px;height:26px;margin:0 auto 14px;border-radius:50%;` +
      `border:2.5px solid #dfe3ea;border-top-color:#2563eb;animation:sp .8s linear infinite}` +
      `@keyframes sp{to{transform:rotate(360deg)}}` +
      `@media (prefers-reduced-motion:reduce){.spin{animation:none}}` +
      `</style></head><body><div class="box">${message === '正在载入…' ? '<div class="spin"></div>' : ''}${message || '正在载入…'}</div></body></html>`
  }

  /**
   * 在新窗口打开内容 —— **备用**打开方式（Shift + 点击 / Shift + 回车，
   * 以及预览页顶栏的「新窗口」按钮）。默认路径是 openPreview，在当前页里看。
   *
   * ⚠️ 顺序不能改：`window.open` 必须**同步**调用。正文要现拉（列表不取 content 字段），
   * 一旦先 await 再 open，浏览器就不再把这当成用户手势的一部分，新窗口会被弹窗拦截器拦掉。
   * 所以这里先同步开一个空白窗占位、写入载入页，拿到正文后再把窗口导航到 blob URL。
   */
  async function openInNewWindow(doc, preloaded) {
    if (!doc) return
    markRead(doc.id)
    const win = window.open('', '_blank')
    if (!win) {
      toast('新窗口被浏览器拦住了，允许本站弹出窗口后再试', 'err')
      return
    }

    try {
      win.document.write(windowShell(doc.title, '正在载入…'))
      win.document.close()
    } catch (e) {
      /* 少数浏览器不允许写空白窗，那就只等后面的导航，不再兜底 */
    }

    let html = ''
    try {
      html = preloaded || await fetchContent(doc.id)
    } catch (err) {
      try {
        win.document.body.innerHTML =
          `<div class="box">内容载入失败：${escapeHtml(friendly(err))}</div>`
      } catch (e) {
        /* 用户可能已经把新窗口关了 */
      }
      toast(friendly(err), 'err')
      return
    }

    try {
      const blob = new Blob([html || windowShell(doc.title, '这条内容是空的')], {
        type: 'text/html;charset=utf-8'
      })
      const url = URL.createObjectURL(blob)
      win.location.replace(url)
      // 窗口可能开着很久，刷新也还用得到这个地址，给足时间再回收
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000)
    } catch (e) {
      /* 正文拿到了但占位窗已被关掉 —— 静默即可，不是错误 */
    }
  }

  /**
   * 预览页里的操作分发。
   *
   * ⚠️ 2026-09-20 起预览页的顶栏整个去掉了（用户要求「不要顶栏」），
   * 所以这个函数目前**没有 UI 调用入口**。保留它是因为「下载」和「编辑信息」
   * 只在这里有实现 —— 收藏 / 标签 / 删除 / 新窗口在卡片和 Shift + 点击上都还能用，
   * 唯独这两个暂时没有别的地方可点。等定了新入口（卡片、长按、悬浮菜单）再接回来。
   */
  async function actOnCurrent(act) {
    const doc = current
    if (!doc) return

    if (act === 'star') {
      await toggleStar(doc.id)
      return
    }

    if (act === 'open') {
      // 走到这里说明正文多半已经在内存里了，直接复用
      await openInNewWindow(doc, currentHtml)
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

  /* ═══════════════ 收藏 ═══════════════ */

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
     地址栏带 #fav / #unread 时直接进对应视角，方便存成书签一步到达。 */

  function readHash() {
    const h = decodeURIComponent(String(location.hash || '')).replace(/^#/, '').trim().toLowerCase()
    return {
      starred: h === 'fav' || h === 'starred' || h === '收藏',
      unread: h === 'unread' || h === '未读'
    }
  }

  function writeHash() {
    const clean = location.pathname + location.search
    const next = view.unread ? '#unread' : view.starred ? '#fav' : ''
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
    el.btnRefresh.addEventListener('click', () => loadDocs(true))

    // 顶栏：接口说明
    el.btnApi.addEventListener('click', openApiDoc)
    el.apiClose.addEventListener('click', closeApiDoc)
    el.apiOk.addEventListener('click', closeApiDoc)
    el.apiCopy.addEventListener('click', copyApiUrl)

    // 顶栏两个视角开关（都只有图标）。收藏和未读可以叠加，互不排斥
    const toggleView = (key) => {
      view[key] = !view[key]
      writeHash()
      renderFilters()
      renderDocs()
    }
    if (el.btnFav) el.btnFav.addEventListener('click', () => toggleView('starred'))
    if (el.btnUnread) el.btnUnread.addEventListener('click', () => toggleView('unread'))

    el.typeChips.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-type]')
      if (!btn) return
      view.type = btn.dataset.type
      renderFilters()
      renderDocs()
    })

    el.grid.addEventListener('click', (e) => {
      const star = e.target.closest('[data-star]')
      if (star) {
        e.stopPropagation()
        toggleStar(star.dataset.star)
        return
      }
      const del = e.target.closest('[data-del]')
      if (del) {
        e.stopPropagation()
        const doc = docs.find((d) => String(d.id) === del.dataset.del)
        if (doc) deleteDoc(doc)
        return
      }
      // 卡片正文是铺满整卡的链接：键盘能 Tab 到、回车能开。
      // 拦下默认跳转，地址栏不会被 #doc-x 弄脏。
      if (e.target.closest('a.card-link')) e.preventDefault()

      const card = e.target.closest('.card')
      if (!card) return
      const doc = docs.find((d) => String(d.id) === card.dataset.id)
      if (!doc) return
      // 默认打开方式：在当前页的预览浮层里打开（用户 2026-09-20 要求，不再默认新开标签页）。
      // 想单开一页就 Shift + 点击 —— 注意不要 await，openInNewWindow 内部要同步把
      // window.open 发出去，保住用户手势，否则会被弹窗拦截器拦掉。
      if (e.shiftKey) { openInNewWindow(doc); return }
      openPreview(doc)
    })

    // 键盘：回车 = 在当前页打开，Shift + 回车 = 新窗口（与鼠标两种点法对齐）。
    // 这里对 Enter 一律 preventDefault，顺带压掉浏览器合成的 click，免得开两次。
    el.grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const link = e.target.closest('a.card-link')
      if (!link) return
      const card = link.closest('.card')
      const doc = card && docs.find((d) => String(d.id) === card.dataset.id)
      if (!doc) return
      e.preventDefault()
      if (e.shiftKey) openInNewWindow(doc)
      else openPreview(doc)
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

    // 预览没有顶栏，只有一颗悬浮关闭钮（Esc 同样能退）
    el.previewClose.addEventListener('click', closePreview)

    document.addEventListener('keydown', (e) => {
      // Tab 锁在弹窗内，别让焦点跑到背后的列表上
      if (e.key === 'Tab') return trapFocus(e)
      if (e.key !== 'Escape') return
      if (isOpen(el.confirmModal)) return settleConfirm(false)
      if (isOpen(el.apiModal)) return closeApiDoc()
      if (isOpen(el.editModal)) { closeModal(el.editModal); editing = null; return }
      if (isOpen(el.preview)) return closePreview()
    })

    window.addEventListener('hashchange', () => {
      const next = readHash()
      if (next.starred === view.starred && next.unread === view.unread) return
      view.starred = next.starred
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

    const hash = readHash()
    view.starred = hash.starred
    view.unread = hash.unread

    try {
      cloud = initCloud()
    } catch (err) {
      el.boot.innerHTML = `<p style="color:#dc2626;max-width:340px;text-align:center;line-height:1.6">${escapeHtml(err.message)}</p>`
      return
    }

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
