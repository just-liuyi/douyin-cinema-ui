# Douyin Cinema UI — 实现说明

## 设计原则

**尽量不改抖音的界面。** 扩展只加少量东西：播放区里的「详情 / 下载」、进度条跳转兜底与章节提示、顶栏的侧栏收放按钮，以及一个设置侧边栏。

## 一、播放区按钮（详情 / 下载）

```
┌──────────────── 播放区（.basePlayerContainer）──────────────┐
│                                                  ┌──────┐ │
│                                                  │ 详情 │ │ ← 右上角，距顶 16px、距右 20px
│                                                  │ 下载 │ │   纵向排列，和右侧原生竖排对齐
│                                                  └──────┘ │
```

- 结构 `div.dcinema-stage-actions > button.dcinema-rail-btn.dcinema-detail | .dcinema-dl`
- 外观照抄原生「点赞 / 收藏」：白色实心字形（高约 20px，与原生同高）、透明度 0.9（与点赞相同，悬停时变为 1）、无底色、无文字（名称放在 title / aria-label），与原生竖排同一中轴
- 动效：悬停放大 1.12；按下时按点赞的节奏「先压扁再拉伸后回弹」（0.45 秒）；下载准备中图标呼吸闪烁；系统开启「减少动态效果」时全部关闭
- 挂载点：视口内可见面积最大的 `.basePlayerContainer` / `[data-e2e="player-container"]`。信息流、视频详情页、图文详情页都用它；信息流同时挂着上/当前/下多个播放区，面积最大的就是当前这条
- 已经在本条内容的详情页（`/video/<id>`、`/note/<id>`）时，「详情」自动隐藏
- 图文内容下「下载」的提示是「下载图文原图」
- 只有当前有视频或图文时才出现；抖音重渲染后由调度自动补回

## 二、进度条：跳转兜底与检测

抖音会同时下发两种播放器（A/B）：新版 `douyin-player`（进度条 `.douyin-player-progress`，`<video>` 用 `srcObject` 推流，直接写 `video.currentTime` 无效）和旧版 `xgplayer`（进度条 `xg-progress`）。逻辑在 `content/page-hook.js`（主世界），因为只有主世界能拿到页面的播放器对象 `window.player`。

跳转对象的选择：`window.player` / `window.nextPlayer` 中 `media`（或 `video`）就是该进度条所属 `<video>` 的那个；都不是时，若 `<video>` 本身可 seek（旧播放器）就直接用它。

**开关**（侧边栏「跳转接管」，经 `<html data-dcinema-seek="auto|off">` 传给页面）：

| 模式 | 行为 |
|---|---|
| 开（默认） | 松开鼠标 260 ms 后看播放器是否到了目标位置（容差 max(1 秒, 1%)）。到了 = 抖音自己处理了，不动；没到 = 插件跳过去 |
| 关 | 完全交给抖音，页面上不画任何东西；仍在后台测量原生是否有效，结果只显示在侧边栏 |

**拖动策略**：按下记录位置；拖动过程中已播放进度与把手跟手绘制，并显示目标时间；在窗口任意位置松开都按最后位置结算；拖动期间禁止选中页面文字（`html.dcinema-dragging`）。

**检测**：
- 被动：「自动」模式下每次真实点击 / 拖动都会得出一次「原生是否有效」
- 主动：侧边栏「立即检测」→ 内容脚本 → 页面在进度条上合成一次点击，比较落点，然后把播放位置恢复原样；检测期间插件自己的接管暂停，避免干扰结果
- 结果写入 `chrome.storage.local.seekDetect = { works, method, at, page }`，侧边栏实时显示

## 三、进度条章节提示

抖音新版的悬停章节文字不再渲染，由扩展补上。悬停或拖动进度条时显示：

```
4/6 · 基础设施建设
03:32
下一章 05:21 · 附属村庄建设
```

章节数据来源（都在 React 数据里）：新版进度条组件 props 的 `chapters: [{timestamp(ms), desc}]`；旧版播放区容器上的 `awemeInfo.chapterInfo.list` / `item.chapterInfo.list`。没有章节的视频只显示时间。可在侧边栏关闭。

## 四、设置侧边栏

点工具栏上的扩展图标打开（`chrome.sidePanel`，需 Chrome 116+）。所有设置都在这里，页面上不放任何设置入口。

```
恢复原版抖音                         [开关]
──────────────────────────────────────────
播放区按钮   详情  [开关]   下载  [开关]   图标透明度 [20%─────100%]
进度条       跳转接管 [开关]   ● 自动检测：抖音进度条无法跳转 · 今天 16:26  重新检测
             悬停显示章节信息 [开关]（默认开）
页面         侧栏收起 / 展开按钮 [开关]
```

**「恢复原版抖音」= 所有功能都关闭**，它不单独存储，而是由各项开关推导出来，所以两者不会不一致：

| 操作 | 结果 |
|---|---|
| 打开「恢复原版」 | 记下当前开着的组合，然后全部关闭 |
| 关闭「恢复原版」 | 恢复记下的组合（没有记录时全部打开） |
| 逐项关到最后一项 | 「恢复原版」自动变为开启，并记下关之前的组合 |
| 原版状态下打开任意一项 | 「恢复原版」自动变为关闭 |

原版状态下页面上不留插件的任何东西：按钮、侧栏按钮、章节提示、拖动时的样式都不挂载；侧栏若之前收起会恢复显示；我们给抖音元素加的 class 和内联 `position` 都会还原（收起偏好仍保存，重新打开该功能时恢复）。唯一保留的是 `<html>` 上看不见的作用域 class 和 `data-*` 属性。

**进度条跳转接管**只有开 / 关：开 = 抖音没跳时由插件跳转；关 = 完全交给抖音。无论开关，插件都在后台测量原生进度条是否有效（只读不改），结果显示在开关下方；原生无效而接管关闭时给出建议。「重新检测」会在当前视频上模拟一次点击，测完恢复原位置。

**图标透明度**作用于「详情」「下载」两个图标，默认 90%（与原生「点赞」一致），两者都关闭时滑块置灰。

存储（`chrome.storage.local`）：`features`（`detail / download / seek / chapters / sidebar`）、`featuresBeforeOriginal`、`iconOpacity`、`seekDetect`。旧版的 `seekMode / chapterTips` 会自动迁移并清除。内容脚本监听变化，**修改即时生效，无需刷新**。
## 五、下载

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

## 六、顶栏侧栏收放

搜索框左侧的「收起 / 展开」按钮（原生顶栏条目样式）。收起时侧栏列 `display: none`（抖音的导航是 fixed 子元素，只缩宽度会残留），顶栏行由 `calc(100vw - 160px)` 改为 `100%`。状态存 `localStorage['dcinema:sidebar-collapsed']`。

## 权限

`downloads`、`storage`、`sidePanel`、`declarativeNetRequestWithHostAccess`；host 为 douyin.com 与相关 CDN。

## 开发检查

```
node tools/check-undefined.js ext/content/content.js ext/content/page-hook.js ext/background.js ext/sidepanel/panel.js
```

扫描「调用了但从未定义」的函数（曾因编辑误删工厂函数导致整个内容脚本失效）。

## 已知限制

- 选择器依赖抖音结构：`.basePlayerContainer`（播放区）、`.douyin-player-progress` / `xg-progress`（进度条）、`window.player`（新版播放器对象）、`.video_<id>`（id）
- 主动检测是脚本合成的点击；个别播放器只认真实鼠标事件时，以被动检测（真实点击）的结论为准
- 下载 URL 有时效（CDN 签名），需在播放时点击
- 不处理直播、付费/加密内容
