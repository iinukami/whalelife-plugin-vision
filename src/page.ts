/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export const settingsPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>视听理解</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;--ink:#203438;--muted:#617477;--line:#dce6e5;--paper:#fff;--soft:#f4f8f7;--accent:#126e68;--wash:#eaf5f0;--warn:#85551a;--warn-bg:#fbf3e5;background:var(--paper);color:var(--ink)}
*{box-sizing:border-box}[hidden]{display:none!important}body{max-width:880px;margin:0 auto;padding:32px 28px 24px;line-height:1.65}h1{font-size:27px;letter-spacing:-.5px;margin:0 0 4px}h2{font-size:16px;margin:0}p{margin:8px 0}.muted,.hint{color:var(--muted)}.hint{font-size:13px}.intro{margin:0 0 24px}.hero{background:var(--wash);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin-bottom:20px}.hero[data-tone="warn"]{background:var(--warn-bg)}.hero h2{font-size:19px}.hero p{font-size:14px;margin-bottom:0}.eyebrow{font-size:12px;letter-spacing:.08em;color:var(--accent);margin-bottom:5px}.capabilities{margin:18px 0 0;padding-top:5px;border-top:1px solid var(--line)}.capability{display:grid;grid-template-columns:104px 1fr;gap:14px;padding-top:13px}.capability dt{font-size:14px;font-weight:600}.capability dd{margin:0;font-size:14px}.capability small{display:block;color:var(--muted);font-size:12px}.pill{display:inline-block;font-size:12px;font-weight:500;padding:2px 9px;border-radius:20px;background:var(--soft);color:var(--muted)}.pill[data-tone="ready"]{background:var(--wash);color:var(--accent)}.pill[data-tone="warn"]{background:var(--warn-bg);color:var(--warn)}
.panel{border:1px solid var(--line);border-radius:12px;margin:12px 0;overflow:hidden}summary{cursor:pointer;padding:17px 20px;font-weight:600;list-style:none;display:flex;align-items:center;gap:10px}summary::-webkit-details-marker{display:none}summary:before{content:'›';font-size:20px;line-height:1;color:var(--muted);transition:transform .15s}details[open]>summary:before{transform:rotate(90deg)}summary .pill{margin-left:auto;flex-shrink:0}summary:hover{background:var(--soft)}.panel-body{padding:0 20px 20px;border-top:1px solid var(--line)}.section{padding-top:18px}.section+.section{margin-top:18px;border-top:1px solid var(--line)}.row{display:grid;grid-template-columns:172px minmax(0,1fr);gap:16px;margin:12px 0;align-items:center}.field-help{margin:0 0 12px 188px;color:var(--muted);font-size:13px}.warning{color:var(--warn);font-size:13px}.optional{font-size:12px;font-weight:400;color:var(--muted);margin-left:7px}input,select{width:100%;font:inherit;font-size:14px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;min-width:0;background:var(--paper);color:var(--ink)}select{cursor:pointer}button,.link-button{font:inherit;font-size:14px;border:1px solid var(--line);border-radius:8px;padding:9px 16px;cursor:pointer;background:var(--paper);color:var(--accent);text-decoration:none;display:inline-block}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}a{color:var(--accent)}:focus-visible{outline:3px solid #69aaa3;outline-offset:3px}.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.save-area{margin-top:22px;padding:18px 0 4px;border-top:1px solid var(--line)}.save-area p{font-size:13px;white-space:pre-wrap}.save-area [role="alert"]{color:var(--warn)}progress{width:100%;height:9px;accent-color:var(--accent)}.technical{padding:12px 14px;background:var(--soft);border-radius:8px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}.footnote{font-size:12px;color:var(--muted);margin:18px 0 0}.resource-title{display:flex;gap:10px;align-items:center;margin-top:16px}.resource-title strong{font-size:14px}
@media(prefers-color-scheme:dark){:root{--ink:#e3eeec;--muted:#9db1ae;--line:#344846;--paper:#182321;--soft:#22322e;--accent:#8cd5c4;--wash:#203b32;--warn:#edc68f;--warn-bg:#3b3123}button.primary{color:#142b25}}
@media(max-width:560px){body{padding:22px 16px}.hero{padding:18px}.row{grid-template-columns:1fr;gap:6px}.field-help{margin-left:0}summary{padding:15px}.panel-body{padding:0 15px 16px}.capability{grid-template-columns:86px 1fr;gap:8px}.save-area .actions{align-items:stretch}.link-button{text-align:center}}
.capability-groups{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:18px}.capability-group{min-width:0}.capability-group h3{font-size:13px;color:var(--muted);margin:0}.capability-groups .capabilities{margin:7px 0 0}.capability dd{overflow-wrap:anywhere}.current-settings{margin-top:16px}.panel-note{margin-top:16px}summary .pill{max-width:60%;white-space:normal;text-align:right}@media(max-width:680px){.capability-groups{grid-template-columns:1fr;gap:20px}}
</style>
<header><h1>视听理解</h1><p class="intro muted">一起看，一起听。继续由当前主模型理解并与你交流。</p></header>
<section class="hero" id="hero" aria-labelledby="state"><div class="eyebrow">当前能力</div><h2 id="state">正在检查…</h2><p id="detail">正在读取实际运行状态。</p>
<div class="capability-groups"><section class="capability-group" aria-labelledby="visualHeading"><h3 id="visualHeading">画面</h3><dl class="capabilities">
<div class="capability"><dt>图片查看</dt><dd><span id="imageState">检查中</span><small id="imageHint">由当前主模型看图，模型本身须支持图片。</small></dd></div>
<div class="capability"><dt>视频画面</dt><dd><span id="videoState">检查中</span><small>按时间采样，快速变化可能遗漏。</small></dd></div>
<div class="capability"><dt>按需看屏</dt><dd><span id="screenState">检查中</span><small id="screenHint">默认关闭；没有调用时不采集。</small></dd></div>
</dl></section><section class="capability-group" aria-labelledby="audioHeading"><h3 id="audioHeading">声音</h3><dl class="capabilities">
<div class="capability"><dt>语音识别</dt><dd><span id="speechState">检查中</span><small id="speechHint">识别说话和歌词，整理成文字。</small></dd></div>
<div class="capability"><dt>音乐分析</dt><dd><span id="musicState">检查中</span><small>节奏、音高和和弦仅作参考，不保证准确扒谱。</small></dd></div>
<div class="capability"><dt>环境声理解</dt><dd><span id="soundState">检查中</span><small>可选云端能力，用于描述环境中的声音。</small></dd></div>
</dl></section></div></section>
<form id="settings">
<details class="panel" id="visualSettings" open><summary>画面理解与处理<span class="pill" id="visualModeBadge">主模型直接看</span></summary><div class="panel-body">
<div class="section"><h2>画面理解方式</h2><p class="hint">图片、视频与看屏共用这一选择。</p>
<label class="row">理解方式<select name="visualUnderstandingBackend"><option value="main">主模型直接看</option><option value="ollama">本地 Ollama 描述</option></select></label><p class="field-help" id="visualUnderstandingHelp"></p>
<div id="localVisionOptions" hidden><label class="row">本地看图模型连接<select name="localVisionModelId"><option value="">尚未选择</option></select></label>
<p class="field-help">在宿主模型服务中添加 chat 或 custom 类型、OpenAI 兼容协议的本机 Ollama 连接，地址为 http://127.0.0.1:11434/v1，再在此选择配置。列表中的名称不代表模型已支持看图。</p>
<p class="hint">需先自行安装 Ollama，并拉取支持视觉的本地模型。本插件不自动下载模型或启动 Ollama，不支持 Ollama 云模型或代理。保存设置不会测试连接。</p>
<p class="warning" id="localVisionWarning" hidden>还没有选择本地看图模型，本地画面描述暂时无法使用。</p></div>
<p class="technical current-settings" id="localVisionCurrent">正在读取当前画面理解方式。</p></div>
<div class="section"><h2>画面准备</h2><p class="hint">调整用于理解的画面。具体查看任务指定的画质和布局优先于这里的默认设置。</p>
<label class="row">默认画质<select name="visualDetail"><option value="auto">自动 · 按查看任务选择</option><option value="overview">概览 · 减少画面大小</option><option value="detail">细节 · 保留更多细节</option></select></label><p class="field-help" id="visualDetailHelp"></p>
<label class="row">多帧布局<select name="visualLayout"><option value="frames">独立画面</option><option value="sheet">拼图概览</option></select></label><p class="field-help" id="visualLayoutHelp"></p>
<label class="row">观察重点<select name="visualFocus"><option value="whole">全景优先</option><option value="auto">全景 + 自动变化细节</option></select></label><p class="field-help" id="visualFocusHelp"></p>
<p class="technical current-settings" id="visualCurrent">正在读取当前画面处理设置。</p><p class="hint" id="visualChange"></p>
</div></div></details>
<details class="panel" id="screenSettings"><summary>按需看屏<span class="pill" id="screenBadge">默认关闭</span></summary><div class="panel-body">
<p class="hint panel-note">开启并使设置生效后，AI 可以按需看当前画面，或观察接下来的一段时间。未调用时不采集，不在后台常驻监听。截图按上面的画面理解方式处理：主模型直接看，或由本地 Ollama 描述后仅把文字交给主模型。</p>
<p class="hint">若主模型在云端，直接看图模式会发送截图，本地描述模式只发送描述文字。本插件不落盘保存看屏截图；普通最终回答及显式开启的宿主诊断输出仍按宿主规则保留，直接看图时诊断可能包含截图等模型输入。</p>
<p class="hint">看屏使用画质与高级采样设置；多帧布局和自动变化细节只用于已有图片、动画或视频。</p>
<label class="row">允许按需看屏<select name="screenEnabled"><option value="false">关闭</option><option value="true">开启</option></select></label>
<div id="screenOptions" hidden><label class="row">默认采集目标<select name="screenTarget"><option value="window">采集开始时的前台窗口</option><option value="screen">主屏幕</option></select></label><p class="field-help" id="screenTargetHelp"></p>
<label class="row">默认观察时长（秒）<input name="screenSeconds" type="number" min="2" max="60" step="1" required></label><p class="field-help">用于观察后续变化，默认 10 秒，最长 60 秒；查看当前画面不需要等待这一时长。</p></div>
<p class="warning" id="screenWarning" hidden></p><p class="hint" id="screenCurrent">正在读取实际看屏状态。</p>
</div></details>
<details class="panel" id="processing"><summary>声音处理与云端能力<span class="pill">按需调整</span></summary><div class="panel-body">
<div class="section"><h2>语音与歌词</h2><label class="row">语音与歌词转写<select name="speechBackend"><option value="local">轻量本地识别</option><option value="cloud">云端语音识别</option></select></label>
<p class="field-help" id="speechModeHelp"></p><div id="speechCloud" hidden><label class="row">云端转写模型<select name="speechModelId"><option value="">尚未选择</option></select></label><p class="field-help">选择主干模型设置中的 STT（语音转文字）连接，使用 OpenAI 兼容转写接口。</p><p class="warning" id="speechWarning" hidden>还没有选择转写模型，云端语音识别暂时无法使用。</p></div></div>
<div class="section"><h2>音乐</h2><label class="row">音乐专项分析<select name="musicBackend"><option value="local">本地特征估计</option><option value="cloud">云端音频理解</option></select></label><p class="field-help" id="musicModeHelp"></p></div>
<div class="section"><h2>环境声与云端音乐<span class="optional" id="soundOptional">可选</span></h2><p class="hint">需要分析环境声，或将音乐分析切到云端时，再选择下面的模型。它与语音转写模型用途不同。</p>
<label class="row">环境声／音乐理解模型<select name="understandingModelId"><option value="">尚未选择</option></select></label><p class="field-help">需要支持 Qwen-Omni 兼容音频输入的模型。出现在列表中不代表已经支持音频，保存设置也不会测试连接。</p><p class="warning" id="musicWarning" hidden>云端音乐分析需要选择上面的音频理解模型。</p></div>
<p class="hint">云端处理会上传所选音频片段，并产生对应服务的用量。失败不会自动换模型或切换本地／云端。</p>
</div></details>
<details class="panel" id="resources"><summary>本地语音资源<span class="pill" id="resourceBadge">检查中</span></summary><div class="panel-body">
<div class="resource-title"><strong id="localState">正在检查…</strong></div><p class="hint" id="localHelp"></p><p class="warning" id="localError" hidden></p>
<div id="downloadArea" hidden><progress id="download" max="1" value="0" aria-label="本地语音资源下载进度"></progress><p id="downloadText" class="hint"></p></div>
<div class="actions"><button type="button" id="prepare" disabled>一键准备本地能力</button><span id="prepareNotice" class="hint" role="status"></span></div>
<details id="downloadSettings" class="section"><summary>下载设置与组件详情</summary><label class="row">资源下载代理<input name="resourceProxyUrl" type="url" maxlength="500" placeholder="留空直连，例如 http://127.0.0.1:7890"></label><p class="field-help">只影响本地语音资源下载，不改变模型连接。支持不含用户名密码的 HTTP/HTTPS 地址；修改后先保存并使设置生效。</p><p id="localDetail" class="technical"></p></details>
</div></details>
<details class="panel" id="advanced"><summary>高级设置<span class="pill">通常无需修改</span></summary><div class="panel-body"><div class="section"><h2>画面采样</h2>
<label class="row">最多选取画面数<input name="visualMaxFrames" type="number" min="2" max="8" step="1" required></label><p class="field-help">每段最多选取 2–8 帧，再按所选布局提供；实际画面更少时不会补足。</p>
<label class="row">采样密度<select name="visualSampleFps"><option value="1">每秒 1 次</option><option value="2">每秒 2 次（默认）</option><option value="4">每秒 4 次</option><option value="6">每秒 6 次</option></select></label><p class="field-help">提高密度可发现更短的变化，也会增加本机处理量；不等于把所有采样画面发给模型，仍可能遗漏快速动作。</p>
</div><div class="section" id="localVisionAdvanced" hidden><h2>本地画面描述</h2><label class="row">描述长度上限（tokens）<input name="localVisionMaxTokens" type="number" min="128" max="1024" step="1" required></label><p class="field-help">默认 512，可设 128–1024。限制本地模型生成的描述长度；较短可能遗漏细节，较长会增加处理量与主模型收到的文字。</p>
</div><div class="section"><h2>临时媒体</h2><p class="hint">控制来源图片与音视频临时文件的保留时间和占用，不影响聊天记忆。媒体按会话隔离，过期或停用后清理。看屏截图不进入此缓存，本插件不落盘保存截图。</p>
<label class="row">引用有效期（秒）<input name="ttlSeconds" type="number" min="30" max="7200" required></label><p class="field-help">1800 秒为 30 分钟。过期后继续查看，需要重新取得媒体。</p>
<label class="row">单文件上限（MiB）<input name="maxMediaMiB" type="number" min="1" max="64" required></label><label class="row">总容量上限（MiB）<input name="maxTotalMiB" type="number" min="1" max="512" required></label><p class="field-help">总容量统计所有会话的临时媒体，不能小于单文件上限。</p></div><div class="technical"><p id="decoder"></p><p id="usage"></p></div></div></details>
<div class="save-area"><div class="actions"><button id="save" class="primary" type="submit" disabled>保存设置</button><button id="apply" type="button" hidden disabled>应用已保存设置</button><span id="saveState" class="pill">正在读取</span><a id="manage" class="link-button" href="/#plugins" target="_top" hidden>打开插件管理</a></div><p id="applyImpact" class="hint">使设置生效会取消本插件正在处理的任务和资源下载，并清理旧媒体引用；需要时请重新取得媒体。</p><p id="notice" class="muted" role="status">正在读取设置应用方式。</p><p id="saveError" role="alert" hidden></p><p id="applyError" role="alert" hidden></p></div>
</form>
<p class="footnote">已有音视频默认每次看听 30 秒，单次最多 60 秒，可继续分段处理。主模型收到直接图片或本地生成的画面描述，并接收所选声音任务的文字资料；本地处理后的文字仍会交给主模型。</p>
<details class="panel"><summary>理解范围与使用说明</summary><div class="panel-body"><p class="hint">网页与平台媒体仍由来源插件取得；这页显示处理能力，不代表这些来源已完成接入。按需看屏只采集当前可见画面，窗口内容会受遮挡，不能取得被遮挡或最小化窗口的隐藏内容。歌词识别可能受伴奏影响，本地音乐分析不等于完整乐谱或确定的段落标签。</p><p class="hint">主模型直接看图需要宿主多模态接口，所选主模型须支持图片；旧宿主显示主模型查看暂不可用。本地 Ollama 描述需要宿主临时文字工具接口，主模型只收到文字，不要求主模型支持图片。页面不会调用模型测试连接，失败不会自动切换理解方式。主模型没有直接收到原音频。临时媒体不作为长期收藏，普通聊天最终回答仍按宿主规则保存。</p></div></details>
<script type="module">
const $=selector=>document.querySelector(selector),form=$('#settings'),save=$('#save'),apply=$('#apply'),prepare=$('#prepare');
const text=(selector,value)=>{$(selector).textContent=value;},show=(selector,value)=>{$(selector).hidden=!value;},field=name=>form.elements.namedItem(name);
const mib=n=>((Number(n)||0)/1048576).toFixed(1)+' MiB';
let revision,latest,savedSnapshot='',savedProxy='',savedLocalVisionMaxTokens=512,initialized=false,loading=false,saving=false,requestApplies=false,preparing=false,online=false,resourceAttention=false,prepareMessage='',confirmation,applyFailureRevision,mutationGeneration=0;
function validLocalVisionBudget(value){const budget=Number(value);return Number.isInteger(budget)&&budget>=128&&budget<=1024;}
function readConfig(){const values=Object.fromEntries(new FormData(form));return {ttlSeconds:Number(values.ttlSeconds),maxMediaMiB:Number(values.maxMediaMiB),maxTotalMiB:Number(values.maxTotalMiB),visual:{detail:values.visualDetail,layout:values.visualLayout,focus:values.visualFocus,maxFrames:Number(values.visualMaxFrames),sampleFps:Number(values.visualSampleFps)},visualUnderstanding:{backend:values.visualUnderstandingBackend,modelId:values.localVisionModelId,maxTokens:Number(values.localVisionMaxTokens)},screen:{enabled:values.screenEnabled==='true',target:values.screenTarget,seconds:Number(values.screenSeconds)},audio:{speechBackend:values.speechBackend,speechModelId:values.speechModelId,understandingModelId:values.understandingModelId,musicBackend:values.musicBackend,resourceProxyUrl:values.resourceProxyUrl}};}
function dirty(){return initialized&&JSON.stringify(readConfig())!==savedSnapshot;}
function applied(data){return !data.pendingReload&&!data.applying&&(data.applySupported!==true||(typeof data.revision==='string'&&data.appliedRevision===data.revision));}
function screenStateOf(s){const screen=s.screen,understanding=runtimeVisual(s);return !screen?'看屏状态暂不可用':!screen.supported?'当前平台不支持':!screen.enabled?'未开启':screen.busy?'正在采集':!s.mediaPreparation?'媒体处理暂不可用':!understanding.capable?'已开启 · 等待宿主接口':!understanding.configured?'已开启 · 待选择本地模型':'已开启 · 按需采集';}
function runtimeVisual(s){const local=s.localVision?.backend==='ollama';return {local,capable:local?!!s.localDescriptionTools:!!s.mainModelViewing,configured:!local||!!s.localVision?.configured,busy:local&&!!s.localVision?.busy};}
function loadForm(data){
 const choices=data.models||[];
 const understanding={backend:'main',modelId:'',maxTokens:512,...data.localVisionDefaults,...(data.config.visualUnderstanding||{})};
 for(const name of ['speechModelId','understandingModelId','localVisionModelId']){const select=field(name),selected=name==='localVisionModelId'?understanding.modelId:(data.config.audio||{})[name]||'';select.replaceChildren(new Option('尚未选择',''));for(const model of choices.filter(m=>name==='speechModelId'?m.type==='stt':m.type==='chat'||m.type==='custom'))select.add(new Option(model.name,model.id));if(selected&&!Array.from(select.options).some(o=>o.value===selected))select.add(new Option('原配置不可用 · '+selected,selected));}
 savedLocalVisionMaxTokens=validLocalVisionBudget(understanding.maxTokens)?Number(understanding.maxTokens):512;
 field('visualUnderstandingBackend').value=understanding.backend;field('localVisionModelId').value=understanding.modelId;field('localVisionMaxTokens').value=savedLocalVisionMaxTokens;
 const values={...data.config,...data.audioDefaults,...(data.config.audio||{})};for(const [name,value]of Object.entries(values)){const input=field(name);if(input)input.value=value;}
 const visual={...data.visualDefaults,...(data.config.visual||{})},screen={...data.screenDefaults,...(data.config.screen||{})};
 for(const [name,value]of Object.entries(visual)){const input=field('visual'+name[0].toUpperCase()+name.slice(1));if(input)input.value=value;}
 for(const [name,value]of Object.entries(screen)){const input=field('screen'+name[0].toUpperCase()+name.slice(1));if(input)input.value=String(value);}
 revision=data.revision;savedSnapshot=JSON.stringify(readConfig());savedProxy=field('resourceProxyUrl').value;initialized=true;
}
function updateForm(){
 const visualDetail=field('visualDetail').value,visualFocus=field('visualFocus').value,screenEnabled=field('screenEnabled').value==='true',screen=latest?.status.screen;
 const localDraft=field('visualUnderstandingBackend').value==='ollama',activeVisual=runtimeVisual(latest?.status||{});
 if(!localDraft&&!validLocalVisionBudget(field('localVisionMaxTokens').value))field('localVisionMaxTokens').value=savedLocalVisionMaxTokens;
 show('#localVisionOptions',localDraft);show('#localVisionAdvanced',localDraft);show('#localVisionWarning',localDraft&&!field('localVisionModelId').value);
 text('#visualUnderstandingHelp',localDraft?'原图交给所选本机 Ollama，主模型只收到描述文字，避免本次原图的主模型图片用量；主模型仍处理文字，可能产生文本费用。小模型可能漏细节，失败不会自动切回主模型看图。':'把准备好的图片直接交给当前主模型，模型须支持图片；若使用云端模型，会产生相应图片用量。');
 text('#visualDetailHelp',visualDetail==='detail'?'更适合小字与局部细节；画面与模型用量可能增加。':visualDetail==='overview'?'更适合先了解整体内容；小字或复杂细节可再指定高清查看。':'按查看任务选择概览或细节；模型仍可在调用时明确指定画质。');
 text('#visualLayoutHelp',field('visualLayout').value==='sheet'?'将多帧排成一张拼图，便于概览；文字与细节可能缩小。':'每帧独立提供，保留各自的时间位置，便于逐帧理解。');
 text('#visualFocusHelp',visualFocus==='auto'?'保留全景，并根据画面变化补充细节区域；自动选择可能遗漏需要关注的内容。':'优先保留完整画面；需要看清局部时，可由模型明确指定裁剪区域。');
 show('#screenOptions',screenEnabled);text('#screenTargetHelp',field('screenTarget').value==='window'?'以采集开始时的前台窗口为目标，只能看到当前可见部分，内容会受遮挡。':'采集主屏幕当前可见的内容，包括其上的窗口。');
 const screenWarning=screenEnabled&&screen?.supported===false?'当前平台不支持看屏；保存开关不会使该能力可用。':screenEnabled&&!activeVisual.capable?(activeVisual.local?'当前运行的本地描述方式需要宿主临时文字工具接口。':'当前运行的主模型看图方式需要宿主多模态接口。'):screenEnabled&&!activeVisual.configured?'当前运行的本地描述方式尚未选择模型。':'';
 show('#screenWarning',!!screenWarning);text('#screenWarning',screenWarning);
 const cloudSpeech=field('speechBackend').value==='cloud',cloudMusic=field('musicBackend').value==='cloud';
 show('#speechCloud',cloudSpeech);show('#speechWarning',cloudSpeech&&!field('speechModelId').value);show('#musicWarning',cloudMusic&&!field('understandingModelId').value);
 text('#speechModeHelp',cloudSpeech?'将音频片段上传给下方转写模型。':'在这台电脑识别，无需配置云端转写模型。');
 text('#musicModeHelp',cloudMusic?'使用下方“环境声／音乐理解模型”提供描述性分析。':'不需要下载音乐模型；只提供有局限的节奏、音高和和弦候选。');
 text('#soundOptional',cloudMusic?'云端音乐需要':'可选');
 const changed=dirty(),supported=latest?.applySupported===true,pending=!!latest&&!applied(latest),applying=!!latest?.applying||(saving&&requestApplies),failed=pending&&!!latest?.applyError,stale=initialized&&latest?.revision!==revision;
 save.disabled=!initialized||!online||saving||applying||!changed;text('#save',saving?(requestApplies?'正在保存并生效…':'正在保存…'):supported?'保存并生效':'保存设置');
 text('#saveState',!initialized?'正在读取':!online?'连接中断 · 生效状态未确认':applying?'正在生效':saving?'正在保存':changed?'有未保存的修改':stale?'设置版本已变化':failed?'已保存 · 生效失败':pending?(supported?'已保存待生效':'等待重载'):'设置已生效');
 $('#saveState').dataset.tone=changed||pending||applying||!online?'warn':'ready';show('#manage',pending&&!supported);show('#apply',supported&&pending);apply.disabled=!online||saving||applying||changed||stale;text('#apply',applying?'正在生效…':'应用已保存设置');
 text('#notice',!online?'无法读取最新状态，暂时不能确认是否生效；输入仍保留，连接恢复后会重新核对。':applying?'正在使已保存设置生效；下方能力仍以实际运行状态为准。':changed?(pending?'另有修改尚未保存。请先保存当前草稿，再应用设置。':'修改尚未保存，当前处理方式保持不变。'):stale?'设置已被其他页面修改。当前输入仍保留，请刷新页面核对后再操作。':pending?(supported?'设置已保存但尚未生效，可点击“应用已保存设置”重试。':'设置已保存。链接只打开插件管理，进入后还需点击“视听理解”的重载操作。'):'不需要调整时，保持当前设置即可。');
 show('#applyError',failed&&!applying);text('#applyError',failed?'设置已保存，但生效失败：'+(latest.applyError.error||'请检查运行状态后重试。'):'');
 const draft=readConfig(),saved=initialized?JSON.parse(savedSnapshot):draft,visualChanged=JSON.stringify([draft.visual,draft.visualUnderstanding])!==JSON.stringify([saved.visual,saved.visualUnderstanding]),screenChanged=JSON.stringify(draft.screen)!==JSON.stringify(saved.screen);
 const phase=!online?'状态未确认':applying?'正在生效':failed?'生效失败':pending?(supported?'已保存待生效':'已保存待重载'):'';
 const visualName=activeVisual.local?'本地 Ollama 描述':'主模型直接看',draftVisualName=localDraft?'本地 Ollama 描述':'主模型直接看',screenState=screenStateOf(latest?.status||{}),screenChoice=screenEnabled?'开启':'关闭';
 text('#visualModeBadge',visualName+(visualChanged?' · 未保存':phase?' · '+phase:''));$('#visualModeBadge').dataset.tone=visualChanged||phase?'warn':'ready';
 text('#visualChange',(visualChanged?'未保存的画面设置：'+draftVisualName+'。':phase?'画面设置：'+phase+'，选择 '+draftVisualName+'。':'')+(!online?'下面是上次确认的运行状态。':''));
 text('#screenBadge',(!screen?'暂不可用':!screen.supported?'平台不支持':screen.busy?'采集中':screen.enabled?'已开启':'未开启')+(screenChanged?' · 未保存':phase?' · '+phase:''));$('#screenBadge').dataset.tone=screenChanged||phase||screen?.busy?'warn':screen?.enabled&&screen.supported?'ready':'';
 const screenChange=screenChanged?'未保存：'+screenChoice+'看屏。':phase?phase+'：设置为'+screenChoice+'看屏。':'';
 text('#screenState',screenState+(screenChanged?' · 待'+screenChoice+'（未保存）':phase?' · '+phase:''));text('#screenCurrent',(!online?'上次确认：':'当前运行：')+screenState+'。'+screenChange);
 const local=latest?.status.audio?.local||{},busy=['checking','downloading','extracting','installing','verifying','preparing'].includes(local.phase),proxyChanged=initialized&&field('resourceProxyUrl').value!==savedProxy;
 prepare.disabled=!online||saving||applying||preparing||busy||!!local.ready||!latest?.status.audio?.local||local.supported===false||pending||proxyChanged;
 text('#prepare',local.ready?'资源已准备':preparing||busy?'正在准备…':local.phase==='error'?'重新准备本地能力':'一键准备本地能力');
 text('#prepareNotice',local.ready?'':pending||proxyChanged?(supported?'先保存并使设置生效，再准备资源。':'先保存并重载设置，再准备资源。'):local.phase==='error'?'':prepareMessage);
}
function render(data){
 latest=data;online=true;if(!initialized)loadForm(data);
 if(applyFailureRevision===data.revision&&applied(data)){applyFailureRevision=undefined;show('#saveError',false);}
 const s=data.status,a=s.audio?.unavailable?undefined:s.audio,local=a?.local||{},decoderReady=!!s.decoder?.ready,busy=['checking','downloading','extracting','installing','verifying','preparing'].includes(local.phase);
 const localSpeech=a?.speechBackend==='local',screen=s.screen,visual=s.visual,understanding=runtimeVisual(s),imageReady=!!s.mediaPreparation&&understanding.capable&&understanding.configured;
 text('#imageState',!s.mediaPreparation?'媒体处理暂不可用':understanding.local?(!understanding.capable?'本地描述需宿主支持':!understanding.configured?'待选择本地看图模型':understanding.busy?'正在生成本地描述':'已选择本地模型 · 调用时检查'):s.mainModelViewing?'宿主图片接口已支持':'主模型查看暂不可用');
 text('#imageHint',understanding.local?'主模型只收到描述文字；此处未测试本地连接或视觉能力。':s.mainModelViewing?'当前主模型仍须支持图片；此处未测试模型连接。':'媒体准备与主模型查看分开；需要宿主多模态接口。');
 text('#videoState',!s.mediaPreparation?'媒体处理暂不可用':!decoderReady?'解码组件未就绪':!understanding.capable?'可准备画面 · 等待宿主接口':!understanding.configured?'可准备画面 · 待选择本地模型':'画面采样已就绪');
 text('#visualModeBadge',understanding.local?'本地 Ollama 描述':'主模型直接看');
 text('#localVisionCurrent',understanding.local?'当前运行：本地 Ollama 描述 · '+(!understanding.capable?'宿主临时文字工具暂不可用':!understanding.configured?'尚未选择模型':understanding.busy?'正在生成描述':'已选择模型，实际调用时检查连接与视觉能力')+'。原图不发送给主模型。':'当前运行：主模型直接看图。主模型须支持图片，此处未测试连接。');
 const screenState=screenStateOf(s);
 text('#screenState',screenState);text('#screenBadge',!screen?'暂不可用':!screen.supported?'平台不支持':screen.busy?'采集中':screen.enabled?'已开启':'未开启');$('#screenBadge').dataset.tone=screen?.busy?'warn':screen?.enabled&&screen.supported?'ready':'';
 text('#screenHint',screen?.busy?'当前调用结束后停止采集，不持续监听。':understanding.local?'没有调用时不采集；本地描述后仅交给主模型文字。':'没有调用时不采集；由当前主模型看图。');
 text('#screenCurrent','当前运行：'+screenState+'。');
 text('#visualCurrent',visual?'当前运行：'+({auto:'自动画质',overview:'概览画质',detail:'细节画质'}[visual.detail]||'未识别画质')+' · '+(visual.layout==='sheet'?'拼图概览':'独立画面')+' · '+(visual.focus==='auto'?'全景 + 自动变化细节':'全景优先')+' · 最多 '+visual.maxFrames+' 帧 · 每秒 '+visual.sampleFps+' 次采样。':'当前运行的画面设置暂不可用。');
 text('#speechState',!a?'暂不可用':!decoderReady?'解码组件未就绪':localSpeech?(local.ready?'已就绪 · 本地识别':busy?'准备中 · 本地识别':'尚未就绪 · 本地识别'):(a.speechCloudConfigured?'已选择云端模型':'待选择云端转写模型'));
 text('#speechHint',localSpeech?'识别说话和歌词，转成文字后交给当前主模型。':'连接与音频协议将在实际调用时检查，当前未测试。');
 text('#musicState',!a||!decoderReady?'暂不可用':a.musicBackend==='local'?'可用 · 本地基础估计':a.understandingCloudConfigured?'已选择云端模型':'待选择云端理解模型');
 text('#soundState',!a||!decoderReady?'暂不可用':a.understandingCloudConfigured?'已选择云端模型 · 调用时检查兼容性':'未配置 · 可选云端能力');
 $('#hero').dataset.tone=imageReady&&decoderReady?'ready':'warn';
 text('#state',!s.mediaPreparation?'媒体处理暂不可用':!understanding.capable?(understanding.local?'本地画面描述需宿主文字工具支持':'媒体准备可用，主模型查看需宿主支持'):!understanding.configured?'本地画面描述尚未选择模型':!decoderReady?'图片准备可用，音视频解码需检查':understanding.local?'已选择本地画面描述，调用时检查兼容性':'画面准备已就绪，声音能力按需选择');
 text('#detail',!s.mediaPreparation?(s.error||'请查看下方运行详情。'):!applied(data)?'设置已保存，尚未确认生效。下方显示实际运行的能力。':understanding.local?'原图仅交给所选本机 Ollama；主模型收到描述文字，仍可能产生文本费用。小模型可能漏细节；失败不自动回退。':!s.mainModelViewing?'主模型查看等待宿主多模态接口；各项声音处理能力独立显示。':'画面由当前主模型理解，模型本身须支持图片。语音资源未准备不影响图片查看；'+(screen?.enabled?'看屏仅在调用时采集。':'看屏需另外开启。'));
 text('#resourceBadge',!a?'暂不可用':local.ready?'已准备':busy?'准备中':local.supported===false?'当前平台不支持':local.phase==='error'?'需要处理':'尚未准备');$('#resourceBadge').dataset.tone=local.ready?'ready':(localSpeech||local.error)?'warn':'';
 text('#localState',!a?'声音模块暂不可用':local.ready?'本地语音资源已就绪':busy?'正在准备本地语音':local.supported===false?'当前平台不支持本地语音':'尚未准备本地语音资源');
 text('#localHelp',!a?'请检查下方错误信息；图片处理能力仍按实际运行状态提供。':local.ready?'无需重复下载。她可以在需要时自主调用本地识别。':busy?'正在下载、校验并安装组件，请留意下方进度。':local.supported===false?'本地语音当前支持 Windows x64；可按需配置云端语音识别。':'点击按钮才会下载组件和模型；音乐基础分析不需要这些资源。');
 const error=local.error||s.audio?.error;show('#localError',!!error);text('#localError',error||'');show('#downloadArea',busy);const total=Number(local.totalBytes)||0,done=Number(local.downloadBytes)||0;
 if(total>0){$('#download').max=total;$('#download').value=Math.min(done,total);}else $('#download').removeAttribute('value');text('#downloadText',mib(done)+' / '+(total?mib(total):'正在确认资源大小'));
 text('#localDetail','资源下载总量约 '+mib(total)+'。CPU 运行'+(local.fixedThreads?'，固定 '+local.fixedThreads+' 线程':'')+'；同一时间只运行一个本地声音分析任务。');
 const attention=!!error||busy||(localSpeech&&!local.ready);if(attention&&!resourceAttention)$('#resources').open=true;resourceAttention=attention;
 text('#decoder',decoderReady?'内置音视频解码组件已就绪。':'内置音视频组件不可用；图片仍可使用，请检查完整安装包。');text('#usage','临时媒体 '+(s.items||0)+' 份 · '+mib(s.bytes)+' · 本地声音任务 '+(a?.localJobs||0)+(s.cleanupFailed?' · 有临时文件清理失败':''));
 updateForm();
}
async function state(){const response=await fetch('/plugins/vision/state');if(!response.ok)throw Error('无法读取插件状态');return await response.json();}
function acceptConfirmation(data){
 if(!confirmation)return;
 if(confirmation.revision&&confirmation.revision!==data.revision){confirmation=undefined;throw Error('设置已保存，但随后被其他页面修改；当前输入仍保留，请刷新核对。');}
 const values=Object.fromEntries(new FormData(form)),keepDraft=JSON.stringify(readConfig())!==confirmation.snapshot;
 loadForm(data);
 if(keepDraft)for(const [name,value]of Object.entries(values)){const input=field(name);if(input.tagName==='SELECT'&&!Array.from(input.options).some(option=>option.value===value))input.add(new Option('原配置不可用 · '+value,value));input.value=value;}
 confirmation=undefined;show('#saveError',false);
}
async function refresh(){if(loading||saving)return;loading=true;const generation=mutationGeneration;try{const data=await state();if(!saving&&generation===mutationGeneration){try{acceptConfirmation(data);}catch(error){text('#saveError',error.message);show('#saveError',true);}render(data);}}catch{if(generation===mutationGeneration){online=false;text('#state','暂时无法读取运行状态');text('#detail','页面会自动重试；已输入的设置不会被清空。');$('#hero').dataset.tone='warn';updateForm();}}finally{loading=false;}}
form.addEventListener('input',()=>{show('#saveError',false);updateForm();});form.addEventListener('change',updateForm);
form.addEventListener('invalid',event=>{let parent=event.target.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}},true);
async function persist(applyOnly){
 if(saving||!initialized||!online||latest?.applying||(applyOnly&&apply.disabled))return;
 const config=readConfig(),requestedRevision=revision,useApply=latest?.applySupported===true;mutationGeneration++;saving=true;requestApplies=useApply;show('#saveError',false);updateForm();const inputs=Array.from(form.querySelectorAll('input,select'));inputs.forEach(input=>input.disabled=true);
 let received=false,accepted=false,readBack=false;
 try{
  const response=await fetch(applyOnly?'/plugins/vision/apply':'/plugins/vision/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(applyOnly?{revision:requestedRevision}:{config,revision:requestedRevision,...(useApply?{apply:true}:{})})});const result=await response.json();received=true;accepted=result.saved===true||(response.ok&&result.ok);
  if(!accepted)throw Error(result.error||'保存失败，请重试。');
  if(useApply)applyFailureRevision=result.revision||requestedRevision;
  if(!applyOnly)confirmation={revision:result.revision,snapshot:JSON.stringify(config)};
  const data=await state();readBack=true;inputs.forEach(input=>input.disabled=false);
  if(applyOnly&&data.revision!==requestedRevision){render(data);throw Error('已保存设置的版本已变化，请刷新核对后再应用。');}
  try{acceptConfirmation(data);}catch(error){render(data);throw error;}
  render(data);
  if(useApply&&!applied(data))throw Error(data.applyError?.error||result.error||'设置已保存，但尚未确认生效；请查看运行状态后重试应用。');
  if(!useApply&&(!response.ok||!result.ok))throw Error(result.error||'保存结果无法确认，请刷新检查。');
 }catch(error){if(!received||(accepted&&!readBack))online=false;text('#saveError',accepted&&!readBack?'设置已保存，但暂时无法读取运行状态确认是否生效；连接恢复后会重新核对。':error.message||'操作结果无法确认，请检查连接后重试。');show('#saveError',true);}
 finally{inputs.forEach(input=>input.disabled=false);saving=false;requestApplies=false;updateForm();}
}
form.addEventListener('submit',async event=>{event.preventDefault();await persist(false);});
apply.addEventListener('click',async()=>{await persist(true);});
prepare.addEventListener('click',async()=>{if(prepare.disabled)return;preparing=true;prepareMessage='正在提交准备请求…';updateForm();try{const response=await fetch('/plugins/vision/audio/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'无法开始准备');prepareMessage='已开始准备，请查看进度。';}catch(error){prepareMessage=error.message||'无法开始准备';}finally{preparing=false;await refresh();updateForm();}});
await refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},2000);addEventListener('pagehide',()=>clearInterval(timer),{once:true});
</script></html>`;
