# 第三方运行组件的来源与发行要求

## 内置 FFmpeg

Windows x64 发行包携带 Gyan 的 FFmpeg 9.0.2 essentials 静态构建中的 ffmpeg 与 ffprobe，未修改二进制，不打包 ffplay。固定下载地址、上游校验值、逐文件摘要和 FFmpeg 源码提交见 [ffmpeg.json](ffmpeg.json)，不追随 latest。

- [构建提供方](https://www.gyan.dev/ffmpeg/builds/)
- [固定发行 9.0.2](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)
- [对应 FFmpeg 源码提交](https://github.com/FFmpeg/FFmpeg/commit/946fcce07b)
- [FFmpeg 分发说明](https://ffmpeg.org/legal.html)

原始 GPL 许可证和完整 README（包括构建配置、组件清单）随两个程序放在 `runtime/ffmpeg/win32-x64/`；程序保留原始版本/版权/构建信息。公开分发二进制安装包时，发布方须按许可提供该构建及静态依赖的完整对应源码和必要构建材料；单独的 FFmpeg 源码链接不替代所有静态依赖源码。

0.1.1 历史上曾构建并经授权安装本机。当前 0.2.0 开发未安装正式宿主、上传二进制或创建远端 Release。源码仓库不提交组件缓存与发行物。

## 可选 SenseVoice CPU 资源

资源只在用户点击设置页按钮后下载，启动和工具调用不下载。固定清单为 [sensevoice.json](sensevoice.json)，内部资源目录 ID `sensevoice-cpu-v0-2-1-q8`，Windows x64 CPU、固定 8 线程。下载总量 **260887284 字节**；磁盘另需解压/校验/原子安装的临时空间。

| 资源 | 固定版本或修订 | 下载字节 | SHA-256 |
| --- | --- | ---: | --- |
| `runtime.zip` | `runtime-llamacpp-v0.2.1` | 4958452 | `b8f2b8f241b57921d82d64068d9b5695629779f3db5f3205a730cb3810232bb4` |
| `sensevoice-small-q8.gguf` | `90c1c61912018b70ada0fcc024ea24aca62f2e63` | 254208320 | `4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5` |
| `fsmn-vad.gguf` | `6840bae4c5c92ee8c04faaf4db23dd0105098d7f` | 1720512 | `1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479` |

下载来自公开发行及模型仓库，资源大小和摘要取自 GitHub release asset 与 Hugging Face Git LFS 元数据（2026-11-07 核对），不按模型卡的约数估算：

- [QwenAudio/SenseVoice 固定二进制归档](https://github.com/QwenAudio/SenseVoice/releases/download/runtime-llamacpp-v0.2.1/funasr-llamacpp-windows-x64.zip)
- [SenseVoiceSmall q8 固定模型文件](https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/90c1c61912018b70ada0fcc024ea24aca62f2e63/sensevoice-small-q8.gguf)
- [FSMN-VAD 固定模型文件](https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/resolve/6840bae4c5c92ee8c04faaf4db23dd0105098d7f/fsmn-vad.gguf)

二进制镜像发行说明指向 **modelscope/FunASR** 构建，并非直接由镜像仓库该标签的源码构建。实际对应源码为 [FunASR c69e69a0b78fb9becc8b2be91db8ae57d2a41f3c 的 runtime/llama.cpp](https://github.com/modelscope/FunASR/tree/c69e69a0b78fb9becc8b2be91db8ae57d2a41f3c/runtime/llama.cpp)，[上游固定发行](https://github.com/modelscope/FunASR/releases/tag/runtime-llamacpp-v0.2.1)，构建工作流 run `32991388379`。该源码实际固定 llama.cpp `803b7fcae893e9caaee3921779628fef83ac0965`，不能用镜像旧源码中的另一修订代替归属。

FunASR 和 llama.cpp 为 MIT；随源码的 miniaudio 提供公有领域/Unlicense 或 MIT-0 选择，本文采用 MIT-0 说明。两个模型的固定模型卡声明 Apache-2.0。精确版权、链接和许可文本集中在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，该文件随插件发行包复制；原作者许可不被本插件原创代码许可替代。当前发行包不预装这些权重，若未来重新分发资源，应保留上游版权/NOTICE 和适用许可，重新核验分发材料。

本轮仅读取发行元数据、源码和许可说明，没有下载以上归档/权重或运行真实识别。开发测试用合成归档、模型占位字节和模拟进程，不构成实际资源兼容性或性能验收。
