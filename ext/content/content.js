/**
 * Douyin Cinema UI — content script (minimal build).
 *
 * Philosophy: leave douyin.com looking like douyin.com. This script adds exactly
 * three things and nothing else:
 *
 * 1. 详情 / 下载 buttons, appended to the player's own control bar so they inherit
 *    the site's styling and position. On pages without a player (an image note)
 *    they float in the bottom-right corner instead.
 * 2. A seek fallback: the site's click-to-seek gesture is broken in some builds.
 *    Every click on the progress bar is measured; only when the site failed to
 *    move the playhead does this script perform the seek itself.
 * 3. The download pipeline (see background.js) — the buttons are meaningless
 *    without it.
 *
 * Everything that used to rewrite the page (custom top bar, hidden entries,
 * sidebar removal, video fitting) has been removed on purpose.
 */

(() => {
  const FLAG = '__dcinemaContent'
  if (window[FLAG]) return
  window[FLAG] = true
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

  /** Guards against a second click while a download is being prepared. */
  let busy = false

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
  // Icons follow douyin's own header glyphs: a 24x24 viewBox rendered at 22px,
  // solid `currentColor` fills (their glyphs are filled outlines, not strokes), so
  // the pair reads at the same visual weight as 充钻石 / 通知 / 投稿.
  const ICON_DETAIL =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M7.25 3.5h7.1a2.5 2.5 0 0 1 1.77.73l1.65 1.65a2.5 2.5 0 0 1 .73 1.77v10.6a2.25 2.25 0 0 1-2.25 2.25h-9A2.25 2.25 0 0 1 5 18.25V5.75A2.25 2.25 0 0 1 7.25 3.5Zm0 2A.25.25 0 0 0 7 5.75v12.5c0 .14.11.25.25.25h9c.14 0 .25-.11.25-.25V9.3h-2.8a1.25 1.25 0 0 1-1.25-1.25V5.5H7.25Z"/><path fill="currentColor" d="M8.6 12.2a1 1 0 0 1 1-1h4.8a1 1 0 1 1 0 2H9.6a1 1 0 0 1-1-1Zm0 3.4a1 1 0 0 1 1-1h3.2a1 1 0 1 1 0 2H9.6a1 1 0 0 1-1-1Z"/></svg>'
  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true"><path fill="currentColor" d="M12 3.2a1 1 0 0 1 1 1v8.1l2.3-2.3a1 1 0 1 1 1.42 1.42l-4.01 4.01a1 1 0 0 1-1.42 0L7.28 11.4a1 1 0 0 1 1.42-1.42L11 12.3V4.2a1 1 0 0 1 1-1Z"/><path fill="currentColor" d="M4.4 14.4a1 1 0 0 1 2 0v3.1c0 .5.4.9.9.9h9.4c.5 0 .9-.4.9-.9v-3.1a1 1 0 1 1 2 0v3.1a2.9 2.9 0 0 1-2.9 2.9H7.3a2.9 2.9 0 0 1-2.9-2.9v-3.1Z"/></svg>'
  const makeButton = () => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dcinema-dl dcinema-native-item'
    button.title = '下载无水印视频'
    button.innerHTML = `${ICON_DOWNLOAD}<span>下载</span>`
    button.addEventListener('click', doDownload, true)
    return button
  }

  // ------------------------------------------------------------ seek/buttons glue
  const fmt = (seconds) => {
    if (!Number.isFinite(seconds)) return '00:00'
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  }

  // ------------------------------------------------------- seek fallback
  /**
   * Measured, not assumed: after each click on the progress bar we wait a beat and
   * compare the playhead against where it would be from ordinary playback. Only a
   * "no movement" click is replayed by us, and once the site proves broken the
   * fallback runs immediately on later clicks.
   */
  const SEEK_CHECK_MS = 240

  const installSeekFallback = () => {
    let siteSeekBroken = false

    document.addEventListener(
      'pointerdown',
      (event) => {
        const track = event.target instanceof Element ? event.target.closest('xg-progress') : null
        if (!track) return
        const current = visibleVideo()
        if (!current) return
        const video = current.v
        const duration = video.duration
        if (!Number.isFinite(duration) || duration <= 0) return

        const rect = track.getBoundingClientRect()
        if (!rect.width) return
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
        const target = ratio * duration

        const seek = () => {
          video.currentTime = target
          const played = track.querySelector('.xgplayer-progress-played')
          if (played) played.style.width = `${(ratio * 100).toFixed(2)}%`
          const knob = track.querySelector('.xgplayer-progress-btn, xg-progress-btn')
          if (knob) knob.style.left = `${(ratio * 100).toFixed(2)}%`
          toast(`跳转至 ${fmt(target)}`, 'info')
        }

        // Once known broken, act immediately — no perceptible delay.
        if (siteSeekBroken) {
          seek()
          return
        }

        const before = video.currentTime
        const expectedDelta = video.paused ? 0 : (SEEK_CHECK_MS / 1000) * (video.playbackRate || 1)
        setTimeout(() => {
          const delta = video.currentTime - before
          if (Math.abs(delta - expectedDelta) > 0.18) return // the site seeked
          siteSeekBroken = true
          seek()
        }, SEEK_CHECK_MS)
      },
      true,
    )
  }

  // ------------------------------------------------------- header actions
  /**
   * The buttons live in douyin's own header, right-aligned like the 消息 entry.
   * They stay mounted and are disabled instead of disappearing, so the header does
   * not reflow every time a feed item leaves or enters the viewport; gating is the
   * same for 详情 and 下载: no active video/note, no action.
   */
  const ACTIONS_CLASS = 'dcinema-header-actions'

  /**
   * The header row is the first child of the main column, and it is a plain block
   * (not a flex row), so the buttons are absolutely positioned just left of
   * douyin's own entry cluster — that keeps them inside the 56px header without
   * touching the site's layout.
   */
  const siteHeaderRow = () => {
    const layout = document.querySelector('.header-ui')
    if (!layout) return null
    const main = [...layout.children].find(
      (node) => !node.querySelector('[data-e2e="douyin-navigation"]') && getComputedStyle(node).display === 'flex',
    )
    return (main && main.firstElementChild) || null
  }

  /**
   * Left edge of the entry cluster that holds 消息 / 投稿, in viewport px.
   *
   * Walking up to the row's direct child is wrong: that child spans the whole
   * header, which would place our buttons at the far left. Stop as soon as the
   * ancestor is no longer clearly narrower than the row — that is the cluster.
   */
  const clusterLeftOf = (row) => {
    const entry = document.querySelector('[data-e2e="im-entry"]')
    if (!entry || !row.contains(entry)) return null
    const rowWidth = row.getBoundingClientRect().width || 1
    let node = entry
    while (node.parentElement && row.contains(node.parentElement) && node.parentElement.getBoundingClientRect().width < rowWidth * 0.6) {
      node = node.parentElement
    }
    return node.getBoundingClientRect().left
  }

  const ensureActions = () => {
    const row = siteHeaderRow()
    if (!row) return null

    let group = document.querySelector('.' + ACTIONS_CLASS)
    if (!group) {
      group = document.createElement('div')
      group.className = ACTIONS_CLASS
      group.appendChild(makeDetailButton())
      group.appendChild(makeButton())
    }
    if (group.parentElement !== row) row.appendChild(group)
    row.classList.add('dcinema-header-row')
    if (getComputedStyle(row).position === 'static') row.style.position = 'relative'

    // Sit immediately left of the site's cluster; fall back to a small inset.
    const rowRect = row.getBoundingClientRect()
    const clusterLeft = clusterLeftOf(row)
    const gap = clusterLeft == null ? 8 : Math.max(8, Math.round(rowRect.right - clusterLeft))
    group.style.right = `${gap}px`
    return group
  }

  const setActionsEnabled = (group, enabled) => {
    for (const button of group.querySelectorAll('button')) {
      button.disabled = !enabled
      button.classList.toggle('is-idle', !enabled)
      if (!enabled) button.title = '先让一条视频或图文出现在画面上'
    }
    if (enabled) {
      const detail = group.querySelector('.dcinema-detail')
      const download = group.querySelector('.dcinema-dl')
      if (detail) detail.title = '进入详情页'
      if (download) download.title = '下载无水印视频'
    }
  }

  const injectActions = () => {
    const group = ensureActions()
    if (!group) return
    setActionsEnabled(group, hasActiveItem())
  }
  // ------------------------------------------------------ sidebar toggle
  const SIDEBAR_KEY = 'dcinema:sidebar-collapsed'
  const COLLAPSED_CLASS = 'dcinema-sidebar-collapsed'

  /** The direct child of `.header-ui` that owns the navigation column. */
  const sidebarColumn = () => {
    const layout = document.querySelector('.header-ui')
    const nav = document.querySelector('[data-e2e="douyin-navigation"]')
    if (!layout || !nav) return null
    let node = nav
    while (node && node.parentElement !== layout) node = node.parentElement
    return node && node.parentElement === layout ? node : null
  }

  const readCollapsed = () => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1'
    } catch {
      return false
    }
  }

  const writeCollapsed = (collapsed) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
    } catch {
      /* storage is optional */
    }
  }

  /** Panel-with-arrow: collapse (arrow pointing into the panel) / expand. */
  const ICON_SIDEBAR_COLLAPSE =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15" stroke-linecap="round"/><path d="m16.5 9.5-3 2.5 3 2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const ICON_SIDEBAR_EXPAND =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15" stroke-linecap="round"/><path d="m13 9.5 3 2.5-3 2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  /** Icon + label follow the collapsed state; cheap enough to call every tick. */
  const renderToggle = (button, collapsed) => {
    button.dataset.collapsed = collapsed ? '1' : '0'
    // Native entries are 32px wide, so the visible label stays two characters;
    // the tooltip keeps the full sentence.
    const label = collapsed ? '展开' : '收起'
    const title = collapsed ? '展开侧栏' : '收起侧栏'
    if (button.dataset.label === label) return
    button.dataset.label = label
    button.title = title
    button.setAttribute('aria-label', title)
    button.innerHTML = `${collapsed ? ICON_SIDEBAR_EXPAND : ICON_SIDEBAR_COLLAPSE}<span>${label}</span>`
  }


  const applySidebarState = (collapsed) => {
    document.documentElement.classList.toggle(COLLAPSED_CLASS, collapsed)
    const column = sidebarColumn()
    if (column) column.classList.add('dcinema-sidebar')
    const button = document.querySelector('.dcinema-sidebar-toggle')
    if (button) renderToggle(button, collapsed)
    return collapsed
  }

  /**
   * The toggle lives in the header row, left of the search field: putting it over
   * the video covered the picture, and the header is where douyin keeps its own
   * controls anyway.
   */
  const mountSidebarToggle = () => {
    const column = sidebarColumn()
    const row = siteHeaderRow()
    if (!column || !row) return
    column.classList.add('dcinema-sidebar')

    let button = row.querySelector('.dcinema-sidebar-toggle')
    if (!button) {
      const existing = document.querySelector('.dcinema-sidebar-toggle')
      if (existing) existing.remove()
      button = document.createElement('button')
      button.type = 'button'
      button.className = 'dcinema-sidebar-toggle dcinema-native-item'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const next = !document.documentElement.classList.contains(COLLAPSED_CLASS)
        writeCollapsed(next)
        applySidebarState(next)
      })
      row.appendChild(button)
    }
    applySidebarState(document.documentElement.classList.contains(COLLAPSED_CLASS))
  }

  // --------------------------------------------------------------- boot
  const boot = () => {
    document.documentElement.classList.add('dcinema')
    installSeekFallback()

    let pending = null
    let scheduled = false
    const run = () => {
      scheduled = false
      if (document.hidden) return
      injectActions()
      mountSidebarToggle()
    }
    const schedule = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = null
        if (scheduled) return
        scheduled = true
        if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 200 })
        else setTimeout(run, 0)
      })
    }

    schedule()
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
    setInterval(schedule, 3000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()