# 第三方材料与许可

本插件原创代码许可不替代下列组件或媒体的许可。发行包携带本文件、相关依赖的原始 LICENSE/NOTICE、FFmpeg 原始材料；按需下载的语音资源也可在本文件查阅归属与许可文本。资源固定版本、摘要和大小见 [vendor/SOURCES.md](vendor/SOURCES.md)。

## JavaScript 与视频组件

- **sharp 0.35.5**：Apache-2.0。其平台包、libvips 及关联组件各有适用许可，保留发行依赖目录中的原始 LICENSE/NOTICE，不能只以 sharp 的许可概括全部原生依赖。
- **undici 7.30.1**：MIT，Copyright (c) Matteo Collina and Undici contributors。原始文本位于随包分发的 `node_modules/undici/LICENSE`；共同 MIT 正文另列于下文。
- Node.js、TypeScript、@types/node 按各自许可使用；Node.js 由宿主提供，TypeScript/@types 等开发依赖不进入插件生产包。
- **FFmpeg / ffprobe 9.0.2**：Gyan essentials Windows x64 静态构建，GPLv3。组件目录保留原始 LICENSE、README、版权和构建信息。公开分发须满足该构建及静态依赖的完整对应源码要求，详见 [vendor/SOURCES.md](vendor/SOURCES.md)；源码链接不等于已准备所有源码分发材料。
- 图片、视频、音频和转写所含内容属于其权利人；程序或模型许可不替代媒体使用许可。

## 按需下载的本地语音组件

资源并未嵌入当前插件包，仅在用户明确准备时从固定公开来源下载。来源不是本项目，未修改其二进制或模型。

| 材料 | 实际归属及固定证据 | 许可 |
| --- | --- | --- |
| `llama-funasr-sensevoice.exe` 的 FunASR 代码 | Copyright (c) 2025 FunASR；[modelscope/FunASR c69e69a0b78fb9becc8b2be91db8ae57d2a41f3c LICENSE](https://github.com/modelscope/FunASR/blob/c69e69a0b78fb9becc8b2be91db8ae57d2a41f3c/LICENSE) | MIT |
| 对应构建的 llama.cpp/ggml 代码 | Copyright (c) 2023-2026 The ggml authors；[llama.cpp 803b7fcae893e9caaee3921779628fef83ac0965 LICENSE](https://github.com/ggml-org/llama.cpp/blob/803b7fcae893e9caaee3921779628fef83ac0965/LICENSE) | MIT |
| miniaudio v0.11.25 | Copyright 2026 David Reid；[实际 FunASR 修订的 miniaudio.h](https://github.com/modelscope/FunASR/blob/c69e69a0b78fb9becc8b2be91db8ae57d2a41f3c/runtime/llama.cpp/funasr-common/miniaudio.h) 尾部许可 | 上游提供公有领域/Unlicense 或 MIT No Attribution；此处保留 MIT-0 文本 |
| SenseVoiceSmall q8 GGUF | FunAudioLLM；[90c1c61912018b70ada0fcc024ea24aca62f2e63 固定模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/blob/90c1c61912018b70ada0fcc024ea24aca62f2e63/README.md) | 模型卡声明 Apache-2.0 |
| FSMN-VAD GGUF | FunAudioLLM；[6840bae4c5c92ee8c04faaf4db23dd0105098d7f 固定模型卡](https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/blob/6840bae4c5c92ee8c04faaf4db23dd0105098d7f/README.md) | 模型卡声明 Apache-2.0 |

下载的 QwenAudio/SenseVoice 镜像归档来自 `runtime-llamacpp-v0.2.1`；其发行说明指向 modelscope/FunASR 上述实际构建修订。不得将镜像仓库同名标签的旧代码误认为可执行文件完整来源。原生构建的其他附带材料仍按各自上游声明保留；本文件不声称完成了所有编译器运行库/系统组件的重新许可。重新分发权重或修改第三方资源时，应保留其适用版权/NOTICE 并记录修改。

## 设计研究

视觉设计研究参考 [SAOS-3624/dsh-see-now，93342e6122b278139281d71346314048170a034b](https://github.com/SAOS-3624/dsh-see-now/tree/93342e6122b278139281d71346314048170a034b) 的变化采样、时间标记和拼图思路；采样与处理代码独立编写，未复制其源码、媒体或测试素材。

音乐方案研究参考 [CixiSVesper/dsh-soundtry，728ac81ce8a7a1ac3f64fa820ebb4657b2a7fd36](https://github.com/CixiSVesper/dsh-soundtry/tree/728ac81ce8a7a1ac3f64fa820ebb4657b2a7fd36) 的按需分析与结果组织。本地音乐实现为本项目独立编写的 TypeScript 算法，没有复制该项目代码、引入其运行时或下载其模型；上游项目代码 MIT 也不代表其全部可选模型共用该许可。上游性能数据不作为本机性能承诺。

## MIT License

下列共同正文适用于上面标明 MIT 的材料；每个材料保留各自版权行：

```text
Copyright (c) 2025 FunASR
Copyright (c) 2023-2026 The ggml authors
Copyright (c) Matteo Collina and Undici contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MIT No Attribution（miniaudio）

```text
Copyright 2026 David Reid

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Apache License 2.0

以下为 Apache-2.0 共同许可正文，适用于标明该许可的材料；具体权利人与 NOTICE 以各固定上游材料为准。

```text

Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and
distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the copyright
owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other entities
that control, are controlled by, or are under common control with that entity.
For the purposes of this definition, "control" means (i) the power, direct or
indirect, to cause the direction or management of such entity, whether by
contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the
outstanding shares, or (iii) beneficial ownership of such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising
permissions granted by this License.

"Source" form shall mean the preferred form for making modifications, including
but not limited to software source code, documentation source, and configuration
files.

"Object" form shall mean any form resulting from mechanical transformation or
translation of a Source form, including but not limited to compiled object code,
generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form, made
available under the License, as indicated by a copyright notice that is included
in or attached to the work (an example is provided in the Appendix below).

"Derivative Works" shall mean any work, whether in Source or Object form, that
is based on (or derived from) the Work and for which the editorial revisions,
annotations, elaborations, or other modifications represent, as a whole, an
original work of authorship. For the purposes of this License, Derivative Works
shall not include works that remain separable from, or merely link (or bind by
name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original version
of the Work and any modifications or additions to that Work or Derivative Works
thereof, that is intentionally submitted to Licensor for inclusion in the Work
by the copyright owner or by an individual or Legal Entity authorized to submit
on behalf of the copyright owner. For the purposes of this definition,
"submitted" means any form of electronic, verbal, or written communication sent
to the Licensor or its representatives, including but not limited to
communication on electronic mailing lists, source code control systems, and
issue tracking systems that are managed by, or on behalf of, the Licensor for
the purpose of discussing and improving the Work, but excluding communication
that is conspicuously marked or otherwise designated in writing by the copyright
owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf
of whom a Contribution has been received by Licensor and subsequently
incorporated within the Work.

2. Grant of Copyright License.

Subject to the terms and conditions of this License, each Contributor hereby
grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
irrevocable copyright license to reproduce, prepare Derivative Works of,
publicly display, publicly perform, sublicense, and distribute the Work and such
Derivative Works in Source or Object form.

3. Grant of Patent License.

Subject to the terms and conditions of this License, each Contributor hereby
grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
irrevocable (except as stated in this section) patent license to make, have
made, use, offer to sell, sell, import, and otherwise transfer the Work, where
such license applies only to those patent claims licensable by such Contributor
that are necessarily infringed by their Contribution(s) alone or by combination
of their Contribution(s) with the Work to which such Contribution(s) was
submitted. If You institute patent litigation against any entity (including a
cross-claim or counterclaim in a lawsuit) alleging that the Work or a
Contribution incorporated within the Work constitutes direct or contributory
patent infringement, then any patent licenses granted to You under this License
for that Work shall terminate as of the date such litigation is filed.

4. Redistribution.

You may reproduce and distribute copies of the Work or Derivative Works thereof
in any medium, with or without modifications, and in Source or Object form,
provided that You meet the following conditions:

You must give any other recipients of the Work or Derivative Works a copy of
this License; and
You must cause any modified files to carry prominent notices stating that You
changed the files; and
You must retain, in the Source form of any Derivative Works that You distribute,
all copyright, patent, trademark, and attribution notices from the Source form
of the Work, excluding those notices that do not pertain to any part of the
Derivative Works; and
If the Work includes a "NOTICE" text file as part of its distribution, then any
Derivative Works that You distribute must include a readable copy of the
attribution notices contained within such NOTICE file, excluding those notices
that do not pertain to any part of the Derivative Works, in at least one of the
following places: within a NOTICE text file distributed as part of the
Derivative Works; within the Source form or documentation, if provided along
with the Derivative Works; or, within a display generated by the Derivative
Works, if and wherever such third-party notices normally appear. The contents of
the NOTICE file are for informational purposes only and do not modify the
License. You may add Your own attribution notices within Derivative Works that
You distribute, alongside or as an addendum to the NOTICE text from the Work,
provided that such additional attribution notices cannot be construed as
modifying the License.
You may add Your own copyright statement to Your modifications and may provide
additional or different license terms and conditions for use, reproduction, or
distribution of Your modifications, or for any such Derivative Works as a whole,
provided Your use, reproduction, and distribution of the Work otherwise complies
with the conditions stated in this License.

5. Submission of Contributions.

Unless You explicitly state otherwise, any Contribution intentionally submitted
for inclusion in the Work by You to the Licensor shall be under the terms and
conditions of this License, without any additional terms or conditions.
Notwithstanding the above, nothing herein shall supersede or modify the terms of
any separate license agreement you may have executed with Licensor regarding
such Contributions.

6. Trademarks.

This License does not grant permission to use the trade names, trademarks,
service marks, or product names of the Licensor, except as required for
reasonable and customary use in describing the origin of the Work and
reproducing the content of the NOTICE file.

7. Disclaimer of Warranty.

Unless required by applicable law or agreed to in writing, Licensor provides the
Work (and each Contributor provides its Contributions) on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied,
including, without limitation, any warranties or conditions of TITLE,
NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are
solely responsible for determining the appropriateness of using or
redistributing the Work and assume any risks associated with Your exercise of
permissions under this License.

8. Limitation of Liability.

In no event and under no legal theory, whether in tort (including negligence),
contract, or otherwise, unless required by applicable law (such as deliberate
and grossly negligent acts) or agreed to in writing, shall any Contributor be
liable to You for damages, including any direct, indirect, special, incidental,
or consequential damages of any character arising as a result of this License or
out of the use or inability to use the Work (including but not limited to
damages for loss of goodwill, work stoppage, computer failure or malfunction, or
any and all other commercial damages or losses), even if such Contributor has
been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability.

While redistributing the Work or Derivative Works thereof, You may choose to
offer, and charge a fee for, acceptance of support, warranty, indemnity, or
other liability obligations and/or rights consistent with this License. However,
in accepting such obligations, You may act only on Your own behalf and on Your
sole responsibility, not on behalf of any other Contributor, and only if You
agree to indemnify, defend, and hold each Contributor harmless for any liability
incurred by, or claims asserted against, such Contributor by reason of your
accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work

To apply the Apache License to your work, attach the following boilerplate
notice, with the fields enclosed by brackets "[]" replaced with your own
identifying information. (Don't include the brackets!) The text should be
enclosed in the appropriate comment syntax for the file format. We also
recommend that a file or class name and description of purpose be included on
the same "printed page" as the copyright notice for easier identification within
third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
