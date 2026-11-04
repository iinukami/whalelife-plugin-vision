# 内置 FFmpeg 的来源与发行要求

本插件 Windows x64 包携带 Gyan 的 FFmpeg 9.0.2 essentials 静态构建中的 ffmpeg 与 ffprobe，未修改二进制。不打包 ffplay。下载地址、上游校验值、逐文件摘要和对应 FFmpeg 源码提交固定在 `ffmpeg.json`，不追随 latest 链接。

- 构建提供方：https://www.gyan.dev/ffmpeg/builds/
- 该次发行：https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2
- FFmpeg 对应源码：https://github.com/FFmpeg/FFmpeg/commit/946fcce07b
- FFmpeg 分发说明：https://ffmpeg.org/legal.html

原始 GPL 许可证和完整上游 README（包含构建配置与组件清单）随两个程序放在 `runtime/ffmpeg/win32-x64/`，不以 WhaleLife 的原创代码许可替换第三方许可。程序的 `-version` / `-buildconf` 仍保留原始版本、版权和构建信息。

公开分发二进制安装包时，发布方须一并准备并按许可提供该构建及其静态依赖的完整对应源码和所需构建材料；上面的 FFmpeg 源码链接不是全部静态依赖源码的替代。本轮仅构建并安装本机，未上传二进制或创建远端 Release。源码仓库只提交固定来源清单、构建脚本与说明，运行组件缓存和发行物不入 Git。
