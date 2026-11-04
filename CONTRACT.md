# vision 服务契约

服务版本 1.0.0；插件版本 0.1.1。状态：媒体准备服务可用；具备 `ctx.tools.registerMultimodal` 的宿主可使用原生视觉工具。公开类型见 `src/types.ts`。视频组件随 Windows x64 包内置，路径不再是用户配置。

## 依赖与职责

消费者声明 `optionalDepends: [vision]`，通过 `ctx.optional('vision', binding => ...)` 绑定；旧宿主只在明确声明必需依赖时用 `depends`/`ctx.get`。不得在无声明的情况下读取服务或其他插件的 data。可选视觉停用后，平台的文字、原有识图、语音和登录保持原样。

消费者固定实际会话，在可信后端取得原始媒体。`sessionId` 必须来自当前可信工具上下文或该条入站消息绑定，不由模型随意指定，也不在中途重新读全局当前会话。本服务按 ID 隔离引用；它不能独立证明可信调用插件提交的 ID 是否真实，因此取图插件承担会话真实性与授权责任。

## 方法

每个异步方法可传 `{signal?: AbortSignal}`，调用方应组合绑定信号与本次请求信号。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `status()` | 无 | 准备状态、主模型查看缺口、容量、处理数；没有图片/引用列表/私有路径/模型连接 |
| `offerMedia(input, options?)` | `{sessionId, mime, base64}` | `{mediaRef, expiresAt, info}`，固定 MIME、宽高、类型、时长等。仅短期暂存，不收藏，不调用模型 |
| `describe(input, options?)` | `{sessionId, mediaRef}` | 同样的引用和元信息，不带正文或原图 |
| `prepare(input, options?)` | `{sessionId, mediaRef, fromSeconds?, toSeconds?, atSeconds?, detail?, layout?, crop?}` | `PreparedMedia`，可信服务使用的图片字节及时间/范围/尺寸，**不是模型工具结果** |
| `release(input, options?)` | `{sessionId, mediaRef}` | `{released:true}`，立即禁止新读取；在途读取丢弃结果并释放其文件 |

只接收标准 base64 原始字节，不接受 URL、data URL、文件路径、平台 Cookies 或下载密钥。支持 `image/jpeg`、`image/png`、`image/webp`、`image/gif`、`video/mp4`、`video/webm`，声明类型与内容不一致时拒绝。EBML 容器使用受限 Matroska/WebM 解复用器，文件扩展名不作为可信判断。

`detail` 为 `overview` 或 `detail`；`layout` 为 `frames`（默认）或 `sheet`。`crop` 的 x/y/width/height 都是相对已转正画面的 0–1 比例，不能越界。指定时刻与时间段互斥；静态图片不接受时间参数。时间段是 `[fromSeconds,toSeconds)`，不得超过媒体结尾或 60 秒；未指定时从 0 开始看最多 30 秒。指定时刻必须早于媒体结尾。

`images` 每项包含 MIME、base64、实际尺寸、各画面的编号/时间/拼图区域。`coverage` 记录请求范围、下一段位置、采样时间网格、候选省略数和 `audioIncluded:false`。时间为采样请求位置，不能当作逐帧精确事件证据。`timelineComplete:false` 明确未提供逐帧完整观看。消费者自己管理已查看的片段；未查看的时间段不会被服务默认为已看。

GIF/WebP 使用帧延时选择对应页面，缺失延时时声明估算。原字节在引用有效期内保持完整，处理图不覆盖原图；服务不提供永久原图仓库或发送成功回执。

## 生命周期、资源和错误

- 默认 TTL 1800 秒，允许 30–7200 秒。默认单份 64 MiB、总量 256 MiB，最高分别 64/512 MiB。单份上限同时考虑跨进程 base64 传输的内存开销；图片仍有 25 MiB 的固定上限。容量满时拒绝新请求，不静默淘汰别人的媒体。
- 每会话最多 16 引用，总计最多 64；最多 2 个同时进行的调用，超出返回 `busy`。单操作 120 秒，单次视频解码 30 秒；文件、子进程和输出大小均受限。
- 解码只访问本插件暂存文件。FFmpeg 使用固定参数数组、无 shell、禁 stdin、隐藏窗口，并限制输入协议/格式。原始 stderr 不回传或日志化；取消只终止本次拥有的解码子进程。
- `status().decoder` 返回 `{ready,source:'bundled',version,problem}`，不返回本机路径；`videoDecoder` 为 `bundled` 或 `unavailable`。启动验证固定程序摘要和可运行性，缺失/损坏只关闭视频处理，图片/GIF 不依赖这些程序。旧配置中的 `ffmpegPath` / `ffprobePath` 忽略，不执行它们，也不退回系统 PATH。
- 过期、释放、停用或跨会话读取统一返回 `media_unavailable`，无法通过错误区分别人的引用。旧实例服务由宿主撤销；重载后引用不恢复。
- `quota`/`busy` 表示容量/并发限制；`unsupported_media`/`mime_mismatch`/`decode_failed` 表示输入问题；`decoder_unavailable`/`decoder_timeout` 表示视频解码问题；`invalid_input` 表示范围/参数错误；`output_limit` 表示返回图片太大；`cancelled`/`stopped` 表示生命周期终止。
- 所有异常只返回固定错误码和简短说明。媒体正文、base64、路径和用户给出的取消原因不被写入错误。不会调用模型或产生平台副作用，失败不自动重试。

## 最小接入示例

```ts
ctx.optional<VisionService>('vision', binding => {
  if (!binding) return;
  // 使用者自己的工具/入站处理器在 binding.effect 范围中注册和释放。
  // trustedSessionId 来自已固定的实际会话；originalBytes 来自平台合法取得的原文件。
  async function offer(trustedSessionId, originalBytes, mime, requestSignal) {
    return binding.service.offerMedia({
      sessionId: trustedSessionId, mime, base64: originalBytes.toString('base64'),
    }, { signal: AbortSignal.any([binding.signal, requestSignal]) });
  }
});
```

不要把 `prepare()` 注册为普通模型工具，也不要将其图片结果 JSON.stringify 后作为文字提交给模型。

## 主模型工具

`vision_status` 始终提供服务状态。仅在检测到公开 `ctx.tools.registerMultimodal` 时注册 `vision_view`：模型参数是 `PrepareInput` 去掉 `sessionId`，会话 ID 取自可信 `ToolSession.id`，模型传入的额外 `sessionId` 被忽略。使用者以同一会话的来源引用调用工具，获得原生文字/图片内容块。

图片转换为 `{type:'image',mimeType:'image/jpeg',data:Uint8Array,detail:'auto'|'high'}`，按宿主通用多模态契约传入当前模型。工具说明包括时间范围、编号、采样限制和未包含声音；图片不经过另一个模型代看。主干负责模型协议、临时持久化隔离和实际请求用量。

持久回执只记录 `prepare_visual_input` 动作、类型、图片数量、时间范围和 `prepared`/`failed`，不存原图、临时引用、描述或最终回复。`prepared` 表示准备了视觉输入，不伪称模型已经理解或平台发送成功。`mainModelViewing:true` 只证明宿主接口可用，不证明任意所选模型支持图片。

当前宿主上限为单图 4 MiB、每轮累计 16 张/16 MiB；本插件单次最多 8 张/8 MiB，独立图片不超过 2 MiB。多次补看仍受宿主本轮累计限制，消费者需要合理分段。旧宿主不注册 `vision_view`，不回退到普通/临时 JSON 工具。

需求、兼容和隐私验收见 [CORE-REQUEST.md](CORE-REQUEST.md)。QQ、图库及其他来源插件由各自负责会话接入，本仓库不代改。
