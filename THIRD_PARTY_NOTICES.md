# 第三方材料

- sharp 0.35.5：Apache-2.0；其平台包与 libvips 及关联组件各自的许可随依赖分发，见 node_modules 中对应 LICENSE/NOTICE 文件。
- Node.js、TypeScript 和 @types/node 按各自许可使用，开发依赖不进入插件发行包。
- FFmpeg / ffprobe 9.0.2：Windows x64 包携带 Gyan essentials 静态构建，GPLv3。原始 LICENSE、README、构建信息与版权随组件保留；下载来源、固定摘要与对应源码说明见 `vendor/ffmpeg.json`、`vendor/SOURCES.md`。二进制和开发缓存不提交 Git，公开分发还须满足该构建及其静态依赖的对应源码要求。
- 媒体内容属于来源方；程序许可不替代图片或视频的使用许可。

设计研究参考了 SAOS-3624/dsh-see-now 的变化采样、时间标记与拼图思路（研究快照 93342e6122b278139281d71346314048170a034b）。本项目采样与处理代码独立编写，未复制该项目源码、图片或测试素材。
