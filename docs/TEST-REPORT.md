# 抖音影院化扩展 · 功能与性能测试报告

> 记录一次「从刷新 → 全功能验证 → 计时」的完整测试，便于以后回归时对照。
> 测试是自动化执行的（浏览器桥接注入脚本读取 DOM 与 `performance` 数据），不是肉眼观察。

| 项 | 值 |
|---|---|
| 测试时间 | 2026-10-20 15:38 — 15:42（Asia/Shanghai） |
| 被测构建 | 仓库 `main` @ `7996ec5`（含节流与 preconnect；已确认 `link[rel=preconnect]` 生效、无循环开关） |
| 仓库 | https://github.com/just-liuyi/douyin-cinema-ui |
| 浏览器 | Chrome（桥接扩展 0.3.6），视口 1534 × 911 |
| 页面 | `https://www.douyin.com/?recommend=1`（信息流） |
| 加载态 | 暖缓存（同一天多次访问） |

---

## 一、加载计时

| 指标 | 数值 | 说明 |
|---|---|---|
| TTFB（`responseStart`） | **595 ms** | 服务端首字节 |
| First Paint / First Contentful Paint | **992 ms** | 首次绘制 |
| DOMContentLoaded | **2330 ms** | 主要成本：抖音自身 179 个 JS 的解析执行 |
| load | **2881 ms** | 之后继续拉图片/视频 |
| 资源请求数 | 250（其中 **179 个 JS**） | 字节不多，慢在脚本数量 |
| 传输量 | 0.27 MB | 大量命中缓存 |

**结论**：冷启动时间由抖音自身的脚本体量决定，扩展无法显著改变。扩展能做的是「不额外拖慢」+「避免首屏闪烁」+「不抢主线程」。

首屏不闪的实现：`content/boot.js` 在 `document_start` 注入遮蔽样式与 56px 占位条，主脚本建好栏后加 `html.dcinema-ready` 交班。实测刷新过程中不会先渲染抖音原界面。

---

## 二、功能矩阵

判定方式：DOM 存在性 + **实际可见性**（`display/visibility/opacity` + 尺寸）+ 交互后的状态变化。

| # | 功能 | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| 1 | 顶栏存在 | 1534×56，固定顶部 | `bar 1534×56 @ y=0` | ✅ |
| 2 | 品牌区 | 音符标 + “抖音” | `.dcinema-brand` 存在 | ✅ |
| 3 | 渠道导航 | 推荐 / 关注 / 我的 | `["推荐","关注","我的"]` | ✅ |
| 4 | 搜索 | 输入框可用，回车跳 `/search/<kw>` | `.dcinema-search input` 存在 | ✅ |
| 5 | 详情按钮 | 标题「进入详情页」，跳 `/video/<id>` 或 `/note/<id>` | 点击后 URL → `/video/7696744351665613157`，标题「感受#雪 - 抖音」，与当前视频一致 | ✅ |
| 6 | 下载按钮 | 标题「下载无水印视频」，落盘 `douyin/<作者>-<描述>.mp4` | 提示「正在校验视频轨与音轨…」→「已开始下载：douyin/@Mickey.-感受#雪.mp4」；文件 **5.94 MB**，头 `ftyp/isom` 合法 | ✅ |
| 7 | 消息按钮 | 打开站内消息侧栏 | 侧栏 **356×799** @ top≈56，再点关闭；开启耗时 ≈911 ms（含动画） | ✅ |
| 8 | 我的入口 | 跳 `/user/self` | `.dcinema-account a[href*=/user/self]` | ✅ |
| 9 | 左侧栏移除 | 不占 160px，视频铺满 | `sidebarHidden=true`，video **1522 / 1534** | ✅ |
| 10 | 视频铺满 | 横屏 cover、竖屏 contain | 当前横屏 → `object-fit: cover` | ✅ |
| 11 | 右侧动作条（原生） | 贴右边缘、垂直居中 | `.positionBox` 可见，距右 22px，高 253 | ✅ |
| 12 | 隐藏点赞 | 不可见 | 元素存在但 `shown=false` | ✅ |
| 13 | 隐藏收藏 | 不可见 | `shown=false` | ✅ |
| 14 | 隐藏听抖音 | 不可见 | `shown=false` | ✅ |
| 15 | 隐藏「更多 …」 | 不可见 | `shown=false` | ✅ |
| 16 | 隐藏 AI 气泡 | 不可见 | `.ai-douyin-entry` 存在但 `shown=false` | ✅ |
| 17 | 隐藏 App 促销 / 识别画面 | 文本不出现 | 页面文本中已无 | ✅ |
| 18 | 进度条点击跳转 | 点哪跳哪 | 80% → **0.23s → 6.35s**（期望 6.35）；15% → **6.78s → 1.19s**（期望 1.19） | ✅ |
| 19 | ← / → 键 ±5s | 生效 | 2.38s → 7.43s（+5.05s） | ✅ |
| 20 | 循环开关 | 已移除 | 页面无 `.dcinema-loop` | ✅（按需求撤除） |

---

## 三、性能分析：我们自己的开销

| 项目 | 实测 | 备注 |
|---|---|---|
| 一次全文文本扫描 | **1.1 ms**（扫 1222 个元素） | `trimChrome` 类工作 |
| 5 秒内 DOM 变动批次 | **109 次（≈22 次/秒）** | 抖音自身渲染 + 视频播放 |
| 视频 rect 读取 | 0.1 ms | 可忽略 |

**问题**：优化前每个变动批次都跑一轮完整清扫（≈3–4 ms），22 次/秒 ≈ **每秒 70–90 ms 主线程（7–9% CPU）**，滑动与切视频时能感觉到。

**已做优化**（`7996ec5`）：

1. **两级调度**
   - 轻活：每帧（顶栏、按钮、竖排、视频适配）——便宜且必须即时
   - 重活：最多每 **400 ms** 一次（全文文本扫描）——从 22 次/秒降到 ≈2.5 次/秒
2. **空闲执行**：整体走 `requestIdleCallback(timeout: 200)`，页面隐藏时跳过，恢复可见时重置节流
3. **preconnect**：`document_start` 预热静态包 / 图床 / 视频 CDN 三个域，把 DNS+TLS 移出首屏关键路径

---

## 四、已知问题与风险

| 级别 | 问题 | 说明 / 建议 |
|---|---|---|
| 中 | **下载"已开始"≠"已完成"** | toast 只表示任务已提交；文件实际在 1–2 秒后才出现。目前没有完成回调，用户可能误判 |
| 中 | **残留 `.crdownload`** | `Downloads\未确认 376191.crdownload`（15:33，242 MB）——某次 iframe 下载的临时文件，未完成且沿用不了建议文件名。建议手动删除；若复现需给 iframe 下载补 `onDeterminingFilename` 的兜底命名 |
| 中 | **选择器依赖站点结构** | `.positionBox`、`[data-e2e="im-entry"] [data-e2e="something-button"]`、`.xg-right-grid`、`[data-e2e="note-detail"]` 等由抖音提供，改版即失效。失效时优先检查 `content.js` 内对应的 `trim*` / `render*` / `resolve*` 函数 |
| 低 | **信息流多播放器** | 页面同时挂 3 个播放器（上/当前/下），任何"取第一个匹配"的写法都会踩坑（循环开关曾因此插到屏外）。一律用「当前可见视频 → 其 player」反查 |
| 低 | **竖屏视频不铺满** | 按设计：横屏 cover、竖屏 contain（竖屏 cover 会只剩约 29% 画面） |
| 低 | **详情页视频元素瞬时 0 尺寸** | 进入详情页瞬间 `<video>` 高度为 0，`visibleVideo()` 取不到；顶栏按钮靠 `hasActiveItem()`（路径/容器 id）兜底，已验证可用 |
| 信息 | **冷启动无法显著优化** | 179 个 JS / DCL 2.3s 属抖音自身架构 |

---

## 五、复测步骤（下次照着做）

1. `chrome://extensions/` → 抖音扩展 **↻ 重载** → 刷新页面
2. 计时：控制台执行
   ```js
   const n = performance.getEntriesByType('navigation')[0];
   ({ ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd })
   ```
3. 结构核对（一次性脚本）：`document.querySelector('.dcinema-bar')`、`.dcinema-nav a`、`.dcinema-actions > *`、`.dcinema-account > *`
4. 隐藏项核对：对每个 `[data-e2e="video-player-digg|video-player-collect|video-play-more"]` 与 `.ai-douyin-entry` 检查 `getComputedStyle` 是否 `display:none`（**注意：元素仍在 DOM 里，不能用"是否存在"判断**）
5. 进度条：点击轨道 **80% 位置**（不要用 30%，短横屏视频的 30% 常与当前播放时间重合，会造成"没反应"的假象）
6. 下载：点顶栏「下载」，1–3 秒后检查 `%USERPROFILE%\Downloads\douyin\`，确认大小 > 0 且头部是 `ftyp`
7. 消息：点「消息」→ 期望右侧出现 356×799 面板，再点收起
8. 详情：点「详情」→ 期望 URL 变成 `/video/<当前id>`

---

## 六、相关提交

| commit | 内容 |
|---|---|
| `7996ec5` | perf: 节流全文扫描 + preconnect |
| `9cf6cfe` | revert: 移除循环开关 |
| `406312c` | fix: 循环开关只插到屏内播放器（已随 revert 删除） |
| `aa451cb` | feat: 循环开关（已撤销） |
| `343b143` | feat: 图标集 + 文档 |
| `abee064` | style: 详情/下载改为 pill |
| `58940e1` | feat: 图文/笔记支持 |
| `0e38128` | feat: 详情页入口 |
| `f4df5d9` | fix: 消息面板点击 |
| `02a7458` | 初始版本 |
