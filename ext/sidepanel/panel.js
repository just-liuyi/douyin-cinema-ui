/**
 * Side panel: progress-bar strategy and hint preferences.
 *
 * Everything is stored in chrome.storage.local; the content script on douyin.com
 * listens for changes and mirrors them onto the page, so nothing needs a reload.
 * Detection results (`seekDetect`) are written by the content script whenever the
 * page measures a click/drag, or when the user runs the active check from here.
 */

const DEFAULTS = { seekMode: 'auto', chapterTips: true, seekDetect: null }

const $ = (id) => document.getElementById(id)

const timeOf = (at) => {
  if (!at) return ''
  const date = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  const sameDay = new Date().toDateString() === date.toDateString()
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return sameDay ? `今天 ${hm}` : `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
}

const renderStatus = (detect, mode) => {
  const box = $('status')
  const title = $('status-title')
  const detail = $('status-detail')
  const advice = $('advice')

  if (!detect) {
    box.dataset.state = 'unknown'
    title.textContent = '还没有检测过'
    detail.textContent = '在抖音里点一下进度条，或点下面的「立即检测」。'
  } else if (detect.works) {
    box.dataset.state = 'ok'
    title.textContent = '抖音原生进度条可以正常跳转'
    detail.textContent = `最近一次：${timeOf(detect.at)} · ${detect.method === 'active' ? '主动检测' : '实际点击'}`
  } else {
    box.dataset.state = 'broken'
    title.textContent = '抖音原生进度条点击 / 拖动无效'
    detail.textContent = `最近一次：${timeOf(detect.at)} · ${detect.method === 'active' ? '主动检测' : '实际点击'}`
  }

  if (detect && !detect.works && mode === 'off') {
    advice.hidden = false
    advice.textContent = '检测到原生跳转无效，而当前是「关闭」：点击或拖动进度条不会有反应。建议改为「自动」。'
  } else if (detect && detect.works && mode === 'on') {
    advice.hidden = false
    advice.textContent = '原生跳转目前是好的，「自动」已足够；「始终由插件跳转」也可以继续用。'
  } else {
    advice.hidden = true
  }
}

const render = (state) => {
  for (const input of document.querySelectorAll('input[name="seekMode"]')) {
    input.checked = input.value === state.seekMode
  }
  $('chapter-tips').checked = state.chapterTips !== false
  renderStatus(state.seekDetect, state.seekMode)
}

const load = () => chrome.storage.local.get(DEFAULTS).then(render)

const reasonText = {
  'no-video': '当前页面没有正在显示的视频，请先打开一条视频再检测。',
  'no-player': '没有找到抖音的播放器（可能是旧版播放器或直播页）。',
  'no-duration': '视频时长还没加载出来，稍等一下再试。',
  timeout: '页面没有响应，请刷新抖音页面后再试。',
  'not-douyin': '请先切换到抖音的标签页再检测。',
}

const runTest = async () => {
  const button = $('run-test')
  const out = $('test-result')
  button.disabled = true
  out.textContent = '检测中…（会短暂跳到别处，随后自动回到原来的位置）'
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !tab.url || !/^https?:\/\/([^/]+\.)?douyin\.com\//.test(tab.url)) {
      out.textContent = reasonText['not-douyin']
      return
    }
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'seek-test' })
    if (!result || !result.ok) {
      out.textContent = reasonText[(result && result.reason) || 'timeout'] || '检测失败。'
      return
    }
    out.textContent = result.works
      ? '结果：抖音原生跳转正常。'
      : '结果：抖音原生跳转无效，点击 / 拖动需要插件接管。'
  } catch {
    out.textContent = '无法连接到页面，请刷新抖音页面后再试。'
  } finally {
    button.disabled = false
  }
}

document.addEventListener('change', (event) => {
  const target = event.target
  if (target.name === 'seekMode') chrome.storage.local.set({ seekMode: target.value })
  if (target.id === 'chapter-tips') chrome.storage.local.set({ chapterTips: target.checked })
})

$('run-test').addEventListener('click', runTest)

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.seekMode || changes.chapterTips || changes.seekDetect)) load()
})

$('version').textContent = `版本 ${chrome.runtime.getManifest().version}`
load()
