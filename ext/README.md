# Douyin Cinema UI — 实现说明

## 设计原则

**不改抖音的界面。** 这个扩展只注入两枚按钮，并在必要时兜底进度条点击；其余一律交给抖音自己。

## 一、两个按钮

```
播放器控制条（.xg-right-grid）
[连播] [清屏] [智能] [倍速] … [详情] [下载]   ← 追加在末尾
```

- 结构 `div.dcinema-actions > button.dcinema-pill.dcinema-detail | .dcinema-dl`
- 没有 `.xg-right-grid`（例如图文页）时，整组改为 `position: fixed` 贴在右下角
- 每次调度都会把按钮组移动到「当前可见视频所属的播放器」；抖音重渲染后会自动补回
- 只有页面上存在可操作内容（可见视频，或 URL/容器里能取到 id）时才出现

## 二、进度条兜底（有条件启用）

不做「无条件接管」，而是**测量后决定**：

1. 捕获 `pointerdown` 落在 `xg-progress` 上
2. 记录当前 `currentTime`，等 240 ms
3. 期望位移 = `paused ? 0 : 0.24s × playbackRate`
4. 实际位移与期望相差 > 0.18s → 判定站点自己跳转了，**什么都不做**
5. 否则判定失效 → 由扩展执行 seek，并把进度条/把手即时绘制到位，提示「跳转至 mm:ss」
6. 一旦判定失效，后续点击走快速通道（无延迟）

## 三、下载

取址（`content/page-hook.js`，主世界）：

1. 包装 `fetch` / `XMLHttpRequest`，并从 `performance.getEntriesByType('resource')` 取 CDN 请求
2. 解析 aweme JSON 里的 `video.play_addr`（视频）与 `images[]`（图文）
3. 按当前 aweme id（容器类名 `.video_<id>` 或 URL `/video|/note/<id>`）挑选候选
4. 下载前用隐藏 `<video>` 静音试播，确认「有画面 + 有音轨」再采用

落盘（`background.js`）：

- 首选 `chrome.downloads.download({url, filename})` → 浏览器下载气泡出现任务，完成/中断回报页面
- 失败则退回隐藏 1×1 iframe + DNR 把响应改成 `content-disposition: attachment`
- 规则集 `download` 平时关闭，下载期间启用（引用计数 + 延时释放）

图文：逐张 `chrome.downloads`，`quiet: true` 静默完成提示，只报「已开始下载 N 张图片」。

## 路由与权限

| 路由 | 用途 |
|---|---|
| `GET /…` | 本扩展不注册任何 HTTP 路由，全部逻辑在页面与服务 worker 内 |

权限：`downloads`、`declarativeNetRequestWithHostAccess`；host 为 douyin.com 与相关 CDN。

## 已知限制

- 选择器依赖抖音结构：`.xg-right-grid`（控制条）、`xg-progress`（进度条）、`.video_<id>`（id）、`[data-e2e="note-detail"]`（图文图集）
- 下载 URL 有时效（CDN 签名），需在播放时点击
- 页面同时挂多个播放器，一律以「当前可见视频」为准
- 不处理直播、付费/加密内容