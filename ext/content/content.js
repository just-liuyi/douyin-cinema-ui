/**
 * Douyin Cinema UI — isolated content script.
 *
 * Responsibilities, in the order they matter:
 * 1. Cinema look: dark tokens, trimmed navigation (推荐 / 关注 / 朋友 / 我的 only),
 *    no like or collect affordances.
 * 2. Playback: restore click-to-seek on the progress bar (the site's own gesture
 *    is broken: pointer events reach the track but the player never seeks).
 * 3. Download: inject a button, resolve the watermark-free URL, hand it to the
 *    service worker.
 */

(() => {
  const FLAG = '__dcinemaContent'
  if (window[FLAG]) return
  window[FLAG] = true

  /** Nav entries the extension removes. */
  const HIDE_NAV_TEXT = new Set([
    '精选', 'AI抖音', '直播', '放映厅', '短剧', '小游戏', '客户端', '充钻石', '壁纸', '通知', '购物', '作者中心',
  ])

  /** Social affordances the extension hides. */

  const toast = (() => {
    let node = null
    return (text, kind = 'info') => {
      if (!node) {
        node = document.createElement('div')
        node.className = 'dcinema-toast'
        document.documentElement.appendChild(node)
      }
      node.textContent = text
      node.dataset.kind = kind
      node.classList.add('on')
      clearTimeout(node.__timer)
      node.__timer = setTimeout(() => node.classList.remove('on'), 4200)
    }
  })()

  const visibleVideo = () =>
    [...document.querySelectorAll('video')]
      .map((v) => ({ v, r: v.getBoundingClientRect() }))
      .filter((x) => x.r.height > 100 && x.r.top >= 0 && x.r.top < innerHeight)
      .sort((a, b) => a.r.top - b.r.top)[0]

  /** Accept either a `<video>` element or the `{ v, r }` wrapper from visibleVideo(). */
  const elementOf = (value) => (value && value.v ? value.v : value)

  const feedItemOf = (video) =>
    elementOf(video)?.closest('[data-e2e="feed-item"], .page-recommend-container, .xg-video-container')

  /** Walk up from the video until an ancestor owns the描述/作者 nodes. */
  const containerOf = (video) => {
    let node = elementOf(video)
    for (let depth = 0; node && depth < 12; depth += 1) {
      if (
        node.querySelector &&
        (node.querySelector('[data-e2e="video-desc"]') || node.querySelector('.account-name') || node.querySelector('.title'))
      ) {
        return node
      }
      node = node.parentElement
    }
    return null
  }

  const titleOf = (video) => {
    const element = elementOf(video)
    const box = (element && containerOf(element)) || feedItemOf(element) || document
    const account = box.querySelector?.('.account-name')?.textContent?.trim() || ''
    const desc =
      box.querySelector?.('[data-e2e="video-desc"]')?.textContent?.trim() ||
      box.querySelector?.('.title')?.textContent?.trim() ||
      ''
    const clean = `${account}${account && desc ? '-' : ''}${desc}`.replace(/展开|\s+/g, ' ').trim()
    return clean || document.title.replace(/ - 抖音.*$/, '').trim() || 'douyin-video'
  }

  // ---------------------------------------------------------------- seek fix
  /**
   * Douyin's IM conversation rows open on `mousedown` only (the row wrapper binds
   * onMouseDown and onContextMenu, no onClick). If anything upstream cancels the
   * pointer sequence, the press never reaches the row and a plain click is silently
   * ignored — the panel looks alive but no conversation opens.
   *
   * A press that does reach the row is left completely alone; the bridge only fires
   * when the row saw no pointerdown/mousedown for this click.
   */
  const bridgeImRowPress = () => {
    const ROW = '[data-e2e="conversation-item"]'
    const pressed = new WeakSet()

    const markPressed = (event) => {
      const row = event.target && event.target.closest ? event.target.closest(ROW) : null
      if (row) pressed.add(row)
    }

    document.addEventListener('pointerdown', markPressed, true)
    document.addEventListener('mousedown', markPressed, true)

    document.addEventListener(
      'click',
      (event) => {
        const row = event.target && event.target.closest ? event.target.closest(ROW) : null
        if (!row) return
        if (pressed.has(row)) {
          pressed.delete(row)
          return
        }
        // The press was swallowed: replay it so the site's onMouseDown sees a click.
        const rect = row.getBoundingClientRect()
        const point = {
          clientX: event.clientX || rect.left + 24,
          clientY: event.clientY || rect.top + rect.height / 2,
        }
        const base = { bubbles: true, cancelable: true, composed: true, button: 0, view: window, ...point }
        for (const type of ['pointerdown', 'mousedown']) row.dispatchEvent(new PointerEvent(type, { ...base, buttons: 1 }))
        for (const type of ['pointerup', 'mouseup']) row.dispatchEvent(new PointerEvent(type, { ...base, buttons: 0 }))
        pressed.delete(row)
      },
      true,
    )
  }

  const installSeekFix = () => {
    document.addEventListener(
      'pointerdown',
      (event) => {
        const progress = event.target && event.target.closest ? event.target.closest('xg-progress') : null
        if (!progress) return
        const current = visibleVideo()
        if (!current) return
        const duration = current.v.duration
        if (!Number.isFinite(duration) || duration <= 0) return

        const rect = progress.getBoundingClientRect()
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
        const target = ratio * duration
        const player = progress.closest('.xgplayer') || document

        // Immediate feedback: the player's own gesture no longer repaints.
        const played = player.querySelector('.xgplayer-progress-played')
        if (played) played.style.width = `${(ratio * 100).toFixed(2)}%`
        const knob = player.querySelector('xg-progress-btn, .xgplayer-progress-btn')
        if (knob) knob.style.left = `${(ratio * 100).toFixed(2)}%`

        current.v.currentTime = target
        toast(`跳转至 ${fmt(target)}`, 'info')
        current.v.addEventListener('seeked', () => toast(`已到达 ${fmt(current.v.currentTime)}`, 'ok'), { once: true })
      },
      true,
    )

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.target && /input|textarea/i.test(event.target.tagName)) return
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const current = visibleVideo()
        if (!current) return
        const step = event.key === 'ArrowRight' ? 5 : -5
        current.v.currentTime = Math.max(0, Math.min(current.v.duration, current.v.currentTime + step))
      },
      true,
    )
  }

  const fmt = (seconds) => {
    if (!Number.isFinite(seconds)) return '00:00'
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  }

  // ------------------------------------------------------------ nav trimming
  /** The header's right-hand cluster (充钻石 / 消息 / 投稿 …), if present. */
  const headerEntryCluster = () =>
    [...document.querySelectorAll('div')].find((el) => {
      const text = (el.textContent || '').trim()
      const rect = el.getBoundingClientRect()
      return (
        text.includes('充钻石') &&
        text.includes('消息') &&
        text.includes('投稿') &&
        el.children.length >= 4 &&
        rect.width > 100 &&
        rect.width < 420
      )
    }) || null

  /**
   * Hide blocklisted entries by their own text.
   *
   * Scoped to the navigation column and the header cluster on purpose: a whole-
   * document sweep also matches ordinary page copy — on the profile grid a card
   * carrying the word 直播 had its enclosing <a> hidden, which removed the card.
   */
  const trimChrome = () => {
    const scopes = [document.querySelector('[data-e2e="douyin-navigation"]'), headerEntryCluster()].filter(Boolean)
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll('a, div, span, li, p')) {
        if (el.children.length > 0) continue
        const text = (el.textContent || '').trim()
        if (!text || !HIDE_NAV_TEXT.has(text)) continue
        ;(el.closest('a, li') || el).classList.add('dcinema-hidden')
      }
    }
  }

  // --------------------------------------------------- video fit
  /**
   * Fill the width only when that costs little: the player box is far wider than
   * tall (about 1.9:1), so `cover` on a 4:3 clip would scale it to 1141px inside a
   * 796px box and cut 173px off the top *and bottom* — which swallows the burned-in
   * subtitles. Cover is therefore allowed only while the vertical crop stays under
   * 8%; anything with a bigger mismatch keeps its whole frame.
   */
  const MAX_COVER_CROP = 0.08

  const fitVideo = (video) => {
    const width = video.videoWidth || 0
    const height = video.videoHeight || 0
    if (!width || !height) return

    const rect = video.getBoundingClientRect()
    const ratio = width / height
    let mode = 'contain'
    if (rect.width > 0 && rect.height > 0) {
      const scale = Math.max(rect.width / width, rect.height / height)
      const verticalCrop = Math.max(0, height * scale - rect.height) / rect.height
      mode = ratio >= 1.2 && verticalCrop <= MAX_COVER_CROP ? 'cover' : 'contain'
    }

    if (video.style.objectFit !== mode) video.style.objectFit = mode
    // Cover still trims a little height; take that trim from the top so burned-in
    // subtitles near the bottom edge stay inside the frame.
    video.style.objectPosition = mode === 'cover' ? 'center bottom' : 'center center'
    if (!video.__dcinemaFitBound) {
      video.__dcinemaFitBound = true
      video.addEventListener('loadedmetadata', () => fitVideo(video))
    }
  }

  const fitVideos = () => {
    for (const video of document.querySelectorAll('video')) fitVideo(video)
  }

  // ------------------------------------------------- player menu cleanup
  /**
   * The “更多” popover lists 推荐 / 上热门 / 手机续播 / 举报 / 快捷键列表 plus a
   * 收藏 button. Keep 举报 and 快捷键列表; drop the promotional entries and the
   * collect action.
   */
  const MENU_BLOCK = new Set(['推荐', '上热门', '手机续播', '收藏'])

  const trimPlayerMenu = () => {
    const hosts = [...document.querySelectorAll('div')].filter((el) => {
      if (!(el.textContent || '').includes('快捷键列表')) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 100 && rect.height > 60
    })
    if (hosts.length === 0) return
    hosts.sort(
      (a, b) =>
        a.getBoundingClientRect().width * a.getBoundingClientRect().height -
        b.getBoundingClientRect().width * b.getBoundingClientRect().height,
    )
    const menu = hosts[0]

    for (const el of menu.querySelectorAll('div, span')) {
      const text = (el.textContent || '').trim()
      if (!MENU_BLOCK.has(text) || el.children.length > 2) continue
      el.classList.add('dcinema-hidden')
    }

    // The collect button lives in the surrounding panel, not in the icon row.
    let panel = menu
    for (let depth = 0; depth < 6 && panel.parentElement; depth += 1) {
      panel = panel.parentElement
      if (panel.getBoundingClientRect().height > 150) break
    }
    for (const el of panel.querySelectorAll('div, span, button')) {
      if ((el.textContent || '').trim() !== '收藏' || el.children.length > 2) continue
      el.classList.add('dcinema-hidden')
    }
  }

  // ---------------------------------------------------------- bar actions
  const ICON_COMMENT =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 5.5h16v11H9.5L4 20V5.5Z" stroke-linejoin="round"/></svg>'
  const ICON_SHARE =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 13.5c4.5-6 9-6 13.5 0" stroke-linecap="round"/><path d="m15 7.5 4 4.5-4 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  const barActionsSignature = () => {
    const comment = document.querySelector('[data-e2e="feed-comment-icon"]')
    const share = document.querySelector('[data-e2e="video-player-share"]')
    return [(comment?.textContent || '').trim(), (share?.textContent || '').trim()].join('|')
  }

  const ICON_DETAIL =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M13.5 5H19v5.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 5 11 13" stroke-linecap="round"/><path d="M18 14.5V18a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18V7a1.5 1.5 0 0 1 1.5-1.5H9" stroke-linecap="round"/></svg>'

  /** Jumps to the standalone page for the video that is on screen. */
  const makeDetailButton = () => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dcinema-detail dcinema-pill'
    button.title = '进入详情页'
    button.setAttribute('aria-label', '进入详情页')
    button.innerHTML = `${ICON_DETAIL}<span>详情</span>`
    button.addEventListener(
      'click',
      (event) => {
        event.preventDefault()
        event.stopPropagation()
        const id = activeAwemeId()
        if (!id) {
          toast('未取到当前内容编号，请先让它出现在画面上', 'warn')
          return
        }
        location.href = currentKind() === 'note' ? `/note/${id}` : `/video/${id}`
      },
      true,
    )
    return button
  }

  /** The top bar keeps only the download button. */
  const renderBarActions = () => {
    const cluster = document.querySelector('.dcinema-actions')
    if (!cluster) return
    if (!hasActiveItem()) {
      cluster.textContent = ''
      return
    }
    if (!cluster.querySelector('.dcinema-detail')) cluster.appendChild(makeDetailButton())
    if (!cluster.querySelector('.dcinema-dl')) cluster.appendChild(makeButton())
  }

  const iconButton = (icon, count, title, onClick) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dcinema-pill'
    button.title = title
    button.innerHTML = `${icon}${count ? `<span>${count}</span>` : ''}`
    button.addEventListener(
      'click',
      (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      },
      true,
    )
    return button
  }
  // ------------------------------------------------------------- top bar
  const BRAND_SVG = `
    <span class="dcinema-brand-mark">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="dcm-note" x1="8" y1="6" x2="16" y2="19">
            <stop stop-color="#25f4ee"/><stop offset="1" stop-color="#fe2c55"/>
          </linearGradient>
          <linearGradient id="dcm-flag" x1="13" y1="3" x2="20" y2="10">
            <stop stop-color="#fe2c55"/><stop offset="1" stop-color="#25f4ee"/>
          </linearGradient>
        </defs>
        <path d="M14 3.2v9.1a3.35 3.35 0 1 1-3.35-3.35c.36 0 .7.06 1.02.16" stroke="url(#dcm-note)" stroke-width="1.9" stroke-linecap="round"/>
        <path d="M14 3.2c.5 2.2 2.15 3.9 4.35 4.2" stroke="url(#dcm-flag)" stroke-width="1.9" stroke-linecap="round"/>
      </svg>
    </span>`

  const PERSON_SVG = `
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.2"/><path d="M5.5 19c.6-3.4 3.2-5 6.5-5s5.9 1.6 6.5 5" stroke-linecap="round"/>
    </svg>`

  const BELL_SVG = `
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 3.2.7 4.7 1.5 5.6H5c.8-.9 1.5-2.4 1.5-5.6Z" stroke-linejoin="round"/>
      <path d="M10 18.6a2 2 0 0 0 4 0" stroke-linecap="round"/>
    </svg>`

  const SEARCH_SVG = `
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <circle cx="7" cy="7" r="4.3"/><path d="M10.4 10.4 14 14" stroke-linecap="round"/>
    </svg>`

  /** Click a control the site owns but we render elsewhere. */
  const forwardClick = (element) => {
    if (!element) return
    element.click()
  }

  /** The site's own 消息 entry: a div with a label, no href. */
  const siteMessageEntry = () =>
    [...document.querySelectorAll('div')].find(
      (el) => el.children.length <= 1 && (el.textContent || '').trim() === '消息',
    )

  const buildBar = () => {
    // The site's header row stays 56px tall so nothing shifts; its contents are
    // replaced by our bar.
    const headerUi = document.querySelector('.header-ui')
    if (headerUi) {
      for (const column of [...headerUi.children]) {
        if (column.querySelector && column.querySelector('[data-e2e="douyin-navigation"]')) {
          column.classList.add('dcinema-hidden')
        }
      }
    }
    // The site's own header content is left alone: our opaque bar covers it, and
    // keeping it laid out is what lets us forward clicks to it (消息 等).
    const mainCol = headerUi
      ? [...headerUi.children].find((column) => column.querySelector && column.querySelector('[data-e2e="feed-item"]'))
      : null
    const header = mainCol ? mainCol.firstElementChild : null
    if (header) header.classList.add('dcinema-bar-anchor')

    let bar = document.querySelector('.dcinema-bar')
    if (!bar) {
      bar = document.createElement('div')
      bar.className = 'dcinema-bar'
      bar.innerHTML = `
        <div class="dcinema-bar-left">
          <a class="dcinema-brand" href="/?recommend=1" aria-label="抖音">
            ${BRAND_SVG}<span class="dcinema-brand-name">抖音</span>
          </a>
          <span class="dcinema-bar-sep" aria-hidden="true"></span>
          <nav class="dcinema-nav">
            <a href="/?recommend=1" data-route="recommend">推荐</a>
            <a href="/follow" data-route="follow">关注</a>
            <a href="/user/self" data-route="mine">我的</a>
          </nav>
        </div>
        <form class="dcinema-search" role="search">
          ${SEARCH_SVG}
          <input type="search" placeholder="搜索你感兴趣的内容" aria-label="搜索" autocomplete="off" />
          <div class="dcinema-history" hidden>
            <div class="dcinema-history-head">
              <span>搜索历史</span>
              <button type="button" class="dcinema-history-clear" data-act="clear">清除全部</button>
            </div>
            <ul class="dcinema-history-list"></ul>
          </div>
        </form>
        <div class="dcinema-bar-right">
          <div class="dcinema-actions"></div>
          <span class="dcinema-bar-sep" aria-hidden="true"></span>
          <div class="dcinema-account">
            <button type="button" class="dcinema-pill" data-role="message">${BELL_SVG}<span>消息</span></button>
            <a class="dcinema-me" href="/user/self" title="我的">${PERSON_SVG}</a>
          </div>
        </div>`
      document.documentElement.appendChild(bar)

      const form = bar.querySelector('.dcinema-search')
      const input = form.querySelector('input')
      const historyPanel = form.querySelector('.dcinema-history')
      const historyList = form.querySelector('.dcinema-history-list')
      const clearAllButton = form.querySelector('[data-act="clear"]')

      const HISTORY_KEY = 'dcinema:search-history'
      const HISTORY_MAX = 12

      const readHistory = () => {
        try {
          const raw = localStorage.getItem(HISTORY_KEY)
          const parsed = raw ? JSON.parse(raw) : []
          return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string' && entry.trim()) : []
        } catch {
          return []
        }
      }

      const writeHistory = (list) => {
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)))
        } catch {
          /* storage is optional */
        }
      }

      const rememberQuery = (keyword) => {
        const value = String(keyword || '').trim()
        if (!value) return
        const next = [value, ...readHistory().filter((entry) => entry.toLowerCase() !== value.toLowerCase())]
        writeHistory(next)
      }

      const renderHistory = () => {
        const list = readHistory()
        historyList.textContent = ''
        if (list.length === 0) {
          const empty = document.createElement('li')
          empty.className = 'dcinema-history-empty'
          empty.textContent = '暂无搜索历史'
          historyList.appendChild(empty)
          clearAllButton.hidden = true
          return
        }
        clearAllButton.hidden = false
        for (const keyword of list) {
          const item = document.createElement('li')
          item.className = 'dcinema-history-item'

          const link = document.createElement('button')
          link.type = 'button'
          link.className = 'dcinema-history-word'
          link.textContent = keyword
          link.addEventListener('click', () => {
            rememberQuery(keyword)
            location.href = `/search/${encodeURIComponent(keyword)}`
          })

          const remove = document.createElement('button')
          remove.type = 'button'
          remove.className = 'dcinema-history-del'
          remove.title = `删除「${keyword}」`
          remove.setAttribute('aria-label', `删除「${keyword}」`)
          remove.textContent = '×'
          remove.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            writeHistory(readHistory().filter((entry) => entry !== keyword))
            renderHistory()
            if (readHistory().length === 0) historyPanel.hidden = false
          })

          item.append(link, remove)
          historyList.appendChild(item)
        }
      }

      const openHistory = () => {
        renderHistory()
        historyPanel.hidden = false
      }
      const closeHistory = () => {
        historyPanel.hidden = true
      }

      input.addEventListener('focus', openHistory)
      input.addEventListener('click', openHistory)
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeHistory()
      })

      clearAllButton.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        writeHistory([])
        renderHistory()
        historyPanel.hidden = false
        toast('已清空搜索历史', 'ok')
      })

      document.addEventListener('pointerdown', (event) => {
        if (!(event.target instanceof Node)) return
        if (form.contains(event.target)) return
        closeHistory()
      }, true)

      form.addEventListener('submit', (event) => {
        event.preventDefault()
        const keyword = input.value.trim()
        if (!keyword) return
        rememberQuery(keyword)
        closeHistory()
        location.href = `/search/${encodeURIComponent(keyword)}`
      })
      bar.querySelector('[data-role="message"]').addEventListener(
        'click',
        (event) => {
          event.preventDefault()
          // The outer [data-e2e="im-entry"] wrapper is inert: the click handler
          // lives on its inner "something-button" node (verified by toggling the
          // panel through both; only the inner one opens it).
          const target =
            document.querySelector('[data-e2e="im-entry"] [data-e2e="something-button"]') ||
            document.querySelector('[data-e2e="im-entry"]') ||
            siteMessageEntry()?.parentElement
          forwardClick(target)
        },
        true,
      )
    }

    // active route
    const path = location.pathname + location.search
    const route = path.startsWith('/follow')
      ? 'follow'
      : path.startsWith('/user/self')
        ? 'mine'
        : 'recommend'
    for (const link of bar.querySelectorAll('.dcinema-nav a')) {
      link.classList.toggle('on', link.dataset.route === route)
    }

    // The bar exists: drop the first-paint placeholder strip.
    document.documentElement.classList.add('dcinema-ready')
  }
  // ---------------------------------------------------- left nav cleanup
  /** Sidebar entries that stay. Everything else is dropped as a whole row. */
  const KEEP_LEFT_NAV = new Set(['推荐', '关注', '朋友', '我的'])

  /**
   * Hiding only the label leaves the 128×40 hoverable row behind (empty gaps with
   * tooltips). Hide the row box itself so the column collapses.
   */
  const trimLeftNav = () => {
    const nav = document.querySelector('[data-e2e="douyin-navigation"]')
    if (!nav) return
    for (const row of nav.querySelectorAll('div')) {
      const rect = row.getBoundingClientRect()
      // Row boxes are 40px tall and ~128px wide; labels inside are smaller.
      if (rect.height < 30 || rect.height > 60 || rect.width < 90) continue
      const text = (row.textContent || '').trim()
      if (!text || text.length > 6) continue
      if (KEEP_LEFT_NAV.has(text)) continue
      row.classList.add('dcinema-hidden')
    }
  }

  // -------------------------------------------------- player rail cleanup
  /**
   * Hide one entry of the player's vertical rail.
   *
   * The climb is bounded by the rail itself: an earlier version walked up while
   * the ancestor was small, which on the profile grid (cards measured 0x0 before
   * layout) ran past the rail and hid the whole work card — the video then vanished
   * on hover.
   */
  const hideRailItem = (el) => {
    const rail = el.closest('.xg-right-grid, .D0ZulesG, .positionBox, .xgplayer')
    if (!rail || rail === el) return
    let target = el
    while (target.parentElement && target.parentElement !== rail) target = target.parentElement
    if (target === rail) return
    // Never hide anything that owns a work card (profile grid / search results).
    if (target.querySelector('a[href*="/video/"], a[href*="/note/"]')) return
    target.classList.add('dcinema-hidden')
  }

  /**
   * The rail beside the video: 头像 / 点赞 / 评论 / 收藏 / 分享 / 听抖音 / 更多.
   * Keep 头像, 评论, 分享 and 更多; drop 点赞, 收藏 and 听抖音.
   */
  const trimPlayerRail = () => {
    for (const e2e of ['video-player-digg', 'video-player-collect', 'video-play-more']) {
      for (const el of document.querySelectorAll(`[data-e2e="${e2e}"]`)) hideRailItem(el)
    }
    for (const el of document.querySelectorAll('div, span')) {
      if ((el.textContent || '').trim() !== '听抖音') continue
      if (el.children.length > 2) continue
      hideRailItem(el)
    }
  }

  // ------------------------------------------------------- promo cleanup
  /** Hide a leaf and the smallest ancestor box that still looks like one control. */
  const hideSmallBox = (el, maxHeight = 64) => {
    let target = el
    let node = el
    for (let depth = 0; depth < 4 && node.parentElement; depth += 1) {
      const parent = node.parentElement
      const rect = parent.getBoundingClientRect()
      if (rect.height > maxHeight) break
      node = parent
      target = parent
    }
    target.classList.add('dcinema-hidden')
  }

  /**
   * Cross-promotion and AI entry points that add nothing to watching video:
   * - the "AI抖音" floating bubble (`ai-douyin-entry` is a stable class name)
   * - the “下载抖音精选” app promo pinned bottom-left
   * - the “识别画面” button under the author line
   */
  const trimPromo = () => {
    for (const el of document.querySelectorAll('.ai-douyin-entry')) hideSmallBox(el, 80)
    for (const el of document.querySelectorAll('div, span')) {
      const text = (el.textContent || '').trim()
      if (text !== '下载抖音精选' && text !== '识别画面') continue
      if (el.children.length > 2) continue
      hideSmallBox(el, 60)
    }
  }

  // ------------------------------------------------- top-right entry cleanup
  /**
   * The header's right cluster is one flat row of icon entries:
   * 充钻石 / 客户端 / 壁纸 / 通知 / 消息 / 投稿 / 账号. Keep only 消息 and the
   * account (avatar) entry; the row is identified by its text, not by the
   * hashed class names.
   */
  const trimHeaderIcons = () => {
    for (const el of document.querySelectorAll('div')) {
      const text = el.textContent || ''
      if (!text.includes('充钻石') || !text.includes('消息') || !text.includes('投稿')) continue
      const rect = el.getBoundingClientRect()
      if (el.children.length < 4 || rect.width < 100 || rect.width > 420) continue
      for (const child of [...el.children]) {
        const childText = (child.textContent || '').trim()
        const keepMessage = childText === '消息'
        const keepAccount = Boolean(child.querySelector('a[href*="/user/self"]')) || childText.includes('粉丝')
        if (keepMessage || keepAccount) continue
        child.classList.add('dcinema-hidden')
      }
    }
  }

  // ------------------------------------------------------------- url resolve
  const askPage = (timeoutMs = 600) =>
    new Promise((resolve) => {
      const nonce = Math.random().toString(36).slice(2)
      const onMessage = (event) => {
        const data = event.data
        if (!data || data.source !== 'dcinema-page' || data.nonce !== nonce) return
        window.removeEventListener('message', onMessage)
        clearTimeout(timer)
        resolve(data)
      }
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage)
        resolve({ items: [], mediaUrls: [] })
      }, timeoutMs)
      window.addEventListener('message', onMessage)
      window.postMessage({ source: 'dcinema-content', type: 'query', nonce }, '*')
    })

  const harvestRenderData = () => {
    const node = document.getElementById('RENDER_DATA')
    if (!node) return []
    let data
    try {
      data = JSON.parse(decodeURIComponent(node.textContent))
    } catch {
      return []
    }
    const found = []
    const walk = (value, depth = 0) => {
      if (!value || depth > 8) return
      if (Array.isArray(value)) {
        value.forEach((entry) => walk(entry, depth + 1))
        return
      }
      if (typeof value !== 'object') return
      const playAddr = value.playAddr || value.play_addr
      const src = Array.isArray(playAddr) ? playAddr[0]?.src : playAddr?.url_list?.[0]
      if (typeof src === 'string' && src) {
        found.push({ playUrl: src.replace(/^\/\//, 'https:').replace(/^https:\/\/\//, 'https://'), desc: value.desc || '' })
      }
      Object.values(value).forEach((entry) => walk(entry, depth + 1))
    }
    walk(data)
    return found
  }

  /** The id of the video that is actually on screen, read from its container class. */
  const activeAwemeId = () => {
    const onScreen = [...document.querySelectorAll('video')].find((node) => {
      const rect = node.getBoundingClientRect()
      return rect.height > 100 && rect.top >= 0 && rect.top < innerHeight
    })
    const candidates = [document.querySelector('[data-e2e="feed-active-video"]'), onScreen].filter(Boolean)
    for (const node of candidates) {
      let current = node
      for (let depth = 0; current && depth < 10; depth += 1) {
        const match = String(current.className || '').match(/(?:video|note|image|aweme)_(\d+)/)
        if (match) return match[1]
        current = current.parentElement
      }
    }
    // Detail routes carry the id in the path; search modals carry modal_id.
    const fromPath = location.pathname.match(/\/(?:video|note)\/(\d+)/)
    if (fromPath) return fromPath[1]
    return new URL(location.href).searchParams.get('modal_id') || ''
  }

  /** `note` when the current page/item is an image post, `video` otherwise. */
  const currentKind = () => (location.pathname.startsWith('/note/') ? 'note' : 'video')

  /** True when there is something on screen the bar can act on. */
  const hasActiveItem = () => Boolean(visibleVideo()) || Boolean(activeAwemeId())

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * Play a candidate silently off-screen and read the decoded track counters.
   * This is what catches "wrong video" (video width/height of another clip) and
   * "silent file" (no audio bytes at all) before anything reaches the disk.
   */
  const probeCandidate = async (url) => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0'
    video.src = url
    document.documentElement.appendChild(video)
    try {
      await Promise.race([
        new Promise((resolve) => {
          video.onloadedmetadata = resolve
          video.onerror = resolve
        }),
        sleep(4000),
      ])
      const hasVideo = video.videoWidth > 0
      let hasAudio = false
      if (hasVideo) {
        try {
          await video.play()
        } catch {
          /* autoplay may be blocked; the counters stay 0 */
        }
        await sleep(700)
        hasAudio = (video.webkitAudioDecodedByteCount ?? 0) > 0
      }
      return {
        ok: hasVideo,
        hasVideo,
        hasAudio,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: Number((video.duration || 0).toFixed(2)),
      }
    } catch {
      return { ok: false, hasVideo: false, hasAudio: false }
    } finally {
      try {
        video.pause()
        video.removeAttribute('src')
        video.load()
        video.remove()
      } catch {
        /* already gone */
      }
    }
  }

  async function resolveSource() {
    const video = visibleVideo()
    const title = titleOf(video)

    const fromPage = await askPage()
    const awemeId =
      new URL(location.href).searchParams.get('modal_id') ||
      (location.pathname.match(/\/video\/(\d+)/) || [])[1] ||
      ''

    const candidates = []
    const items = fromPage.items || []
    const id = awemeId || activeAwemeId()

    // 1) The on-screen video, matched by its aweme id: the only source that is
    //    both the right clip and a muxed (audio + video) file.
    if (id) {
      const byId = items.find((item) => item.awemeId === id)
      if (byId) candidates.push({ url: byId.playUrl, title: byId.desc || title })
    }
    // 2) Otherwise the item whose description matches what is on screen.
    if (title) {
      const byTitle = items.find((item) => item.desc && title.includes(item.desc.slice(0, 10)))
      if (byTitle && !candidates.some((entry) => entry.url === byTitle.playUrl)) {
        candidates.push({ url: byTitle.playUrl, title: byTitle.desc || title })
      }
    }
    // 3) Any aweme JSON candidate.
    for (const item of items) {
      if (item.playUrl) candidates.push({ url: item.playUrl, title: item.desc || title })
    }
    // 4) Last resort: raw CDN requests seen in the page (may be another clip or
    //    a silent preload variant, so it is only tried after everything else).
    for (const url of fromPage.mediaUrls || []) candidates.push({ url, title })

    if (video) {
      const current = video.v.currentSrc
      if (current && /^https?:/.test(current)) candidates.push({ url: current, title })
      for (const source of video.v.querySelectorAll('source')) {
        const src = source.getAttribute('src')
        if (src && /^https?:/.test(src)) candidates.push({ url: src, title })
      }
    }

    for (const entry of harvestRenderData()) candidates.push({ url: entry.playUrl, title: entry.desc || title })

    const seen = new Set()
    const unique = []
    for (const candidate of candidates) {
      if (!candidate.url || seen.has(candidate.url)) continue
      seen.add(candidate.url)
      unique.push(candidate)
    }
    return unique
  }

  // ---------------------------------------------------------------- download
  let busy = false

  /**
   * Image notes have no mp4: the watermark-free assets live in the aweme JSON as
   * `images[].url_list`, with a DOM fallback (widest variant of each picture).
   */
  const resolveNoteImages = async () => {
    const id = activeAwemeId()
    const fromPage = await askPage()
    const item = (fromPage.items || []).find(
      (entry) => entry.awemeId === id && Array.isArray(entry.imageUrls) && entry.imageUrls.length > 0,
    )
    if (item) return { title: item.desc || item.author || 'note', images: item.imageUrls }

    if (currentKind() !== 'note') return null

    // Scope matters: the note's own gallery lives in [data-e2e="note-detail"].
    // Each slide renders the picture twice (plus a blurred backdrop), so dedupe
    // by path and keep the widest variant.
    const scope =
      document.querySelector('[data-e2e="note-detail"]') ||
      document.querySelector('[data-e2e="feed-active-video"]') ||
      document
    const widest = new Map()
    for (const img of scope.querySelectorAll('img')) {
      const src = img.getAttribute('src') || ''
      if (!/douyinpic|byteimg/.test(src)) continue
      const rect = img.getBoundingClientRect()
      if (rect.width < 380) continue
      const key = src.split('?')[0].split('/').pop().slice(0, 48)
      const previous = widest.get(key)
      if (!previous || rect.width > previous.width) {
        widest.set(key, { src: src.replace(/^\/\//, 'https://'), width: rect.width })
      }
    }
    const images = [...widest.values()].map((entry) => entry.src)
    if (images.length === 0) return null

    const heading =
      scope.querySelector('h1')?.textContent?.trim() ||
      [...scope.querySelectorAll('p, span')]
        .map((el) => (el.children.length === 0 ? (el.textContent || '').trim() : ''))
        .find((text) => text.length > 8) ||
      ''
    const title = (document.title || '').replace(/ - 抖音.*$/, '').trim() || heading || 'note'
    return { title, images }
  }

  const downloadNoteImages = async (note) => {
    let started = 0
    for (const [index, url] of note.images.entries()) {
      // Note pictures are served as .webp today; keep the real extension.
      const extension = /\.webp(\?|$)/i.test(url) ? 'webp' : 'jpg'
      const response = await sendDownloadMessage({
        type: 'download',
        url,
        title: `${note.title}-${index + 1}`,
        index: index + 1,
        ext: extension,
        quiet: true,
      })
      if (response && response.ok) started += 1
    }
    if (started > 0) {
      toast(`已开始下载 ${started} 张图片`, 'ok')
      return true
    }
    return false
  }

  /**
   * Browser-native download: a hidden 1×1 iframe navigates to the CDN URL while
   * the `download` ruleset adds the Referer the CDN wants and rewrites the
   * response to an attachment. Nothing is fetched into JS memory and no CORS
   * preflight is involved, which is why this works where `fetch` did not.
   */
  const startFrameDownload = async (url, title) => {
    let prepared = null
    try {
      prepared = await chrome.runtime.sendMessage({ type: 'prepare-download', url, title })
    } catch {
      prepared = null
    }

    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('tabindex', '-1')
    frame.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;border:0'
    frame.src = url
    document.documentElement.appendChild(frame)
    setTimeout(() => {
      try {
        frame.src = 'about:blank'
      } catch {
        /* already detaching */
      }
      frame.remove()
    }, 15000)

    return { ok: Boolean(prepared && prepared.ok), filename: (prepared && prepared.filename) || '' }
  }

  /** sendMessage that never throws when the extension context was reloaded. */
  const sendDownloadMessage = async (payload) => {
    try {
      return await chrome.runtime.sendMessage(payload)
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  }

  /** Completion / failure toasts, pushed from the service worker. */
  const describeBytes = (bytes) => {
    const value = Number(bytes) || 0
    if (value <= 0) return ''
    if (value >= 1048576) return `（${(value / 1048576).toFixed(1)} MB）`
    return `（${Math.max(1, Math.round(value / 1024))} KB）`
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'download-state') return
      if (message.state === 'complete') {
        toast(`下载完成：${message.filename}${describeBytes(message.bytes)}`, 'ok')
      } else if (message.state === 'interrupted') {
        toast(`下载失败：${message.filename}（${message.error || '已中断'}）`, 'warn')
      }
    })
  } catch {
    /* the page may be out of the extension's context */
  }

  const doDownload = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (busy) {
      toast('上一段下载还在进行中', 'info')
      return
    }
    busy = true
    const button = event.currentTarget
    button.classList.add('busy')

    try {
      // Image notes first: they have pictures, not a stream.
      const note = await resolveNoteImages()
      if (note) {
        const ok = await downloadNoteImages(note)
        if (!ok) toast('图片下载失败：地址可能已过期，请刷新后重试', 'warn')
        return
      }

      const candidates = await resolveSource()
      if (candidates.length === 0) {
        toast('取不到视频地址：请先让这条视频播放一下再点下载', 'warn')
        return
      }

      toast('正在校验视频轨与音轨…', 'info')

      let candidate = null
      let silentFallback = null
      for (const entry of candidates.slice(0, 3)) {
        const probe = await probeCandidate(entry.url)
        if (!probe.ok) continue
        if (probe.hasVideo && probe.hasAudio) {
          candidate = entry
          break
        }
        if (probe.hasVideo && !silentFallback) silentFallback = entry
      }
      if (!candidate) candidate = silentFallback
      if (!candidate) {
        toast('这些地址都没能解码出画面，请让视频播放几秒后再试', 'warn')
        return
      }

      // Preferred: a real browser download — it shows up in Chrome's download
      // bubble, streams to disk and reports completion back to this tab.
      const direct = await sendDownloadMessage({
        url: candidate.url,
        title: candidate.title,
        ext: 'mp4',
      })
      if (direct && direct.ok) {
        toast(`已开始下载：${direct.filename}`, 'ok')
        return
      }

      // Fallback: hidden iframe with the DNR content-disposition rewrite.
      const framed = await startFrameDownload(candidate.url, candidate.title)
      if (framed.ok) {
        toast(`已开始下载：${framed.filename}`, 'ok')
        return
      }

      toast(`下载失败：${(direct && direct.error) || '未知错误'}`, 'warn')
    } catch (error) {
      toast(`下载失败：${String((error && error.message) || error)}`, 'warn')
    } finally {
      busy = false
      button.classList.remove('busy')
    }
  }
  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 4.5v10" stroke-linecap="round"/><path d="m8 10.8 4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 19h13" stroke-linecap="round"/></svg>'

  const makeButton = () => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dcinema-dl dcinema-pill'
    button.title = '下载无水印视频'
    button.innerHTML = `${ICON_DOWNLOAD}<span>下载</span>`
    button.addEventListener('click', doDownload, true)
    return button
  }

  /**
   * Exactly one download button, inside the rail of the video that is actually
   * on screen. Pages without a playing video (朋友, 关注, 我的, search, profile)
   * get none, and stale buttons left on other slides are removed.
   */
  /** Only one download button, and it belongs to the top bar action cluster. */
  const injectButtons = () => {
    const cluster = document.querySelector('.dcinema-actions')
    for (const button of document.querySelectorAll('.dcinema-dl')) {
      if (!cluster || !cluster.contains(button)) button.remove()
    }
    if (!cluster) return
    // Offer the download whenever there is something on screen to save (a video
    // or an image note).
    if (!hasActiveItem()) {
      for (const button of cluster.querySelectorAll('.dcinema-dl')) button.remove()
      return
    }
    if (cluster.querySelector('.dcinema-dl')) return
    cluster.appendChild(makeButton())
  }

  // ------------------------------------------------------------------- boot
  const HEAVY_INTERVAL_MS = 400
  let lastHeavyAt = 0

  const boot = () => {
    installSeekFix()
    bridgeImRowPress()
    document.documentElement.classList.add('dcinema')

    let pending = null
    let lightPending = false

    /**
     * Two tiers. The page mutates roughly 20 times per second, and a full text
     * sweep costs ~1.1 ms over 1200+ elements, so running every sweep on every
     * batch would burn a few percent of the main thread during scrolling.
     *
     * Light work (our own bar and buttons) stays per-frame because it is cheap
     * and must feel instant; the document-wide sweeps are throttled.
     */
    const runHeavy = () => {
      const now = performance.now()
      if (now - lastHeavyAt < HEAVY_INTERVAL_MS) return
      lastHeavyAt = now
      trimChrome()
      trimPlayerRail()
      trimPromo()
      trimLeftNav()
    }

    const runLight = () => {
      lightPending = false
      if (document.hidden) return
      buildBar()
      renderBarActions()
      trimHeaderIcons()
      trimPlayerMenu()
      fitVideos()
      injectButtons()
      runHeavy()
    }

    const schedule = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = null
        if (lightPending) return
        lightPending = true
        if (typeof requestIdleCallback === 'function') requestIdleCallback(runLight, { timeout: 200 })
        else setTimeout(runLight, 0)
      })
    }

    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    setInterval(schedule, 3000)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        lastHeavyAt = 0
        schedule()
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
