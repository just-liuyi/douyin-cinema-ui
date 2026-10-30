/**
 * Douyin Cinema UI — content script (minimal build).
 *
 * Philosophy: leave douyin.com looking like douyin.com. This isolated-world script
 * only adds:
 *
 * 1. 详情 / 下载, stacked in the top-right corner of the playback area
 *    (`.basePlayerContainer`), for videos and image notes alike.
 * 2. The sidebar collapse toggle in the header, left of the search field.
 * 3. The settings bridge: side-panel preferences (chrome.storage) are mirrored onto
 *    <html data-dcinema-*> for the MAIN-world hook, and its seek detection results
 *    are stored back for the side panel.
 * 4. The download pipeline (see background.js).
 *
 * Progress-bar seeking, detection and chapter hints live in page-hook.js, the only
 * place that can reach douyin's player object.
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
  /** Jumps to the standalone page for the video that is on screen. */
  const makeDetailButton = () => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dcinema-detail dcinema-rail-btn'
    button.title = '进入详情页'
    button.setAttribute('aria-label', '进入详情页')
    button.innerHTML = ICON_DETAIL
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
  // Solid white glyphs in the style of douyin's 点赞 / 收藏 rail icons: one filled
  // shape per icon, details cut out with evenodd, rendered at the same size.
  const ICON_DETAIL =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M7 2.8h6.6c.5 0 .98.2 1.33.55l3.92 3.92c.35.35.55.83.55 1.33V19a2.2 2.2 0 0 1-2.2 2.2H7A2.2 2.2 0 0 1 4.8 19V5A2.2 2.2 0 0 1 7 2.8Zm7.4 1.6v3.2h3.2l-3.2-3.2ZM8.6 11.9h6.8a.9.9 0 0 1 0 1.8H8.6a.9.9 0 0 1 0-1.8Zm0 3.6h4.4a.9.9 0 0 1 0 1.8H8.6a.9.9 0 0 1 0-1.8Z"/></svg>'
  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true"><path fill="currentColor" d="M10.6 3.6a1.4 1.4 0 0 1 2.8 0v7.1h2.9a1 1 0 0 1 .74 1.67l-4.3 4.75a1 1 0 0 1-1.48 0l-4.3-4.75a1 1 0 0 1 .74-1.67h2.9V3.6Z"/><path fill="currentColor" d="M3.5 15.2a1.5 1.5 0 0 1 3 0v2.3c0 .28.22.5.5.5h10c.28 0 .5-.22.5-.5v-2.3a1.5 1.5 0 0 1 3 0v2.3a3.5 3.5 0 0 1-3.5 3.5H7a3.5 3.5 0 0 1-3.5-3.5v-2.3Z"/></svg>'
  const makeButton = () => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dcinema-dl dcinema-rail-btn'
    button.title = '下载无水印视频'
    button.setAttribute('aria-label', '下载')
    button.innerHTML = ICON_DOWNLOAD
    button.addEventListener('click', doDownload, true)
    return button
  }

  // -------------------------------------------------------- stage actions
  /**
   * 详情 / 下载 sit in the top-right corner of the playback area, stacked
   * vertically, for videos and image notes alike. The playback area is douyin's
   * `.basePlayerContainer` (feed slides, video detail, note detail all use it);
   * the feed keeps several of them mounted, so the one covering most of the
   * viewport is the current one.
   */
  const STAGE_CLASS = 'dcinema-stage-actions'

  /** The header row (first child of the main column); used by the sidebar toggle. */
  const siteHeaderRow = () => {
    const layout = document.querySelector('.header-ui')
    if (!layout) return null
    const main = [...layout.children].find(
      (node) => !node.querySelector('[data-e2e="douyin-navigation"]') && getComputedStyle(node).display === 'flex',
    )
    return (main && main.firstElementChild) || null
  }

  const visibleArea = (el) => {
    const rect = el.getBoundingClientRect()
    const w = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)
    const h = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0)
    return w > 0 && h > 0 ? w * h : 0
  }

  const stageHost = () => {
    let best = null
    let bestArea = 0
    // Document order puts ancestors first; `>=` lets the inner container win a tie.
    for (const el of document.querySelectorAll('[data-e2e="player-container"], .basePlayerContainer')) {
      const area = visibleArea(el)
      if (area >= bestArea && area > 0) {
        best = el
        bestArea = area
      }
    }
    if (best && bestArea > 60000) return best
    // Older layouts: fall back to the on-screen player itself.
    const current = visibleVideo()
    return current ? current.v.closest('.douyin-player, .xgplayer') : null
  }

  /** On /video/<id> or /note/<id> for the item on screen, 详情 would just reload. */
  const onOwnDetailPage = () => {
    const match = location.pathname.match(/^\/(?:video|note)\/(\d+)/)
    return Boolean(match && match[1] === activeAwemeId())
  }

  const injectActions = () => {
    // The header placement is gone; drop copies left by an older build.
    for (const stale of document.querySelectorAll('.dcinema-header-actions')) stale.remove()

    const host = hasActiveItem() ? stageHost() : null
    let group = document.querySelector('.' + STAGE_CLASS)
    if (!host) {
      if (group) group.remove()
      return
    }
    if (!group) {
      group = document.createElement('div')
      group.className = STAGE_CLASS
      group.appendChild(makeDetailButton())
      group.appendChild(makeButton())
      // Squash-and-stretch on press, like douyin's 点赞; restart it on every press.
      group.addEventListener(
        'pointerdown',
        (event) => {
          const button = event.target instanceof Element ? event.target.closest('.dcinema-rail-btn') : null
          if (!button) return
          button.classList.remove('dc-bounce')
          void button.offsetWidth
          button.classList.add('dc-bounce')
        },
        true,
      )
      // The animation runs on the inner <svg>, so its end event targets the svg.
      group.addEventListener('animationend', (event) => {
        if (event.animationName !== 'dcinema-rail-bounce' || !(event.target instanceof Element)) return
        const button = event.target.closest('.dcinema-rail-btn')
        if (button) button.classList.remove('dc-bounce')
      })
    }
    if (group.parentElement !== host) host.appendChild(group)
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative'

    const detail = group.querySelector('.dcinema-detail')
    if (detail) detail.hidden = onOwnDetailPage()
    const download = group.querySelector('.dcinema-dl')
    if (download) download.title = currentKind() === 'note' ? '下载图文原图' : '下载无水印视频'
  }

  // ------------------------------------------------------------- settings
  /**
   * Preferences live in chrome.storage.local and are chosen in the side panel.
   * The MAIN-world hook cannot read extension storage, so they are mirrored onto
   * <html> as data attributes; detection results travel the other way.
   */
  const SETTINGS_DEFAULT = { seekMode: 'auto', chapterTips: true }
  let currentSeekMode = 'auto'
  let warnedSeekOff = false

  const applySettings = (settings) => {
    const mode = ['auto', 'on', 'off'].includes(settings.seekMode) ? settings.seekMode : 'auto'
    currentSeekMode = mode
    document.documentElement.dataset.dcinemaSeek = mode
    document.documentElement.dataset.dcinemaChapters = settings.chapterTips === false ? 'off' : 'on'
  }

  const loadSettings = () => {
    try {
      chrome.storage.local.get(SETTINGS_DEFAULT).then(applySettings).catch(() => applySettings(SETTINGS_DEFAULT))
    } catch {
      applySettings(SETTINGS_DEFAULT)
    }
  }

  const installSettingsBridge = () => {
    loadSettings()
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes.seekMode || changes.chapterTips)) loadSettings()
      })
    } catch {
      /* extension context gone */
    }

    const pendingTests = new Map()

    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      const data = event.data
      if (!data || data.source !== 'dcinema-page') return

      if (data.type === 'seek-report') {
        try {
          chrome.storage.local.set({
            seekDetect: { works: Boolean(data.works), method: data.method || 'passive', at: Date.now(), page: location.pathname },
          })
        } catch {
          /* extension context gone */
        }
        if (!data.works && currentSeekMode === 'off' && !warnedSeekOff) {
          warnedSeekOff = true
          toast('检测到抖音进度条点击/拖动无效，可在扩展侧边栏开启「进度条兜底」', 'warn')
        }
        return
      }

      if (data.type === 'seek-test-result') {
        const resolve = pendingTests.get(data.nonce)
        if (resolve) {
          pendingTests.delete(data.nonce)
          resolve(data)
        }
      }
    })

    try {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || message.type !== 'seek-test') return undefined
        const nonce = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`
        const timer = setTimeout(() => {
          pendingTests.delete(nonce)
          sendResponse({ ok: false, reason: 'timeout' })
        }, 4000)
        pendingTests.set(nonce, (result) => {
          clearTimeout(timer)
          sendResponse(result)
        })
        window.postMessage({ source: 'dcinema-content', type: 'seek-test', nonce }, '*')
        return true
      })
    } catch {
      /* extension context gone */
    }
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
    row.classList.add('dcinema-header-row')
    if (getComputedStyle(row).position === 'static') row.style.position = 'relative'

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
      // First mount after a page load: restore the stored preference. Later mounts
      // only re-attach the element, so the live state has to win.
      applySidebarState(readCollapsed())
    }
    applySidebarState(document.documentElement.classList.contains(COLLAPSED_CLASS))
  }

  // --------------------------------------------------------------- boot
  const boot = () => {
    document.documentElement.classList.add('dcinema')
    installSettingsBridge()

    let pending = null
    let scheduled = false
    const safely = (task) => {
      try {
        task()
      } catch (error) {
        // A broken step must not take the whole tick down with it.
        console.warn('[dcinema] step failed:', error)
      }
    }

    const run = () => {
      scheduled = false
      if (document.hidden) return
      safely(injectActions)
      safely(mountSidebarToggle)
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