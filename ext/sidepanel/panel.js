/**
 * Side panel: every feature can be switched on/off on its own, and
 * 「恢复原版抖音」 is simply "all features off".
 *
 * The master switch is derived, never stored on its own, so the two can never
 * disagree:
 *   - all features off            -> master shows ON  (page is plain douyin)
 *   - master turned ON            -> remember the current set, switch all off
 *   - master turned OFF           -> bring back the remembered set
 *                                    (or all features, if nothing was remembered)
 *   - any single feature turned ON -> master turns OFF by itself
 *
 * Storage (chrome.storage.local):
 *   features           { detail, download, seek, chapters, sidebar } booleans
 *   featuresBeforeOriginal  the set to restore when leaving 「原版」
 *   iconOpacity        20..100 (percent) for 详情 / 下载
 *   seekDetect         written by the content script: { works, method, at }
 * The content script listens for changes, so nothing needs a reload.
 */

const FEATURE_KEYS = ['detail', 'download', 'seek', 'chapters', 'sidebar']
const DEFAULT_FEATURES = { detail: true, download: true, seek: true, chapters: true, sidebar: true }
const DEFAULT_ICON_OPACITY = 90

const $ = (id) => document.getElementById(id)

let state = {
  features: { ...DEFAULT_FEATURES },
  featuresBeforeOriginal: null,
  iconOpacity: DEFAULT_ICON_OPACITY,
  seekDetect: null,
}

/** Accepts the current shape and the older `seekMode` / `chapterTips` keys. */
const normalizeFeatures = (raw) => {
  const next = { ...DEFAULT_FEATURES }
  if (raw.features && typeof raw.features === 'object') {
    for (const key of FEATURE_KEYS) if (typeof raw.features[key] === 'boolean') next[key] = raw.features[key]
    return next
  }
  if (raw.seekMode === 'off') next.seek = false
  if (raw.chapterTips === false) next.chapters = false
  return next
}

const allOff = (features) => FEATURE_KEYS.every((key) => !features[key])
const countOn = (features) => FEATURE_KEYS.filter((key) => features[key]).length

const timeOf = (at) => {
  if (!at) return ''
  const date = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return new Date().toDateString() === date.toDateString() ? `今天 ${hm}` : `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
}

// ---------------------------------------------------------------- render
const renderMaster = () => {
  const original = allOff(state.features)
  $('master').checked = original
  $('master-card').dataset.on = original ? '1' : '0'
  $('master-desc').textContent = original
    ? '已恢复原版：插件没有改动页面的任何内容'
    : `关闭全部功能即为原版抖音（当前开启 ${countOn(state.features)}/${FEATURE_KEYS.length} 项）`
}

const renderFeatures = () => {
  for (const input of document.querySelectorAll('input[data-feature]')) {
    input.checked = Boolean(state.features[input.dataset.feature])
  }
  const anyButton = state.features.detail || state.features.download
  $('opacity-row').dataset.disabled = anyButton ? '0' : '1'
  $('icon-opacity').disabled = !anyButton
  $('icon-opacity').value = String(state.iconOpacity)
  $('icon-opacity-value').textContent = `${state.iconOpacity}%`
}

const renderStatus = () => {
  const box = $('status')
  const text = $('status-text')
  const advice = $('advice')
  const detect = state.seekDetect
  const when = detect ? ` · ${timeOf(detect.at)}` : ''

  if (!detect) {
    box.dataset.state = 'unknown'
    text.textContent = '自动检测：尚未检测，点一下进度条即可'
  } else if (detect.works) {
    box.dataset.state = 'ok'
    text.textContent = `自动检测：抖音进度条正常${when}`
  } else {
    box.dataset.state = 'broken'
    text.textContent = `自动检测：抖音进度条无法跳转${when}`
  }

  if (detect && !detect.works && !state.features.seek) {
    advice.hidden = false
    advice.textContent = '抖音自己的进度条现在点了没反应，建议打开「跳转接管」。'
  } else {
    advice.hidden = true
  }
}

const render = () => {
  renderMaster()
  renderFeatures()
  renderStatus()
}

// ----------------------------------------------------------------- state
const load = async () => {
  const raw = await chrome.storage.local.get(null)
  const opacity = Number(raw.iconOpacity)
  state = {
    features: normalizeFeatures(raw),
    featuresBeforeOriginal: raw.featuresBeforeOriginal || null,
    iconOpacity: Number.isFinite(opacity) ? Math.min(100, Math.max(20, Math.round(opacity))) : DEFAULT_ICON_OPACITY,
    seekDetect: raw.seekDetect || null,
  }
  render()
}

const saveFeatures = async (features, extra = {}) => {
  state.features = features
  render()
  await chrome.storage.local.set({ features, ...extra })
  // Legacy keys would otherwise keep overriding older readers.
  await chrome.storage.local.remove(['seekMode', 'chapterTips'])
}

const ALL_OFF = Object.fromEntries(FEATURE_KEYS.map((key) => [key, false]))

/** Entering 「原版」 by any route remembers what was on, for the way back. */
const enterOriginal = async (previous) => {
  const before = { ...previous }
  state.featuresBeforeOriginal = before
  await saveFeatures({ ...ALL_OFF }, { featuresBeforeOriginal: before })
}

const setMaster = async (original) => {
  if (original) {
    if (allOff(state.features)) return
    await enterOriginal(state.features)
    return
  }
  const remembered = state.featuresBeforeOriginal
  const restore = remembered && !allOff(remembered) ? { ...DEFAULT_FEATURES, ...remembered } : { ...DEFAULT_FEATURES }
  await saveFeatures(restore)
}

const setFeature = async (key, on) => {
  const next = { ...state.features, [key]: on }
  // Switching off the last feature is also entering 「原版」.
  if (allOff(next)) {
    await enterOriginal(state.features)
    return
  }
  await saveFeatures(next)
}

// ---------------------------------------------------------------- events
$('master').addEventListener('change', (event) => {
  setMaster(event.target.checked)
})

for (const input of document.querySelectorAll('input[data-feature]')) {
  input.addEventListener('change', () => setFeature(input.dataset.feature, input.checked))
}

$('icon-opacity').addEventListener('input', (event) => {
  const value = Number(event.target.value)
  state.iconOpacity = value
  $('icon-opacity-value').textContent = `${value}%`
  chrome.storage.local.set({ iconOpacity: value })
})

const reasonText = {
  'no-video': '当前页面没有正在显示的视频',
  'no-player': '没有找到抖音的播放器',
  'no-duration': '视频还没加载好，稍后再试',
  timeout: '页面没有响应，请刷新抖音页面',
  'not-douyin': '请先切换到抖音页面',
}

$('run-test').addEventListener('click', async () => {
  const button = $('run-test')
  const text = $('status-text')
  button.disabled = true
  text.textContent = '自动检测：检测中…'
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !tab.url || !/^https?:\/\/([^/]+\.)?douyin\.com\//.test(tab.url)) {
      text.textContent = `自动检测：${reasonText['not-douyin']}`
      return
    }
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'seek-test' })
    if (!result || !result.ok) {
      text.textContent = `自动检测：${reasonText[(result && result.reason) || 'timeout'] || '检测失败'}`
      return
    }
    // The content script stores the result; storage.onChanged re-renders.
  } catch {
    text.textContent = `自动检测：${reasonText.timeout}`
  } finally {
    button.disabled = false
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.features || changes.seekDetect || changes.iconOpacity || changes.featuresBeforeOriginal) load()
})

$('version').textContent = `版本 ${chrome.runtime.getManifest().version}`
load()
