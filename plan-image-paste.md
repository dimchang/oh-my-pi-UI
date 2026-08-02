# 详细计划：对话框粘贴/拖拽图片功能

> 状态：研究 + probe 完成，尚未改代码。  
> 生成日期：2026-08-01  
> 路线：落盘临时图片 → 复用现有 `Attachment{path}` 附件链路 → 发送时路径拼进 prompt（**不改动 omp RPC 协议**）。
>
> **已彻底验证的前置条件**（见 §0.1）：要让 omp agent 真正"看懂"粘贴的图片，
> 必须在 omp 的 `config.yml` 把 `modelRoles.vision` 指向一个 omp 注册表里 `"input":["text","image"]` 的模型
> （如 `openrouter/google/gemini-2.5-flash`）。**仅改 `models.yml` 的 `input` 字段无效**——
> `inspect_image` 发请求前会按 omp 内置模型能力库二次校验 vision 角色所属模型，该库写死 deepseek 全系为 text-only。
>
> ✅ **2026-08-01 更新**：用户已在 omp 配置 `modelRoles.vision: xiaomi/mimo-v2.5`（原生多模态，
> omp 注册表 `input:["text","image"]` 已验证）。前置条件**已满足**，agent 端到端看懂图片的路径打通。
> 注意 `mimo-v2.5-pro` 是 text-only，**务必确认配的是不带 -pro 的 `mimo-v2.5`**。



---

## 0. Probe 结论（事实基础，决定方案前提）

在 `D:\code\OMP-UI\.temp\probe-ws\` 用 PIL 生成测试图（含 `"VISION TEST 729"` 文字、红圆、蓝矩形），以与 `App.buildPromptWithAttachments` **完全一致**的附件格式发送 prompt，启动 `omp --mode rpc-ui` 观测。

omp 的真实行为：

1. `read` 工具读取图片 → 只返回**元数据**（`MIME: image/png`、`Bytes: 13711`、`Dimensions: 640x400`、`Channels: 3`），并提示 `If you want to analyze the image, call inspect_image with path=...`。
2. agent 调用 `xd://inspect_image`（omp 的**视觉委托通道**）→ **失败**：
   ```
   Resolved model deepseek/deepseek-v4-flash does not support image input.
   Configure a vision-capable model for modelRoles.vision.
   ```
3. 回退到 "用 Python 直接分析 PNG 像素与 OCR" → `eval` 被 deny（harness 只自动批准了 `extension_ui_request`，未批准 `eval`）。

**关键事实：**

- omp **确实有视觉管线**（`inspect_image`），但它依赖在 `modelRoles.vision` 配置一个**视觉模型**。
- 当前默认模型 `deepseek-v4-flash` 是**纯文本模型**，因此图片"看不见"。
- **结论：UI 层把图片作为附件路径发出去一定成功；agent 能否"看到"图片，取决于 omp 是否配置了视觉模型。** 这是前置条件，不是 app 代码能绕过的。

> probe 脚本与日志（可复跑）：`.temp/probe-vision-gen.py`（生成图）、`.temp/probe-vision.mjs`（跑 omp）、`.temp/probe-vision.log`（帧）、`.temp/final-vision.mjs`（解析）。

### 0.1 追加验证：`models.yml` 改 `input` 字段能否让 deepseek 当视觉模型？——**不能**

为回答"能否零配置复用 deepseek 当视觉模型"，用 `--profile probevision` 隔离环境实测：

1. 复制 `models.yml` 到 profile，给 `deepseek-v4-flash` 加 `input: [text, image]`。
2. `omp models --json` → 该模型 `input` 字段**确实**从 `["text"]` 变为 `["text","image"]`（注册表层覆盖生效）。
3. 实跑 `inspect_image` → **仍失败**，报错：`Resolved model deepseek/deepseek-v4-pro does not support image input. Configure a vision-capable model for modelRoles.vision.`

**根因**：`inspect_image` 用 `modelRoles.vision` 角色解析视觉模型，发请求前会**再次校验该模型的视觉能力**；此校验读 omp **内置模型能力库**（deepseek 全系写死 text-only），**不读 `models.yml` 的 `input` 覆盖字段**。所以靠改 `input` 字段绕不过去。

**结论**：启用视觉只有一条路——`config.yml` 的 `modelRoles.vision` 指向 omp 注册表里 `"input":["text","image"]` 的模型（如 `openrouter/google/gemini-2.5-flash`、`openrouter/anthropic/claude-3.5-sonnet`、`openrouter/~openai/gpt-latest` 等，注册表 385 模型中有 189 个支持 image），且对应 provider 在 `models.yml` 配好 API key。

> 测试产物已清理：`C:\Users\17593\.omp\profiles\probevision\` 已删除。

---

## 1. 方案总览（合并两份计划 + 修正）

采用方案 A（落盘 → 复用附件路径）。分两半：

- **A. 应用内功能（必做，app 代码可控）**：粘贴/拖拽图片 → 主进程存盘 → 附件芯片显示缩略图 → 发送 → 历史消息内联预览。这部分**无论如何都能跑通**（图片作为附件进入对话）。
- **B. agent 真正"看懂"图片（前置依赖，配置侧）**：用户需在 omp 配置 `modelRoles.vision` 指向视觉模型。否则粘贴的图 agent 看不到内容（只收到路径）。应用侧建议加"未配置视觉模型"的提示。

---

## 2. 文件改动清单（合并 + 修正）

### 2.1 新增 IPC 通道与类型 — `src/shared/ipc-channels.ts`

- 新增通道：
  - `SavePastedImage: 'image:save-pasted'`
  - `ReadImageAsDataUrl: 'image:read-as-dataurl'`
- 新增类型：
  - `PastedImageResult { path: string; name: string; size: number }`
  - `ImageDataUrlResult { dataUrl: string }`
- 在 `OmpApi` 接口新增：
  - `savePastedImage(data: ArrayBuffer, ext: string): Promise<PastedImageResult>`
  - `readImageAsDataUrl(filePath: string): Promise<ImageDataUrlResult>`

### 2.2 Preload 桥接 — `electron/preload.ts`

```ts
savePastedImage: (data, ext) => ipcRenderer.invoke(IPC.SavePastedImage, data, ext),
readImageAsDataUrl: (filePath) => ipcRenderer.invoke(IPC.ReadImageAsDataUrl, filePath),
```

（传 `ArrayBuffer` 而非 `Uint8Array`，结构化克隆更稳。）

### 2.3 主进程 handler — `electron/main.ts`

- `IPC.SavePastedImage`：
  - 目录 `app.getPath('userData')/pasted-images`（持久化，见 §3 取舍）。
  - 文件名 `paste-<timestamp>-<uuid8>.<ext|png>`；`fs.promises.mkdir(recursive)`；`fs.promises.writeFile`；返回 `{path,name,size}`。
  - **存盘格式白名单（决定能不能存）**：`png/jpg/jpeg/gif/webp/bmp/svg`（含 SVG）。不在白名单的 `ext` 直接拒绝。
  - **大小上限（如 10MB）**：超限报错。**此校验在主进程做（权威）；但渲染进程在 paste 时应先查 `blob.size` 做前置判断**（见 §2.5 / 点 7），避免 100MB 图先序列化跨进程再被拒，白费一次昂贵 IPC。
  - **resize 仅对位图生效（GIF/SVG 跳过）**：仅当 `ext ∈ {png,jpg,jpeg,webp,bmp}` 时，用 `nativeImage.createFromBuffer(buf).resize({width:1024})` 再落盘；`gif` 会被 nativeImage 丢帧、`svg` 不被支持（返回空图），这两种**原样写盘、不做 resize**。
  - 遵守现有约定：用 `fs.promises.*`，**不在 IPC handler 里同步阻塞 I/O**（参考 `main.ts:443` 注释）。
- `IPC.ReadImageAsDataUrl`：
  - **安全路径校验**：复用 `main.ts` 已有的 `isWithinWorkspaces()`（realpath + 小写归一化）；并新增对 `pasted-images/` 目录的 realpath 校验，**防符号链接逃逸**。仅当路径落在工作区或 `pasted-images/` 内才允许读，否则拒绝（防本地文件泄露）。
  - `fs.promises.readFile` → `data:image/<ext>;base64,...`。
  - 同样可先 `nativeImage.resize` 成缩略图再编码（**GIF/SVG 跳过 resize**），避免超大 base64 过 IPC。

### 2.4 附件类型 — `src/renderer/store.ts`

- `Attachment`（L43）加可选 `kind?: 'file' | 'image'`（粘贴/拖拽时带上，作为可选加速提示）。
- **关键**：图片/文件的判定**以扩展名为准**（新建 `isImageFile(name)` 辅助函数，正则 `/\.(png|jpe?g|gif|webp|bmp|svg)$/i`），UI 渲染时统一调用，而非只依赖 `kind`。原因：`pickFiles`（回形针）返回的 `PickedFile` 不带 `kind`，若只靠 `kind` 则回形针选的 PNG 不会显示缩略图（见点 5 / §7）。`kind` 仅作可选加速，**不得作为唯一判断依据**。

### 2.5 输入框 — `src/renderer/components/InputBox.tsx`

- `<textarea>` 增加 `onPaste`：**仅当 `clipboardData.items` 中存在 `image/*` 项时才 `preventDefault()` 并拦截**；纯文本粘贴（无 image 项）一律不拦截、不调用保存逻辑 → **文本粘贴/复制行为完全不变（防回归关键）**。命中图片时：前置判断 `blob.size` 是否超过上限（如 10MB），超限直接提示并 return，避免序列化大图跨进程（点 7）→ `blob.arrayBuffer()` → `window.omp.savePastedImage(buf, ext)` → 加入 `attachments`（带 `kind:'image'`，渲染判定以 `isImageFile` 为准，见 §2.4）。
- `.input-box` 增加 `onDrop` + `onDragOver` + **`onDragEnter`/`onDragLeave` 拖入高亮**（UX 反馈，工作量几行 CSS + 一个 state flag）。**`onDragOver` 必须 `preventDefault()` 否则 drop 不触发，但只对文件拖拽生效**：`onDragOver={(e)=>{ if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}`——避免无条件 preventDefault 吞掉 input-box 内其它拖拽（如选中文本拖动）。`onDrop` 从 `dataTransfer.files` 筛图片走同流程（同样先做 size 前置判断），**drop 完成后务必复位高亮 flag**。`onDragEnter`/`onDragLeave` 切换 `isDragOver` state → 给 `.input-box` 加/去一个高亮 class（如边框变色 `#3b82f6`）。**实现要点（防闪烁）**：用 ref 计数器（`dragDepth`）在 `onDragEnter` +1、`onDragLeave` −1，`isDragOver = dragDepth>0`，避免子元素导致的 dragleave 误触发复位；`onDrop` 与 `onDragEnd` 时归零。**此处理仅挂在 `.input-box` 局部，不影响侧栏/会话列表等其它区域拖放。**
- 附件芯片：用 `isImageFile(name)` 判定图片类 → `<img src={dataUrl}>` 缩略图（先 `useEffect` 调 `readImageAsDataUrl` 取 dataUrl 缓存，懒加载见 §3.3）；文件类保持原芯片。**回形针 `pickFiles` 选中的图片也走同一 `isImageFile` 分支，自动显示缩略图（点 5）**。

### 2.6 消息渲染 — `src/renderer/components/ChatView.tsx`

- 用户消息 `attachments` 区（L118）：用 `isImageFile(name)` 判定图片类 → 渲染内联缩略图（点击可放大，可选）；文件类保持原"在文件夹打开"芯片。
- 历史图片同样通过 `readImageAsDataUrl` 取图，**懒加载：图片进入视口（IntersectionObserver）后才请求 dataUrl**（见 §3.3）。**防回归：`readImageAsDataUrl` 失败（文件被清/无权限）必须 `.catch` 兜底——降级为原文件芯片（file 图标 + 名称 + 点击打开），绝不能抛错导致整条消息渲染崩溃或白屏。**

### 2.7 其余文件

- `src/shared/rpc-types.ts` / `electron/omp-process.ts`：**无需改**（仍是 `message` 字符串 + 路径）。

---

## 3. 关键决策 / 取舍（probe 后必须拍板）

1. **视觉模型前置条件（最重要，已彻底验证 + 已配置）**：粘贴图片"能被 agent 看懂"要求 omp 的 `config.yml` 中 `modelRoles.vision` 指向一个 **omp 注册表里 `"input":["text","image"]` 的模型**（如 `openrouter/google/gemini-2.5-flash`）。
   - ⚠️ **已证伪"改 `models.yml` 的 `input` 字段让 deepseek 当视觉模型"这条路**：注册表层覆盖生效，但 `inspect_image` 发请求前按 omp 内置能力库二次校验 vision 角色所属模型，该库写死 deepseek 为 text-only，故仍报"does not support image input"。（详见 §0.1）
   - ✅ **已满足**：用户已配 `modelRoles.vision: xiaomi/mimo-v2.5`（注册表 `input:["text","image"]` 已验证）。agent 端到端看懂图片的路径打通。
   - 应用侧仍可保留**软检测**（不阻塞）：发送含图消息时读 `omp models` / `get_state` 确认当前 vision 角色 image-capable，若某天用户改坏配置则给温和提示；但不再是"必须做"的阻断项（原 P6 降级为可选）。
2. **临时文件放哪 + 何时清**：
   - `userData/pasted-images`（持久）→ 历史图片长期可见，但需 LRU/按天清理防暴涨。
   - `.temp/clipboard`（omp 已有自动清理）→ 自动清理但历史图片会变裂图。
   - 推荐：放 `userData/pasted-images` + 简单 LRU（保留最近 N 张或 N 天）。
3. **缩略图/历史图片方案（已拍板）**：初始版本**统一用 `readImageAsDataUrl` 返回 dataUrl**，并实施**懒加载**——图片进入视口（IntersectionObserver）后才请求 dataUrl，且仅请求一次并缓存。实际场景中用户消息里的图片附件数量很少，base64 开销可控，**不要因性能担忧推迟交付**。后续若确有大量历史图片，再升级为主进程注册自定义 `protocol`（如 `ompimg://`）serve 临时图，比 dataUrl 省 IPC、易扩展——但属可选优化，不在首版范围。
4. **大图性能**：主进程 `nativeImage.resize` 后再落盘/编码。

---

## 4. 实施步骤（分阶段）

- **P0（已完成）**：probe 验证 omp 视觉管线 + 模型前置条件 → 本报告 §0。
- **P1（合并：通道定义 + 桥接 + 主进程 handler 同做）**：`ipc-channels.ts` 新增 2 个 channel 常量 + 类型 + `OmpApi` 方法声明 → `preload.ts` 桥接 → `main.ts` 注册 `SavePastedImage`/`ReadImageAsDataUrl` handler（含存盘白名单含 svg/gif、resize 仅限位图、大小校验、路径安全校验复用 `isWithinWorkspaces` + pasted-images realpath）。**注意顺序：通道常量必须先于 handler 注册（main.ts 引用 `IPC.SavePastedImage`），故三者同一步完成，不拆成先后两步（点 1）。**
- **P2**：`store.ts` 加可选 `kind` + 新增 `isImageFile()` 辅助函数（渲染判定以扩展名为准，kind 仅可选加速）。
- **P3**：`InputBox` `onPaste`/`onDrop`（含 `onDragOver` preventDefault、渲染侧 size 前置判断、缩略图芯片、回形针选图同样缩略图）。
- **P4**：`ChatView` 历史图片预览（懒加载取 dataUrl）。
- **P5**：视觉模型配置软检测（可选，降级）：发送含图消息时确认 `modelRoles.vision` 仍 image-capable，配置异常时温和提示。因用户已配 `mimo-v2.5`，此步非阻断、可后置或省略。
- **P6**：联调（粘贴截图 → 发送 → agent 用已配的 `mimo-v2.5` vision 模型描述图片内容，验证端到端"看懂图"）。
- **P7**：bump `package.json` patch 版本（约定：源码改动后 patch +1）。

---

## 5. 风险

- **核心风险**：未配置视觉模型时，功能"看起来能贴但 agent 看不到"（probe 已证实）。plan 中必须明确这是配置前置。
- 历史图片裂图（若走 `.temp` 清理）。
- 跨平台：renderer 侧 `clipboardData.items` 通用；macOS 系统剪贴板图片 API 不同，但粘贴事件里的 blob 仍可用。
- 多 omp 进程池：图片路径落在主进程 `userData`，与具体 omp 会话无关，无需按 session 隔离。

---

## 6. 与"另一份 AI 计划"的差异对照

| 点              | 另一份计划                    | 本合并计划修正                                                        |
| -------------- | ------------------------ | -------------------------------------------------------------- |
| file:// 不能用的原因 | 归咎 contextIsolation（不准确） | 实为 `webSecurity`/同源策略（contextIsolation 只隔离 JS 上下文）             |
| onDrop         | 只写 onDrop                | 必须补 `onDragOver` preventDefault，否则 drop 不触发                    |
| 临时目录           | `userData` 但没实现清理        | 明确放 `userData/pasted-images` + 必须做 LRU 清理                      |
| 图片/文件区分        | 两处正则扩展名                  | `store.ts` 加可选 `kind` + `isImageFile(name)` 辅助；**渲染以扩展名为准**，kind 仅可选加速（覆盖回形针无 kind 场景） |
| IPC 传参         | `Uint8Array`             | 传 `ArrayBuffer` 更稳                                             |
| 大小/类型校验        | 提到但代码未实现                 | 明确要实现 ext 白名单 + 10MB 上限                                        |
| omp 视觉能力       | 列为"取决于后端"                | **probe 证实：需 `modelRoles.vision` 配视觉模型，否则 `inspect_image` 失败**；且证伪"改 models.yml input 字段让 deepseek 当视觉模型"（内置库二次校验挡死） |
| 文件清单           | 5 文件                     | 补 `store.ts`（加 `kind` + `isImageFile`）                               |

---

## 7. 二次评审采纳点（对 §1–§6 计划再做 7 处修订）

| # | 另一 AI 质疑 | 处理（已并入计划） |
|---|------------|------------------|
| 1 | P1/P2 顺序反了（main.ts 引用 `IPC.SavePastedImage` 常量需先定义） | P1/P2 **合并为一步**：通道常量定义 + `preload` 桥接 + 主进程 handler 同做，不拆先后 |
| 2 | 历史图片 dataUrl 性能没拍板，会犹豫 | §3.3 拍板：首版统一 dataUrl + **懒加载（IntersectionObserver 进视口才请求）**，不推迟交付；protocol 方案降级为可选后续优化 |
| 3 | `nativeImage.resize` 对 GIF 丢帧 / SVG 返回空图 | resize **仅限定位图** `{png,jpg,jpeg,webp,bmp}`；`gif`/`svg` **原样落盘、跳过 resize** |
| 4 | ext 存盘白名单 与 resize 白名单是两概念，被混写 | 拆开：存盘白名单含 `svg/gif`（决定能不能存）；resize 白名单仅位图 |
| 5 | 回形针 `pickFiles` 选的图也该缩略图，但其 `PickedFile` 无 `kind` | 渲染判定以 `isImageFile(name)` **扩展名为准**，`kind` 仅可选加速（采纳做法 A，对 `DialogOpenFiles` IPC 改动最小） |
| 6 | `ReadImageAsDataUrl` 路径校验实现细节缺失 | 复用 `main.ts` 已有 `isWithinWorkspaces()`（realpath + 小写归一化）+ `pasted-images/` 目录 realpath 校验，**防符号链接逃逸** |
| 7 | 大小校验应在主进程 + 渲染进程前置 | 主进程权威校验；**渲染进程 paste 时先查 `blob.size` 前置拦截大图**，避免 100MB 图白序列化跨进程 |

---

## 8. 对既有功能的影响评估（防回归清单）

> 结论：**整体低风险**。本功能为纯增量（新增 IPC 通道/类型/方法、新增 2 个主进程 handler、附件类型加可选字段、InputBox/ChatView 增加图片分支），不改动任何现有发送/渲染契约。以下逐处核对"会不会伤到现有功能"，并列出必须实现的护栏。

| 既有功能 | 受影响面 | 风险 | 护栏（已在计划中） |
|---|---|---|---|
| **文本粘贴 / 复制**（Ctrl+V 发文本） | InputBox 新增 `onPaste` | 中（若误吞文本） | **仅当 `image/*` 项存在才 `preventDefault()`**；纯文本 paste 不拦截、不调保存（§2.5） |
| **Enter 发送 / Shift+Enter 排队、slash 命令弹窗** | InputBox `onKeyDown` | 无 | 粘贴/拖拽是独立事件，不触碰 `onKeyDown`；图片附件走同一 `attachments` 数组，`submit()` 逻辑不变 |
| **回形针选文件附件（pickFiles）** | `DialogOpenFiles` handler、`PickedFile` | 无（反有增强） | 不改动该 handler；选中的图片经 `isImageFile(name)` 自动显示缩略图（§2.4/§2.5） |
| **附件发送链路**（buildPromptWithAttachments，App.tsx） | 图片路径同文件一样拼进 prompt | 无 | 不改动 App.tsx；图片 `Attachment{path}` 与文件同构，`submit()` 照旧发送 |
| **消息历史渲染**（ChatView 用户消息附件芯片） | 新增图片分支 | 中（历史图丢了会崩） | 图片分支 `readImageAsDataUrl` **必须 `.catch` 兜底降级为文件芯片**，不抛错（§2.6） |
| **多 omp 进程池 / 会话** | 图片存 `userData` 全局 | 无 | 绝对路径对同用户子进程可读；与具体会话无关，不触动进程池架构 |
| **工作空间安全校验** `isWithinWorkspaces` | `ReadImageAsDataUrl` 复用 | 无 | 直接复用现有 realpath+小写归一化逻辑；并补 `pasted-images/` realpath 校验（§2.3） |
| **现有 IPC 通道 / OmpApi 契约** | 新增 2 通道 + 2 方法 | 低（类型强约束） | 通道名唯一；`OmpApi` 接口与 `preload` 实现同步加，缺一则 TS 编译报错被拦下 |
| **剪贴板写文本** `ClipboardWriteText` | 新增图片保存走 blob，不用 clipboard | 无 | 不动现有 `clipboard.writeText`；主进程甚至不需要 `clipboard.readImage` |
| **拖拽其它 UI（侧栏/会话列表）** | InputBox 局部 `onDrop` | 低 | 处理仅挂在 `.input-box`；`onDragOver` 只对 `Files` 类型 preventDefault（§2.5） |
| **历史消息持久化（JSONL）** | 存的仍是 `Attachment{path}` 字符串 | 低 | 路径指向 `userData/pasted-images`（持久）；仅"清临时图"会导致裂图，已在 §3 记录 |

**实施期强制检查项（防回归）**：
1. 加完 `onPaste` 后，先手测"在输入框 Ctrl+V 一段文本"必须正常出现、可发送——这是最高优先回归。
2. 历史消息里删掉某 pasted-image 文件后打开会话，ChatView 不得白屏/报错，须降级芯片。
3. 回形针选 PNG / 拖拽 PNG / 粘贴截图 三条路径都进同一 `isImageFile` 分支，缩略图与文件芯片样式互不串。
4. 不改动 `App.tsx`、`rpc-types.ts`、`omp-process.ts`，保证发送契约零变动。
