/**
 * Douyin Cinema UI — MAIN-world hook.
 *
 * The recommend feed plays through MediaSource, so the visible <video> only has a
 * `blob:` src and the real file URL never appears in the DOM. This script runs in
 * the page's own world, before the app boots, and remembers what the app fetches:
 *
 * - aweme JSON responses (detail / post / search) → `video.play_addr` candidates,
 *   which are watermark-free.
 * - CDN media URLs seen through fetch/XHR → last-resort candidates.
 *
 * The isolated content script asks for these over window.postMessage.
 */

(() => {
  const KEY = '__dcinema'
  if (window[KEY]) return

  /** @type {{ playUrl: string, desc: string, author: string, awemeId: string, at: number }[]} */
  const items = []
  const mediaUrls = []
  const MAX = 60

  const store = { items, mediaUrls }
  window[KEY] = store

  const pushMedia = (url) => {
    if (typeof url !== 'string') return
    if (!/^https?:\/\//.test(url)) return
    if (!/douyinvod\.com|bytecdn\.cn|ibytedtos\.com|douyincdn\.com/.test(url)) return
    if (!/\/video\/tos\/|\.mp4|\.m4s/.test(url)) return
    if (mediaUrls.includes(url)) return
    mediaUrls.unshift(url)
    if (mediaUrls.length > MAX) mediaUrls.length = MAX
  }

  const pickUrl = (addr) => {
    if (!addr) return ''
    if (typeof addr === 'string') return addr.replace(/^\/\//, 'https://')
    if (Array.isArray(addr)) {
      for (const entry of addr) {
        const candidate = pickUrl(entry)
        if (candidate) return candidate
      }
      return ''
    }
    const list = addr.url_list || addr.urlList
    if (Array.isArray(list) && list.length > 0) return String(list[0]).replace(/^\/\//, 'https://')
    if (typeof addr.uri === 'string' && /^https?:/.test(addr.uri)) return addr.uri
    return ''
  }

  /** Walk any JSON shape and harvest objects that look like an aweme. */
  const harvest = (node, depth = 0) => {
    if (!node || depth > 8) return
    if (Array.isArray(node)) {
      for (const entry of node) harvest(entry, depth + 1)
      return
    }
    if (typeof node !== 'object') return

    const video = node.video
    const imageList = Array.isArray(node.images) ? node.images : Array.isArray(node.image_list) ? node.image_list : null

    // Video notes carry play_addr; image notes carry an images[] array instead.
    const playUrl = video ? pickUrl(video.play_addr) || pickUrl(video.playAddr) || pickUrl(video.download_addr) : ''
    const imageUrls = imageList
      ? imageList
          .map((image) => pickUrl(image) || pickUrl(image && (image.url_list ? image : null)))
          .filter((url) => typeof url === 'string' && url.startsWith('http'))
      : []

    if (playUrl || imageUrls.length > 0) {
      const awemeId = String(node.aweme_id || node.awemeId || node.group_id || node.groupId || '')
      const desc = String(node.desc || node.title || node.caption || '')
      const author =
        (node.author && (node.author.nickname || node.author.name)) ||
        (node.authorInfo && node.authorInfo.nickname) ||
        ''
      const key = awemeId || playUrl || imageUrls[0]
      const record = {
        playUrl,
        imageUrls,
        kind: imageUrls.length > 0 && !playUrl ? 'note' : 'video',
        desc,
        author: String(author || ''),
        awemeId,
        at: Date.now(),
      }
      const existing = items.findIndex((entry) => (entry.awemeId || entry.playUrl) === key)
      if (existing >= 0) items[existing] = record
      else items.unshift(record)
      if (items.length > MAX) items.length = MAX
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') harvest(value, depth + 1)
    }
  }

  // ---- fetch hook -------------------------------------------------------
  const originalFetch = window.fetch
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const request = args[0]
      const url = typeof request === 'string' ? request : request && request.url
      const result = originalFetch.apply(this, args)
      try {
        if (url && typeof url === 'string') {
          pushMedia(url)
          if (/aweme\/v1\/web\/|aweme\/v1\/web\/aweme|get_user_summary/.test(url) || /aweme|aweme_id/.test(url)) {
            result
              .then((response) => {
                if (response && response.clone) response.clone().json().then((data) => harvest(data)).catch(() => {})
              })
              .catch(() => {})
          }
        }
      } catch {
        /* never break the page */
      }
      return result
    }
  }

  // ---- XHR hook --------------------------------------------------------
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__dcinemaUrl = url
    return originalOpen.call(this, method, url, ...rest)
  }
  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    try {
      const url = this.__dcinemaUrl
      if (typeof url === 'string') {
        pushMedia(url)
        if (/aweme|aweme_id/.test(url)) {
          this.addEventListener('load', () => {
            try {
              const text = this.responseText
              if (text && text.length < 4_000_000) harvest(JSON.parse(text))
            } catch {
              /* non-JSON */
            }
          })
        }
      }
    } catch {
      /* never break the page */
    }
    return originalSend.apply(this, args)
  }

  // ---- resource timing: catches media the app loads before we see it ----
  const sweepTiming = () => {
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        if (entry && typeof entry.name === 'string') pushMedia(entry.name)
      }
    } catch {
      /* ignore */
    }
  }
  sweepTiming()
  setInterval(sweepTiming, 4000)

  // ---- answer content-script queries -----------------------------------
  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.source !== 'dcinema-content' || data.type !== 'query') return
    sweepTiming()
    window.postMessage(
      {
        source: 'dcinema-page',
        type: 'result',
        nonce: data.nonce,
        items: store.items.slice(0, 20),
        mediaUrls: store.mediaUrls.slice(0, 20),
      },
      '*',
    )
  })

  // ---- progress bar: seek fallback, detection, chapter hints ---------------
  /**
   * Douyin's `douyin-player` feeds its <video> through `srcObject`, so writing
   * `video.currentTime` is a no-op; seeks must go through the page's own player
   * object (`window.player`, whose `media` is the on-screen <video>). That object
   * is only reachable from this MAIN-world script.
   *
   * Behaviour is chosen by the user in the extension side panel and arrives as
   * `<html data-dcinema-seek="auto|on|off">` (written by the content script):
   *   auto - measure every click/drag; take over only when the site did not seek
   *   on   - seek immediately on release, without waiting for the site
   *   off  - leave the progress bar entirely to douyin
   * Every measurement is reported back so the side panel can show whether the
   * native bar currently works.
   */
  const SEEK_SETTLE_MS = 260
  const TEST_SETTLE_MS = 520

  const seekMode = () => {
    const mode = document.documentElement.dataset.dcinemaSeek
    return mode === 'on' || mode === 'off' ? mode : 'auto'
  }
  const chapterTipsEnabled = () => document.documentElement.dataset.dcinemaChapters !== 'off'

  const report = (payload) => {
    window.postMessage({ source: 'dcinema-page', type: 'seek-report', ...payload }, '*')
  }

  // Douyin serves two players side by side (A/B): the new `douyin-player` and
  // the older `xgplayer`. Everything below works on either.
  const TRACK_SELECTOR = '.douyin-player-progress, xg-progress'
  const ROOT_SELECTOR = '.douyin-player, .xgplayer'

  /**
   * Something with `currentTime` / `duration` that actually seeks: the page's
   * player object when it owns this <video> (required for douyin-player, whose
   * <video> is fed by srcObject), otherwise the <video> itself when it is
   * seekable (xgplayer).
   */
  const playerFor = (track) => {
    const root = track.closest(ROOT_SELECTOR)
    const video = root && root.querySelector('video')
    if (!video) return null
    for (const name of ['player', 'nextPlayer']) {
      const candidate = window[name]
      try {
        if (candidate && (candidate.media === video || candidate.video === video) && Number.isFinite(candidate.duration)) {
          return candidate
        }
      } catch {
        /* keep looking */
      }
    }
    if (Number.isFinite(video.duration) && video.duration > 0 && video.seekable.length) return video
    return null
  }

  const visibleTrack = () => {
    let best = null
    let bestTop = Infinity
    for (const video of document.querySelectorAll('.douyin-player video, .xgplayer video')) {
      const rect = video.getBoundingClientRect()
      if (rect.height < 100 || rect.top < 0 || rect.top >= innerHeight) continue
      const track = video.closest(ROOT_SELECTOR).querySelector(TRACK_SELECTOR)
      if (track && rect.top < bestTop) {
        best = track
        bestTop = rect.top
      }
    }
    return best
  }

  const ratioAt = (track, clientX) => {
    const rect = track.getBoundingClientRect()
    if (!rect.width) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const paint = (track, ratio) => {
    const pct = `${(ratio * 100).toFixed(2)}%`
    const played = track.querySelector('.douyin-player-progress-played, .xgplayer-progress-played')
    const knob = track.querySelector('.douyin-player-progress-btn, .xgplayer-progress-btn, xg-progress-btn')
    if (played) played.style.width = pct
    if (knob) knob.style.left = pct
  }

  const clock = (seconds) => {
    const total = Math.max(0, Math.floor(seconds))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const mm = String(m).padStart(2, '0')
    const ss = String(s).padStart(2, '0')
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
  }

  const notify = (text) => {
    let node = document.querySelector('.dcinema-toast')
    if (!node) {
      node = document.createElement('div')
      node.className = 'dcinema-toast'
      document.documentElement.appendChild(node)
    }
    node.textContent = text
    node.dataset.kind = 'info'
    node.classList.add('on')
    clearTimeout(notify.timer)
    notify.timer = setTimeout(() => node.classList.remove('on'), 1400)
  }

  /** Duration in seconds: the player when we have it, otherwise the time label. */
  const durationOf = (track, player) => {
    try {
      if (player && Number.isFinite(player.duration) && player.duration > 0) return player.duration
    } catch {
      /* fall through */
    }
    const label = track.closest(ROOT_SELECTOR)?.querySelector('.time-duration')?.textContent?.trim() || ''
    const parts = label.split(':').map(Number)
    if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0
    return parts.reduce((acc, n) => acc * 60 + n, 0)
  }

  /**
   * Chapters as the progress component itself received them: its React props
   * carry `chapters: [{ timestamp(ms), desc }]` even though douyin's own hover
   * label no longer renders.
   */
  const normalizeChapters = (list) =>
    list
      .map((entry) => ({ at: Number(entry.timestamp) / 1000, title: String(entry.desc || '').trim() }))
      .filter((entry) => Number.isFinite(entry.at) && entry.title)
      .sort((a, b) => a.at - b.at)

  /**
   * douyin-player hands the progress component `chapters: [{timestamp, desc}]`;
   * xgplayer has no React on its bar, but the player container above it carries
   * the item as `awemeInfo` / `item` with `chapterInfo.list`. Walk up from the bar
   * to the first React-owned element and search its fiber ancestry for either.
   */
  const chaptersOf = (track) => {
    let el = track
    let key = null
    for (let up = 0; el && up < 8; up += 1) {
      key = Object.keys(el).find((k) => k.startsWith('__reactFiber'))
      if (key) break
      el = el.parentElement
    }
    let fiber = key ? el[key] : null
    for (let depth = 0; fiber && depth < 30; depth += 1) {
      const props = fiber.memoizedProps
      if (props && typeof props === 'object') {
        if (Array.isArray(props.chapters) && props.chapters.length) return normalizeChapters(props.chapters)
        for (const name of ['awemeInfo', 'item', 'aweme', 'data']) {
          const list = props[name] && props[name].chapterInfo && props[name].chapterInfo.list
          if (Array.isArray(list) && list.length) return normalizeChapters(list)
        }
      }
      fiber = fiber.return
    }
    return []
  }

  // -- hover / drag hint ----------------------------------------------------
  let tip = null
  const ensureTip = () => {
    if (tip && tip.isConnected) return tip
    tip = document.createElement('div')
    tip.className = 'dcinema-chapter-tip'
    tip.innerHTML = '<div class="dc-tip-title"></div><div class="dc-tip-time"></div><div class="dc-tip-next"></div>'
    document.documentElement.appendChild(tip)
    return tip
  }
  const hideTip = () => {
    if (tip) tip.classList.remove('on')
  }
  const showTip = (track, clientX) => {
    if (!chapterTipsEnabled()) return hideTip()
    const player = playerFor(track)
    const duration = durationOf(track, player)
    if (!duration) return hideTip()
    const ratio = ratioAt(track, clientX)
    const time = ratio * duration
    const chapters = chaptersOf(track)
    let index = -1
    for (let k = 0; k < chapters.length; k += 1) if (chapters[k].at <= time + 0.05) index = k
    const current = index >= 0 ? chapters[index] : null
    const next = chapters[index + 1] || null

    const node = ensureTip()
    node.querySelector('.dc-tip-title').textContent = current
      ? `${index + 1}/${chapters.length} · ${current.title}`
      : chapters.length
        ? '片头'
        : ''
    node.querySelector('.dc-tip-time').textContent = clock(time)
    node.querySelector('.dc-tip-next').textContent = next ? `下一章 ${clock(next.at)} · ${next.title}` : ''
    node.dataset.chapters = chapters.length ? '1' : '0'

    const rect = track.getBoundingClientRect()
    const x = Math.min(innerWidth - 12, Math.max(12, rect.left + ratio * rect.width))
    node.style.left = `${Math.round(x)}px`
    node.style.top = `${Math.round(rect.top - 10)}px`
    node.classList.add('on')
  }

  // -- seek ----------------------------------------------------------------
  let drag = null
  let testing = false

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (testing || event.button !== 0) return
      const track = event.target instanceof Element ? event.target.closest(TRACK_SELECTOR) : null
      if (!track) return
      const player = playerFor(track)
      drag = { track, player, ratio: ratioAt(track, event.clientX), startTime: player ? player.currentTime : NaN }
      // With the takeover off the page must stay untouched: no class, no paint.
      if (seekMode() !== 'off') {
        document.documentElement.classList.add('dcinema-dragging')
        paint(track, drag.ratio)
      }
      showTip(track, event.clientX)
    },
    true,
  )

  window.addEventListener(
    'pointermove',
    (event) => {
      if (testing) return
      if (drag) {
        if (!(event.buttons & 1)) return
        drag.ratio = ratioAt(drag.track, event.clientX)
        if (seekMode() !== 'off') paint(drag.track, drag.ratio)
        showTip(drag.track, event.clientX)
        return
      }
      const track = event.target instanceof Element ? event.target.closest(TRACK_SELECTOR) : null
      if (track) showTip(track, event.clientX)
      else hideTip()
    },
    true,
  )

  const finish = (event) => {
    if (!drag) return
    const { track, player } = drag
    const ratio = event && event.type === 'pointerup' ? ratioAt(track, event.clientX) : drag.ratio
    drag = null
    document.documentElement.classList.remove('dcinema-dragging')
    hideTip()
    const mode = seekMode()
    if (!player) return
    const duration = durationOf(track, player)
    if (!duration) return
    const target = ratio * duration
    const tolerance = Math.max(1, duration * 0.01)

    const takeOver = () => {
      try {
        player.currentTime = target
        paint(track, ratio)
        notify(`跳转至 ${clock(target)}`)
      } catch {
        /* the player may have been torn down by a slide change */
      }
    }

    if (mode === 'on') {
      takeOver()
      return
    }

    setTimeout(() => {
      let now = NaN
      try {
        now = player.currentTime
      } catch {
        return
      }
      const siteWorked = Math.abs(now - target) <= tolerance
      // Measured in every mode so the side panel always knows the native state;
      // only the takeover itself depends on the switch.
      report({ works: siteWorked, method: 'passive', target, now })
      if (!siteWorked && mode !== 'off') takeOver()
    }, SEEK_SETTLE_MS)
  }

  window.addEventListener('pointerup', finish, true)
  window.addEventListener(
    'pointercancel',
    () => {
      drag = null
      document.documentElement.classList.remove('dcinema-dragging')
      hideTip()
    },
    true,
  )

  /**
   * Active check, requested from the side panel: click the on-screen bar where it
   * should land at ~1/2 (or ~1/4), see whether douyin moved the playhead, then put
   * the playhead back where it was. Our own listeners stand down meanwhile so
   * they cannot mask the result.
   */
  const activeTest = async () => {
    const track = visibleTrack()
    if (!track) return { ok: false, reason: 'no-video' }
    const player = playerFor(track)
    if (!player) return { ok: false, reason: 'no-player' }
    const duration = durationOf(track, player)
    if (!duration) return { ok: false, reason: 'no-duration' }

    const original = player.currentTime
    const ratio = Math.abs(original / duration - 0.5) < 0.15 ? 0.25 : 0.5
    const target = ratio * duration
    const rect = track.getBoundingClientRect()
    const x = rect.left + rect.width * ratio
    const y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    const el = hit && track.contains(hit) ? hit : track
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }

    testing = true
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
      await new Promise((r) => setTimeout(r, 40))
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
      el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
      await new Promise((r) => setTimeout(r, TEST_SETTLE_MS))
      const now = player.currentTime
      const works = Math.abs(now - target) <= Math.max(1, duration * 0.01)
      try {
        player.currentTime = original
      } catch {
        /* best effort */
      }
      return { ok: true, works, target, now, duration }
    } finally {
      testing = false
      hideTip()
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.source !== 'dcinema-content' || data.type !== 'seek-test') return
    activeTest().then((result) => {
      window.postMessage({ source: 'dcinema-page', type: 'seek-test-result', nonce: data.nonce, ...result }, '*')
      if (result.ok) report({ works: result.works, method: 'active', target: result.target, now: result.now })
    })
  })
})()
