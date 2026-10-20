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
  const HIDE_AFFORDANCE = /点赞|收藏|喜欢|like|collect|favorite/i

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
  const trimChrome = () => {
    for (const el of document.querySelectorAll('a, div, span, li, p')) {
      if (el.children.length > 0) continue
      const text = (el.textContent || '').trim()
      if (!text) continue
      if (HIDE_NAV_TEXT.has(text)) (el.closest('a, li') || el).classList.add('dcinema-hidden')
    }
    for (const el of document.querySelectorAll('[data-e2e], [aria-label], [title]')) {
      const probe = `${el.getAttribute('data-e2e') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
      if (!HIDE_AFFORDANCE.test(probe)) continue
      if (/^(收藏|点赞)$/.test((el.textContent || '').trim()) || /like|collect|favorite/i.test(el.getAttribute('data-e2e') || '')) {
        ;(el.closest('[data-e2e], button, a') || el).classList.add('dcinema-hidden')
      }
    }
  }

  // --------------------------------------------------- video fit
  /**
   * Fill the width for landscape clips (a small top/bottom crop) but keep
   * portrait clips whole — cover on a 9:16 video would show less than a third
   * of the frame.
   */
  const fitVideo = (video) => {
    const width = video.videoWidth || 0
    const height = video.videoHeight || 0
    if (!width || !height) return
    const ratio = width / height
    const mode = ratio >= 1.2 ? 'cover' : 'contain'
    if (video.style.objectFit !== mode) video.style.objectFit = mode
    video.style.objectPosition = 'center center'
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
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        const keyword = input.value.trim()
        if (!keyword) return
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
  // ------------------------------------------------------- loop control
  /**
   * A "循环" switch in the player's own control bar. It clones the 连播 entry so it
   * inherits the site's switch markup and styling, then swaps the label and binds
   * its own behaviour: toggling `video.loop` for every video element, off by
   * default, re-applied when the player swaps videos.
   */
  let loopEnabled = false

  const applyLoop = () => {
    for (const video of document.querySelectorAll('video')) {
      if (video.loop !== loopEnabled) video.loop = loopEnabled
    }
  }

  const buildLoopControl = (anchor) => {
    const node = anchor.cloneNode(true)
    node.classList.add('dcinema-loop')
    for (const element of [node, ...node.querySelectorAll('*')]) {
      element.removeAttribute('data-e2e')
      element.removeAttribute('data-e2e-state')
    }

    const title = node.querySelector('.xgplayer-setting-title')
    if (title) title.textContent = '循环'

    // The clone carries the autoplay tooltip ("自动连播 K"); replace it.
    const tips = node.querySelector('.xgTips')
    if (tips) {
      tips.textContent = ''
      const label = document.createElement('span')
      label.textContent = '循环播放'
      tips.appendChild(label)
    }

    const switchNode = node.querySelector('button.xg-switch')
    if (switchNode) {
      switchNode.setAttribute('aria-checked', 'false')
      switchNode.setAttribute('aria-label', '循环播放')
    }

    node.addEventListener(
      'click',
      (event) => {
        event.preventDefault()
        event.stopPropagation()
        loopEnabled = !loopEnabled
        if (switchNode) switchNode.setAttribute('aria-checked', String(loopEnabled))
        applyLoop()
        toast(loopEnabled ? '已开启循环播放' : '已关闭循环播放', loopEnabled ? 'ok' : 'info')
      },
      true,
    )
    return node
  }

  const installLoopControl = () => {
    const controls = document.querySelector('.xg-right-grid')
    if (!controls) return
    if (controls.querySelector('.dcinema-loop')) {
      applyLoop()
      return
    }
    const anchor = controls.querySelector('.xgplayer-autoplay-setting')
    if (!anchor) return
    anchor.insertAdjacentElement('afterend', buildLoopControl(anchor))
    applyLoop()
  }

  // A freshly mounted video must inherit the current state.
  document.addEventListener(
    'play',
    (event) => {
      const video = event.target
      if (video instanceof HTMLVideoElement && video.loop !== loopEnabled) video.loop = loopEnabled
    },
    true,
  )
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
  /** Hide one item of the vertical action rail: climb to its own small box. */
  const hideRailItem = (el) => {
    let target = el
    let node = el
    for (let depth = 0; depth < 4 && node.parentElement; depth += 1) {
      node = node.parentElement
      const rect = node.getBoundingClientRect()
      if (rect.height > 110 || rect.width > 80) break
      target = node
    }
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
      const response = await chrome.runtime.sendMessage({
        type: 'download',
        url,
        title: `${note.title}-${index + 1}`,
        index: index + 1,
        ext: extension,
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

      const result = await startFrameDownload(candidate.url, candidate.title)
      if (result.ok) {
        toast(`已开始下载：${result.filename}`, 'ok')
        return
      }

      const fallback = await chrome.runtime.sendMessage({
        type: 'download',
        url: candidate.url,
        title: candidate.title,
      })
      if (fallback && fallback.ok) {
        toast(`已开始下载：${fallback.filename}`, 'ok')
        return
      }
      toast(`下载失败：${(fallback && fallback.error) || '未知错误'}`, 'warn')
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
  const boot = () => {
    installSeekFix()
    document.documentElement.classList.add('dcinema')
    let pending = null
    const schedule = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = null
        trimChrome()
        trimHeaderIcons()
        trimPlayerRail()
        trimPromo()
        installLoopControl()
        trimLeftNav()
        buildBar()
        renderBarActions()
        trimPlayerMenu()
        fitVideos()
        injectButtons()
      })
    }
    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    setInterval(schedule, 3000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
