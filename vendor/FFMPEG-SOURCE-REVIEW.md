# FFmpeg 对应源码材料审查

核对日期：2026-11-12。适用对象为 `ffmpeg.json` 锁定的 Gyan 9.0.2 essentials Windows x64 静态构建。**当前状态：完整材料尚未取得，含此二进制的安装包不通过发布检查。** 不影响仅公开不含二进制的 Git 源码，也不改变现有本地解码功能。

## 已确认的材料与未确认项

- 两个 EXE、原始 GPLv3 LICENSE、README 的大小和摘要已有固定清单。
- FFmpeg 本体对应提交为 `946fcce07b6dcd0331c8cc609192aeff5e1924f8`。上游本体源码不包含此静态构建全部第三方依赖，也不能证明构建者没有额外补丁。
- 从固定程序只读取得编译器 `gcc 16.2.0 (Rev3, Built by MSYS2 project)` 和 58 个配置参数，已记录在 `ffmpeg-source-review.json`。参数包括 `--enable-gpl --enable-version3 --enable-static`。这不是完整依赖构建脚本。
- README 有 42 个普通外部项目、13 个硬件加速项目及 37 条版本记录。`bzlib`、`gmp`、`gnutls`、`iconv`、`libfontconfig`、`libxml2`、`lzma`、`zlib` 没有精确版本记录。
- `mediafoundation` 与部分硬件项目涉及系统接口、头文件或驱动能力，不能一律当作独立静态库；是否纳入对应源码须逐项依据实际构建审查。`libmfx` 没有独立版本条目，不用 VPL 的版本代填。
- README 不是完整依赖闭包。仍需核验实际直接／间接依赖、源码修订、修改或无修改依据、补丁、构建配方、工具链及所需包记录、版权与许可材料。

已取得 FFmpeg 官方 `ffmpeg-9.0.2.tar.xz`（12040788 字节），SHA-256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`。在隔离公钥目录验证其 PGP 签名通过，完整指纹与 FFmpeg 官网公布值一致，归档 `RELEASE` 为 9.0.2；没有导入用户个人密钥环。此证据只覆盖签名的上游本体源码，不声称已验证它与 Gyan 二进制及全部依赖的一致性。

## 上游公开证据

- [固定 9.0.2 发行](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2) 指向上述 FFmpeg 提交。六个上传附件是二进制包；GitHub 自动生成的 Source code 是镜像支持仓快照，不是 FFmpeg 与静态依赖源码集合。
- [官方问题 #249](https://github.com/GyanD/codexffmpeg/issues/249) 的评论包含与本插件完全相同的两个 EXE 摘要，维护者要求从正式邮箱联系。
- [官方问题 #255](https://github.com/GyanD/codexffmpeg/issues/255) 同样请求这个 essentials 构建的完整材料；维护者转为邮件沟通，公开页面没有完整材料链接。
- [官方问题 #211](https://github.com/GyanD/codexffmpeg/issues/211) 说明构建环境经过本地定制。通用 `media-autobuild_suite` 或其最新版本不能冒充本构建的精确配方。

这些事实只说明当前核查的公开渠道未提供完整集合，不断言维护者没有材料。没有向维护者发送请求，也没有访问其他人的邮件。

## 接收材料与解除阻断

1. 向构建方取得与两个固定 EXE 对应的完整源码／依赖／补丁及构建材料。不能只收一份 FFmpeg 本体源码，不能从 README 版本字符串推断未使用补丁。
2. 在本插件忽略目录 `.artifacts/ffmpeg-sources/` 保存准备公开的源码附件与**不含私信、账号或凭据的技术审查报告**。保留原始版权与许可；不执行未经审查的第三方构建脚本。
3. 逐项更新 `ffmpeg-source-review.json` 的 `components[].resolution`。`included` 要求精确 `revision`、附件内 `sourcePath`、`recipePath`、`licensePath`，以及 `patches: included` 与 `patchPath` 或有证据的 `none-confirmed`；有依据排除的项目使用 `excluded`，提供 `reason` 和 `evidencePath`。新增遗漏的传递依赖，不能删除 README 已列项目规避检查。
4. 技术审查确认全部依赖覆盖与二进制对应关系后，填写 `closureReview` 的审查人、日期、报告文件、字节数、SHA-256，并清空已解决项。只有真实完成后才设 `status: complete`、`dependencyClosure: true`、`binaryCorrespondence: true`。
5. `delivery.bundle` 登记完整源码附件的相对文件名、字节数和 SHA-256；`delivery.sourceUrl` 登记稳定、无凭据的 HTTPS 下载链接，核实公开可获取后设置 `availabilityReviewed: true`。允许源码附件独立下载，不必塞入安装包。未公开验证的地址不能标为已验证。
6. 执行 `npm run build:release`；上传安装包前再执行 `npm run release:check`。发布检查本身没有上传能力；由用户授权的发布流程处理外发。

上述路径是源码附件内部的审查定位信息；检查器不解包或执行第三方源码，人工报告负责验证内容与编译对应关系。一般构建工具和符合许可证定义的系统库例外须有具体依据，不要求机械打包整套操作系统。参照本构建随附的 GPLv3 第 1 节及第 6(d) 节；不把 FFmpeg 网站用于 LGPL 动态链接的清单直接套用为此 GPL 静态构建的完整结论。

## 命令行为

| 命令 | 行为 |
| --- | --- |
| `npm run build` | 保留开发和隔离测试构建，产物 `RELEASE-STATUS.json` 标记 `binaryReleaseApproved: false`。 |
| `npm run build:release` | 在下载或改写 dist **之前**核验材料；不齐则退出非零、保留旧产物。通过后构建并再次核验清单、二进制及审查摘要。 |
| `npm run release:check` | 只读、离线核对材料、目标摘要、审查状态和实际发行文件；不下载、不开模型、不改配置、不上传。 |

独立检查可用 `npm run release:check -- --materials <目录>` 指定材料位置；发布构建使用上面的默认目录。源码附件、报告不得通过路径穿越或符号链接引用其他文件。脚本检查的是文件完整性、登记和人工审查是否完成，不能自动证明源码内容、许可证结论或远端长期可获取性；上传前仍须复核公开链接。普通构建产物不得直接充当已验收的发布包。
