# FFmpeg 获取与安装说明

本说明供用户和安装 agent 使用。FFmpeg 是独立的第三方项目，本插件用它读取媒体信息、提取视频画面和解码声音。**FFmpeg 不是语音识别模型，也不需要模型 API Key。** 本地语音模型另在插件设置中准备。

当前插件支持 **Windows x64**，固定使用 Gyan 提供的 **FFmpeg 9.0.2 essentials_build**，包含配套的 `ffmpeg.exe` 和 `ffprobe.exe`。版本、下载地址、文件大小和 SHA-256 以随插件附带的 [ffmpeg.json](ffmpeg.json) 为准。插件会核验确切文件，其他版本、full/shared 构建或同版本不同构建不能直接替代。

## 选择安装方式

| 当前情况 | 操作 |
| --- | --- |
| 从本插件源码安装，目录内有 `scripts/prepare-runtime.mjs` | 使用下方“从源码准备”，推荐安装 agent 采用 |
| 已有插件目录，FFmpeg 缺失或损坏 | 使用下方“手动补齐”，保留插件数据与配置 |
| 插件已经显示视频组件就绪 | 无需重复安装 |

FFmpeg 只放在**本插件的** `runtime/ffmpeg/win32-x64/`。无需配置系统 PATH；装到系统其他位置不会自动被本插件采用。插件启动和媒体工具调用不会下载 FFmpeg，设置页的“一键准备本地能力”准备的是语音资源，不负责补齐 FFmpeg。

## 从源码准备（推荐）

使用 Node.js 24.22.1 或更新版本，在 **whalelife-plugin-vision 源码根目录**打开 PowerShell。需要 Windows 自带的 `tar.exe`；开发检查所需宿主源码按 [README](../README.md) 放在同级 `whalelife` 目录。

依次执行，每步成功后再进行下一步；报错时先处理报错，不继续安装失败的产物：

```powershell
node --version
npm ci --ignore-scripts
npm run setup:media
npm run build
```

- `setup:media` 从固定上游地址下载 ZIP，校验归档摘要及解压后四个文件的大小和摘要，放入源码目录的 `runtime/ffmpeg/win32-x64/`。已有合格文件时直接复用。
- `build` 也会执行同一准备流程，因此 `setup:media` 可以省略；单独执行它便于先确认下载成功。构建结果在 `dist/vision/`，已包含校验后的 FFmpeg。
- 以上命令不会安装、启动或重载 WhaleLife，也不会下载语音模型。将本地构建结果用于安装时，按宿主插件安装流程放入 `plugins/vision/`，升级保留原有 `data/` 和配置。

**已有安装目录通常没有 `scripts/`。即使其中的 package.json 列有 setup:media，也不能在该目录执行这组源码命令。** 应回到源码目录构建，或按下一节补齐组件。

## 手动补齐已有插件

本节以其余插件文件和生产依赖已经安装完整为前提；仅复制 FFmpeg 四个文件不能代替安装整个插件。

### 1. 从上游取得固定 ZIP

- [FFmpeg 官方下载入口](https://ffmpeg.org/download.html)：Windows 构建来源可从这里核对。
- [Gyan 构建说明](https://www.gyan.dev/ffmpeg/builds/)。
- [本版固定 ZIP：ffmpeg-9.0.2-essentials_build.zip](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip)。
- [上游 9.0.2 发行页](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)：如从此页下载，选择同名 ZIP 附件；不要选择 `Source code`、full、shared 或其他版本。

下载到自己选定的临时目录。归档约 109.5 MiB，解压、备份和安装还需要额外磁盘空间。不要从不明网盘取得 EXE，也不要将 `latest` 当作本版固定资源。

### 2. 校验归档后再解压

在 PowerShell 中进入**插件根目录**（此处应能看到 `vendor/ffmpeg.json`），将示例下载路径改为实际路径：

```powershell
$ffmpegManifest = Get-Content -LiteralPath '.\vendor\ffmpeg.json' -Raw | ConvertFrom-Json
$ffmpegArchive = 'C:\Downloads\ffmpeg-9.0.2-essentials_build.zip'
$ffmpegArchiveHash = (Get-FileHash -LiteralPath $ffmpegArchive -Algorithm SHA256).Hash
if ($ffmpegArchiveHash -ne $ffmpegManifest.archiveSha256) {
    throw 'FFmpeg ZIP 摘要不匹配，请停止安装并重新核对下载来源。'
}
```

当前归档的 SHA-256 为 `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`。校验通过后，用 Windows 解压功能将 ZIP 解压到新的临时目录。

### 3. 放入本插件目录

确认没有正在处理的媒体任务，在宿主插件管理中停用本插件后再替换文件。若目标已有文件，先备份本次要替换的四个文件；不要删除整个插件目录。按下表复制文件，目标父目录不存在时创建普通目录，不使用符号链接或目录联接。

路径均相对于解压得到的 `ffmpeg-9.0.2-essentials_build/` 和安装好的 `plugins/vision/`：

| 解压目录中的文件 | 插件目录中的目标文件 |
| --- | --- |
| `bin/ffmpeg.exe` | `runtime/ffmpeg/win32-x64/ffmpeg.exe` |
| `bin/ffprobe.exe` | `runtime/ffmpeg/win32-x64/ffprobe.exe` |
| `LICENSE` | `runtime/ffmpeg/win32-x64/LICENSE` |
| `README.txt` | `runtime/ffmpeg/win32-x64/README.txt` |

保留原始许可证和构建说明，无需复制 `ffplay.exe`。不要多套一层 `bin/` 或版本目录，也不要覆盖宿主的 `runtime/`、其他插件、`data/` 或配置。

### 4. 核验后启用

仍在插件根目录执行，逐项对照本插件清单验证四个文件；任何报错都应先解决：

```powershell
$ffmpegManifest = Get-Content -LiteralPath '.\vendor\ffmpeg.json' -Raw | ConvertFrom-Json
$ffmpegRuntime = '.\runtime\ffmpeg\win32-x64'
foreach ($ffmpegEntry in $ffmpegManifest.files.PSObject.Properties) {
    $ffmpegFile = Join-Path $ffmpegRuntime $ffmpegEntry.Name
    $ffmpegInfo = Get-Item -LiteralPath $ffmpegFile -ErrorAction Stop
    $ffmpegHash = (Get-FileHash -LiteralPath $ffmpegFile -Algorithm SHA256 -ErrorAction Stop).Hash
    if ($ffmpegInfo.Length -ne $ffmpegEntry.Value.bytes -or $ffmpegHash -ne $ffmpegEntry.Value.sha256) {
        throw "FFmpeg 文件校验失败：$($ffmpegEntry.Name)"
    }
}
```

校验全部通过后，分别执行以下版本检查；两者均应成功退出并显示 `9.0.2-essentials_build`：

```powershell
& '.\runtime\ffmpeg\win32-x64\ffmpeg.exe' -version
& '.\runtime\ffmpeg\win32-x64\ffprobe.exe' -version
```

在宿主插件管理中重新启用本插件，再查看设置页的视频组件状态。插件启动时会重新核验两个 EXE 的大小、摘要与版本；仅复制成功或文件名正确不代表已就绪。已经启用的插件补齐文件后也需要重新加载，才会重新检查。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 下载超时或连接失败 | 核对网络及上述上游地址；可手动取得同一 ZIP 并校验。源码准备脚本不读取插件设置页的“资源下载代理”，该设置只供本地语音资源下载使用 |
| ZIP 或文件摘要不匹配 | 停止安装，检查是否选错版本、构建或文件；不要改清单来绕过校验 |
| 命令找不到 scripts/prepare-runtime.mjs | 当前是安装目录或不完整源码；改用手动方式，或回到完整源码根目录 |
| 系统能运行 ffmpeg，插件仍显示缺失 | 检查本插件内的固定位置、两个 EXE 是否配套，并重新加载插件；系统 PATH 不参与查找 |
| 文件正确但无法启动 | 检查 Windows x64 架构、文件访问权限和系统拦截提示；不要自动关闭安全软件 |
| FFmpeg 就绪但本地转写未就绪 | 到插件设置中准备本地语音资源；云端用途则配置相应模型连接，见 [README](../README.md) |

## 给安装 agent 的完成标准

1. 先区分源码根目录、构建目录和正式插件目录，以当前插件附带的清单为准；只从指定上游取得匹配资源，不自行换源、换版本或改校验值。
2. 四个文件校验通过、两个程序版本检查成功，重新加载后的插件显示视频组件就绪，才报告组件安装完成。FFmpeg 就绪不等于语音模型、云端连接或完整视听链路已验收。
3. 保留用户数据、配置及其他插件；重载会使已有短期媒体引用失效，先等媒体任务结束。需要进一步媒体验收时使用合成材料。
4. 如需启动正式宿主，使用用户可见的 CMD 窗口并保持开启供用户接手；先核对已有实例，避免重复启动。
5. 报告实际使用的版本、安装目录、校验结果和未完成项。失败时说明具体阶段，不把下载成功写成安装完成。

本说明用于用户在自己的机器上取得和安装第三方组件。FFmpeg 及其依赖保留各自版权与许可；如果另行公开分发含这些二进制的安装包，仍需完成 [来源与发行要求](SOURCES.md) 及现有发布检查，不能用本说明代替对应源码材料。
