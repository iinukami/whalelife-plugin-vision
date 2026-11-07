# vision 服务契约

插件版本 0.2.0，插件 ID 保持 `vision`。原有视觉服务版本 `1.0.0` 继续兼容；新增视听扩展 `audiovisualApiVersion:"1.0.0"` 和 `understand()`。公开类型见 `src/types.ts` 与 `src/audio-types.ts`。旧 `prepare()` / `vision_view` 不包含声音，保留 `audioIncluded:false`。

## 依赖、授权和来源

消费者声明 `optionalDepends: [vision]`，通过 `ctx.optional('vision', binding => ...)` 绑定，在绑定生命周期内使用服务。确实要求必需依赖时才声明 `depends` 并使用 `ctx.get`。不得无声明取服务、读取其他插件 data，或替代来源插件登录、下载、授权、收藏与外发。

`sessionId` 必须来自当前可信工具上下文或已固定的入站消息绑定，不能由模型随意指定，也不能中途重读全局当前会话。服务隔离引用，但无法独立证明可信调用者提供的 ID 是否真实；来源插件承担会话真实性和媒体获取权限责任。停用本插件不应破坏来源插件的文字、原有识图、语音或登录。

## 方法与兼容

异步方法接受可选 `{signal?: AbortSignal}`，调用方组合绑定信号与本次请求信号。消费者调用新方法前检测扩展版本及函数存在性；旧服务仍可仅作视觉准备。

| 方法 | 输入 | 返回与语义 |
| --- | --- | --- |
| `status()` | 无 | 服务/扩展版本、解码和声音资源状态、容量/处理数；无媒体正文、引用列表、凭据或本机路径 |
| `offerMedia(input, options?)` | `{sessionId,mime,base64}` | `{mediaRef,expiresAt,info}`；检查并短期暂存，不调用模型 |
| `describe(input, options?)` | `{sessionId,mediaRef}` | 引用与媒体元信息，无正文 |
| `prepare(input, options?)` | `PrepareInput` | 旧 `PreparedMedia`，仅图片字节及视觉采样信息；不是普通模型 JSON 工具结果 |
| `understand(input, options?)` | `UnderstandInput` | `UnderstoodMedia`：所选画面和按用途产生的声音文字证据，支持部分失败 |
| `release(input, options?)` | `{sessionId,mediaRef}` | `{released:true}`；立即禁止新读取，在途读取丢弃结果 |

仅接收标准 base64 原始字节，不接受 URL、data URL、文件路径、Cookies 或下载密钥。支持 `image/jpeg`、`image/png`、`image/webp`、`image/gif`、`video/mp4`、`video/webm`，以及 `audio/wav`、`audio/mpeg`、`audio/flac`、`audio/ogg`、`audio/mp4`、`audio/webm`；声明与内容不符拒绝。音频元信息 `kind:"audio"`、宽高为 0、`frameCount:null`；`hasAudio` 表明是否有音轨。音频限 8–192 kHz、1–8 声道和有效时长，视频/音频最长 3600 秒。实际可交入大小仍受容量限制。

`PrepareInput` 包含 `sessionId`、`mediaRef`，以及可选 `fromSeconds`、`toSeconds`、`atSeconds`、`detail`、`layout`、`crop`。`detail` 为 `overview|detail`，`layout` 为 `frames|sheet`，默认概览独立图片。裁剪 x/y/width/height 使用转正画面的 0–1 比例，不能越界。

时间段为 `[fromSeconds,toSeconds)`；默认从 0 起处理最多 30 秒，单次最大 60 秒，不越过结尾。`atSeconds` 与时间段互斥，且早于结尾；静态图不接受时间参数。图片返回实际尺寸、编号、采样时间及拼图区域。`coverage` 记录范围、下一段、采样网格及省略数，`timelineComplete:false`；采样位置不能当作逐帧精确事件时间。GIF/WebP 按帧延时选帧，缺失延时时声明估算。

## 视听理解输入和时间

`UnderstandInput` 在原参数上增加：

- `visual?: boolean`：图片/视频默认 true，纯音频默认 false。
- `audio?: ('speech'|'sound'|'rhythm'|'melody'|'chords'|'structure')[]`：未指定时，有音轨且不是指定时刻查看则默认 `['speech']`，其他情况默认空；显式 `[]` 表示只看。重复任务去重。
- `atSeconds` 不与声音任务同时使用；看听同一段应使用 from/to。全部关闭会拒绝。请求声音但没有音轨时返回 `no_audio`，不伪造无声转写。

画面与声音在一次引用使用期间取同一份原始媒体，避免两套来源缓存或错配时间轴。音频解码为本次范围内的 16 kHz 单声道 PCM16 WAV。`audio.coverage` 报告实际解码覆盖，不能把请求结尾当作已取得的音频。后端只收到此片段。

`UnderstoodMedia.status` 为 `completed|partial|failed`；`visual` 是可选的旧 `PreparedMedia`，视觉失败另有安全错误信息；`audio.status` 为 `completed|partial|failed|not_requested|no_audio`。每项声音结果含 `task`、`backend`、`status`，成功给 `evidence`，失败给固定错误码和说明。单项失败不冒充全体成功。

`AudioEvidence` 含 `text`、`timing:'segment'|'clip'`、`warnings`，可含 `segments`、`events`、`details`、`usage`。下列时间含义不得混用：

- 画面时间、返回覆盖范围、证据**顶层** `segments[].startSeconds/endSeconds` 均为源媒体秒数；协调层已加一次片段起点。
- 本地音乐 `details.timeOrigin:"clip_start"` 内音符、和弦、变化点和分段时间，以及云端分析正文中的时间，相对本片段起点，不是源媒体时间。
- 本地语音时间来自 VAD 分段，不是逐字对齐；云端未返回可信时间时只有 clip 级证据。云端声音/音乐描述不能推导精确时间。
- 分数、候选和事件标签不是校准概率。超长证据会截断并声明不完整，必要时移除明细与分段；调用方应缩小范围补听，不自行补造细节。

本地节奏、混合音高、三和弦模板及局部变化点都是有限估计，无声部分离、完整曲谱或整曲段落标签。具体能力边界见 README 的用途表。

## 后端与资源

插件配置 `audio` 为：

```json
{
  "speechBackend": "local",
  "speechModelId": "",
  "understandingModelId": "",
  "musicBackend": "local",
  "resourceProxyUrl": ""
}
```

语音和音乐用途分别显式选择 local/cloud，默认 local；复杂 `sound` 固定调用云端理解。无自动回退、隐式模型选择或额外人格/会话。选中模型的连接由公开 `ctx.models.connection(id)` 读取，不把密钥写入插件配置、状态或日志。

`resourceProxyUrl` 仅供显式本地资源准备使用，默认空字符串（直连）；只接受不含凭据、查询、片段或额外路径的 HTTP/HTTPS 代理地址。不改变固定资源来源、大小和摘要，不自动直连回退。代理连接随准备任务结束、失败或取消关闭；云端模型请求仍使用各自所选连接的代理。

云端语音须 `stt` 类型、`openai-compatible` 协议，发送 `/audio/transcriptions` multipart WAV。云端理解须 `chat|custom` 类型、同一协议，并实际支持当前 `/chat/completions` 的 Qwen-Omni 兼容 `input_audio` WAV、SSE、文字输出。连接能力不由名称保证；错误类型、协议、不完整输出或提供商失败均明确失败。沿用选中连接的超时及 HTTP/HTTPS 代理，不自动重试。提供商实际返回的已知用量可作为 evidence usage 返回；插件自行调用的声音请求不会自动成为当前主模型的用量记录。

本地语音限 Windows x64，固定 8 CPU 线程。`start()` 仅核验资源，工具不准备资源；设置页显式按钮调用资源准备接口，固定来源、版本、大小及 SHA-256，总下载量 `260887284` 字节。页面只见 ready/phase/downloadBytes/totalBytes 等安全状态。重复准备合并，校验后原子安装；停用取消，失败可重试，不接受自定义路径、命令或 URL。本地声音任务共用串行队列（在途/等待最多 4 项）；音乐无需权重。模型文件保留，识别 WAV 用后清理。

## 主模型工具、回执和持久化

`vision_status` 提供状态。具备公开 `ctx.tools.registerMultimodal` 时注册旧 `vision_view` 与新 `media_understand`；旧宿主不回退为含 base64 的普通 JSON 工具。模型参数没有 `sessionId`，会话固定为可信 `ToolSession.id`。来源插件通常只需提供引用，由本插件工具负责准备与呈现，调用便利不要求来源插件复制整个工具流程。

图片转换为 `{type:'image',mimeType:'image/jpeg',data:Uint8Array,detail}`；声音作为附有来源、时间和限制的文字证据交给当前主模型，**没有原始音频块**。所有资料明确标为外部证据，不是指令或授权。视觉仍使用当前模型，不暗中另选视觉模型；`mainModelViewing:true` 只证明宿主 API 存在，不证明该模型实际支持图片。

旧回执为 `prepare_visual_input`；新回执为 `prepare_audiovisual_input`，只记录动作、结果、类型、图片数量、范围及各声音任务后端/状态/错误码。没有原图、原声、引用、完整转写或描述；准备完成不证明模型已经理解或来源平台已经发送。

临时工具原始资料与后续复制参数按宿主契约隔离。**普通 Web、频道及普通 sessions 调用的最终 assistant 回答仍正常持久化**，可包括实际引用内容；不得承诺最终回答全不留存。显式技术 transient 入口的输入与最终输出规则以现行主干公开契约为准。宿主管理主模型协议与实际图片请求用量。

## 限制、生命周期与错误

- TTL 默认 1800 秒，可设 30–7200 秒；默认单份 64 MiB、总量 256 MiB，上限分别 64/512 MiB。图片仍限 25 MiB/4000 万像素，动画最多 2000 帧。每会话 16 引用、全局 64，容量满拒绝，不静默淘汰其他媒体。
- 服务最多 2 个同时调用；旧操作最多 120 秒，视听理解最多 240 秒，单次解码 30 秒，本地识别 180 秒，本地音乐 45 秒。输出有独立容量限制，插件单次图片最多 8 张/8 MiB，单张不超过 2 MiB；宿主当前单图 4 MiB、每轮累计 16 张/16 MiB。
- 解码仅用插件暂存文件、固定参数和内置程序，无 shell/系统 PATH，禁 stdin、隐藏窗口并限制协议/格式。原始 stderr、路径、凭据、媒体正文和取消原因不回显。旧自定义解码路径忽略。
- 取消、释放、过期和停用会终止所属子进程/工作线程或丢弃迟到结果，清理自有媒体；重载不恢复引用。启动清理确切自有的遗留媒体和识别片段，遇符号链接/未知内容拒绝危险清理。权重资源不会随单次任务删除。
- `media_unavailable` 统一覆盖过期、释放、停用及跨会话访问；`busy`/`audio_busy`/`quota` 表示资源限制。输入、解码、模型连接、资源准备、推理和输出错误均用固定安全码区分。部分声音失败可保留画面或其他成功任务。
- `prepare()` 与 `offerMedia()` 本身不调用模型；`understand()` 只按所选任务和后端运行，可能调用选定云端服务。没有收藏、平台发送或其他平台副作用。

## 最小来源接入

```ts
ctx.optional<VisionService>('vision', binding => {
  if (!binding) return;
  // 自己的处理器注册/释放须跟随 binding 生命周期。
  async function offer(trustedSessionId, originalBytes, mime, requestSignal) {
    return binding.service.offerMedia({
      sessionId: trustedSessionId, mime, base64: originalBytes.toString('base64'),
    }, { signal: AbortSignal.any([binding.signal, requestSignal]) });
  }
});
```

不要把 `prepare()` / `understand()` 的含图服务返回值直接注册成普通 JSON 工具，也不要将 base64 JSON 当作视觉输入。来源与主干协作边界见 [CORE-REQUEST.md](CORE-REQUEST.md)。
