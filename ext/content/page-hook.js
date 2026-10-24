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

  // ---- seek fallback for the new douyin-player ---------------------------
  /**
   * Douyin replaced xgplayer with `douyin-player`. Its <video> is fed through
   * `srcObject` (seekable is empty, duration is NaN), so writing
   * `video.currentTime` does nothing — a seek has to go through the page's own
   * player object (`window.player`, whose `media` is the on-screen <video>).
   * Only this MAIN-world script can reach that object; the content script lives
   * in an isolated world and cannot.
   *
   * Measured, not assumed: on pointerup we wait a beat and check whether the
   * player reached the requested position. If the site handled the click/drag we
   * do nothing; if it did not, we seek ourselves.
   */
  const SEEK_SETTLE_MS = 260

  const playerFor = (track) => {
    const root = track.closest('.douyin-player')
    const video = root && root.querySelector('video')
    if (!video) return null
    for (const name of ['player', 'nextPlayer']) {
      const candidate = window[name]
      try {
        if (candidate && candidate.media === video && Number.isFinite(candidate.duration)) return candidate
      } catch {
        /* keep looking */
      }
    }
    return null
  }

  const ratioAt = (track, clientX) => {
    const rect = track.getBoundingClientRect()
    if (!rect.width) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const paint = (track, ratio) => {
    const pct = `${(ratio * 100).toFixed(2)}%`
    const played = track.querySelector('.douyin-player-progress-played')
    const knob = track.querySelector('.douyin-player-progress-btn')
    if (played) played.style.width = pct
    if (knob) knob.style.left = pct
  }

  const clock = (seconds) =>
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

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

  let drag = null

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return
      const track = event.target instanceof Element ? event.target.closest('.douyin-player-progress') : null
      if (!track) return
      const player = playerFor(track)
      if (!player) return
      drag = { track, player, ratio: ratioAt(track, event.clientX) }
      paint(track, drag.ratio)
    },
    true,
  )

  window.addEventListener(
    'pointermove',
    (event) => {
      if (!drag) return
      if (!(event.buttons & 1)) return
      drag.ratio = ratioAt(drag.track, event.clientX)
      paint(drag.track, drag.ratio)
    },
    true,
  )

  const finish = (event) => {
    if (!drag) return
    const { track, player } = drag
    const ratio = event && event.type === 'pointerup' ? ratioAt(track, event.clientX) : drag.ratio
    drag = null
    let duration = 0
    try {
      duration = player.duration
    } catch {
      return
    }
    if (!Number.isFinite(duration) || duration <= 0) return
    const target = ratio * duration
    const tolerance = Math.max(1, duration * 0.01)
    setTimeout(() => {
      let now = NaN
      try {
        now = player.currentTime
      } catch {
        return
      }
      if (Math.abs(now - target) <= tolerance) return // the site handled it
      try {
        player.currentTime = target
        paint(track, ratio)
        notify(`跳转至 ${clock(target)}`)
      } catch {
        /* the player may have been torn down by a slide change */
      }
    }, SEEK_SETTLE_MS)
  }

  window.addEventListener('pointerup', finish, true)
  window.addEventListener(
    'pointercancel',
    () => {
      drag = null
    },
    true,
  )
})()
