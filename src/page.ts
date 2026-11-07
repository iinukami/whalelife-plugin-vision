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
</style>
<header><h1>视听理解</h1><p class="intro muted">一起看，一起听。继续由当前主模型理解并与你交流。</p></header>
<section class="hero" id="hero" aria-labelledby="state"><div class="eyebrow">当前能力</div><h2 id="state">正在检查…</h2><p id="detail">正在读取实际运行状态。</p>
<dl class="capabilities">
<div class="capability"><dt>语音识别</dt><dd><span id="speechState">检查中</span><small id="speechHint">识别说话和歌词，整理成文字。</small></dd></div>
<div class="capability"><dt>音乐分析</dt><dd><span id="musicState">检查中</span><small>节奏、音高和和弦仅作参考，不保证准确扒谱。</small></dd></div>
<div class="capability"><dt>环境声理解</dt><dd><span id="soundState">检查中</span><small>可选云端能力，用于描述环境中的声音。</small></dd></div>
</dl></section>
<form id="settings">
<details class="panel" id="processing"><summary>处理方式与云端能力<span class="pill">按需调整</span></summary><div class="panel-body">
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
<details id="downloadSettings" class="section"><summary>下载设置与组件详情</summary><label class="row">资源下载代理<input name="resourceProxyUrl" type="url" maxlength="500" placeholder="留空直连，例如 http://127.0.0.1:7890"></label><p class="field-help">只影响本地语音资源下载，不改变模型连接。支持不含用户名密码的 HTTP/HTTPS 地址；修改后先保存并重载。</p><p id="localDetail" class="technical"></p></details>
</div></details>
<details class="panel" id="advanced"><summary>高级设置<span class="pill">通常无需修改</span></summary><div class="panel-body"><div class="section"><h2>临时媒体</h2><p class="hint">控制音视频临时文件的保留时间和占用，不影响聊天记忆。媒体按会话隔离，过期或停用后清理。</p>
<label class="row">引用有效期（秒）<input name="ttlSeconds" type="number" min="30" max="7200" required></label><p class="field-help">1800 秒为 30 分钟。过期后继续查看，需要重新取得媒体。</p>
<label class="row">单文件上限（MiB）<input name="maxMediaMiB" type="number" min="1" max="64" required></label><label class="row">总容量上限（MiB）<input name="maxTotalMiB" type="number" min="1" max="512" required></label><p class="field-help">总容量统计所有会话的临时媒体，不能小于单文件上限。</p></div><div class="technical"><p id="decoder"></p><p id="usage"></p></div></div></details>
<div class="save-area"><div class="actions"><button id="save" class="primary" type="submit" disabled>保存设置</button><span id="saveState" class="pill">正在读取</span><a id="manage" class="link-button" href="/#plugins" target="_top" hidden>前往插件管理重载</a></div><p id="notice" class="muted" role="status">保存配置后，重载插件才会生效。</p><p id="saveError" role="alert" hidden></p></div>
</form>
<p class="footnote">默认每次看听 30 秒，单次最多 60 秒，可继续分段处理。当前主模型收到画面与声音文字资料；选择本地识别时，转写文字仍会交给主模型。</p>
<details class="panel"><summary>理解范围与使用说明</summary><div class="panel-body"><p class="hint">来源插件负责取得媒体；这页显示处理能力，不代表网页或平台媒体已完成接入。视频画面通过采样观察，快速动作可能遗漏。歌词识别可能受伴奏影响，本地音乐分析不等于完整乐谱或确定的段落标签。</p><p class="hint">具备多模态接口的宿主将画面交给当前主模型；旧宿主显示主模型查看暂不可用。所选主模型仍须支持图片。主模型没有直接收到原音频。</p></div></details>
<script type="module">
const $=selector=>document.querySelector(selector),form=$('#settings'),save=$('#save'),prepare=$('#prepare');
const text=(selector,value)=>{$(selector).textContent=value;},show=(selector,value)=>{$(selector).hidden=!value;},field=name=>form.elements.namedItem(name);
const mib=n=>((Number(n)||0)/1048576).toFixed(1)+' MiB';
let revision,latest,savedSnapshot='',savedProxy='',initialized=false,loading=false,saving=false,preparing=false,online=false,resourceAttention=false,prepareMessage='';
function readConfig(){const values=Object.fromEntries(new FormData(form));return {ttlSeconds:Number(values.ttlSeconds),maxMediaMiB:Number(values.maxMediaMiB),maxTotalMiB:Number(values.maxTotalMiB),audio:{speechBackend:values.speechBackend,speechModelId:values.speechModelId,understandingModelId:values.understandingModelId,musicBackend:values.musicBackend,resourceProxyUrl:values.resourceProxyUrl}};}
function dirty(){return initialized&&JSON.stringify(readConfig())!==savedSnapshot;}
function loadForm(data){
 const choices=data.models||[];
 for(const name of ['speechModelId','understandingModelId']){const select=field(name),selected=(data.config.audio||{})[name]||'';select.replaceChildren(new Option('尚未选择',''));for(const model of choices.filter(m=>name==='speechModelId'?m.type==='stt':m.type==='chat'||m.type==='custom'))select.add(new Option(model.name,model.id));if(selected&&!Array.from(select.options).some(o=>o.value===selected))select.add(new Option('原配置不可用 · '+selected,selected));}
 const values={...data.config,...data.audioDefaults,...(data.config.audio||{})};for(const [name,value]of Object.entries(values)){const input=field(name);if(input)input.value=value;}
 revision=data.revision;savedSnapshot=JSON.stringify(readConfig());savedProxy=field('resourceProxyUrl').value;initialized=true;
}
function updateForm(){
 const cloudSpeech=field('speechBackend').value==='cloud',cloudMusic=field('musicBackend').value==='cloud';
 show('#speechCloud',cloudSpeech);show('#speechWarning',cloudSpeech&&!field('speechModelId').value);show('#musicWarning',cloudMusic&&!field('understandingModelId').value);
 text('#speechModeHelp',cloudSpeech?'将音频片段上传给下方转写模型。':'在这台电脑识别，无需配置云端转写模型。');
 text('#musicModeHelp',cloudMusic?'使用下方“环境声／音乐理解模型”提供描述性分析。':'不需要下载音乐模型；只提供有局限的节奏、音高和和弦候选。');
 text('#soundOptional',cloudMusic?'云端音乐需要':'可选');
 const changed=dirty(),pending=!!latest?.pendingReload;
 save.disabled=!initialized||!online||saving||!changed;text('#save',saving?'正在保存…':'保存设置');
 text('#saveState',!initialized?'正在读取':!online?'连接中断':saving?'正在保存':changed?'有未保存的修改':pending?'等待重载':'设置已生效');
 $('#saveState').dataset.tone=changed||pending||!online?'warn':'ready';show('#manage',pending);
 text('#notice',!online?'无法读取最新状态，请检查项目是否运行；未保存的输入仍保留。':changed?(pending?'另有修改尚未保存；已保存的设置也需重载后生效。':'修改尚未保存，当前处理方式保持不变。'):pending?'设置已保存。请在插件管理中重载“视听理解”后生效；重载会结束在途处理并使临时媒体引用失效。':'不需要调整时，保持当前设置即可。');
 const local=latest?.status.audio?.local||{},busy=['checking','downloading','extracting','installing','verifying','preparing'].includes(local.phase),proxyChanged=initialized&&field('resourceProxyUrl').value!==savedProxy;
 prepare.disabled=!online||saving||preparing||busy||!!local.ready||!latest?.status.audio?.local||local.supported===false||pending||proxyChanged;
 text('#prepare',local.ready?'资源已准备':preparing||busy?'正在准备…':local.phase==='error'?'重新准备本地能力':'一键准备本地能力');
 text('#prepareNotice',local.ready?'':pending||proxyChanged?'先保存并重载设置，再准备资源。':local.phase==='error'?'':prepareMessage);
}
function render(data){
 latest=data;online=true;if(!initialized)loadForm(data);
 const s=data.status,a=s.audio?.unavailable?undefined:s.audio,local=a?.local||{},decoderReady=!!s.decoder?.ready,busy=['checking','downloading','extracting','installing','verifying','preparing'].includes(local.phase);
 const localSpeech=a?.speechBackend==='local',speechReady=!!a&&decoderReady&&(localSpeech?local.ready:a.speechCloudConfigured);
 text('#speechState',!a?'暂不可用':!decoderReady?'解码组件未就绪':localSpeech?(local.ready?'已就绪 · 本地识别':busy?'准备中 · 本地识别':'尚未就绪 · 本地识别'):(a.speechCloudConfigured?'已选择云端模型':'待选择云端转写模型'));
 text('#speechHint',localSpeech?'识别说话和歌词，转成文字后交给当前主模型。':'连接与音频协议将在实际调用时检查，当前未测试。');
 text('#musicState',!a||!decoderReady?'暂不可用':a.musicBackend==='local'?'可用 · 本地基础估计':a.understandingCloudConfigured?'已选择云端模型':'待选择云端理解模型');
 text('#soundState',!a||!decoderReady?'暂不可用':a.understandingCloudConfigured?'已选择云端模型 · 调用时检查兼容性':'未配置 · 可选云端能力');
 const good=s.mediaPreparation&&s.mainModelViewing&&speechReady;
 $('#hero').dataset.tone=good?'ready':'warn';
 text('#state',!s.mediaPreparation?'媒体处理暂不可用':!s.mainModelViewing?'当前宿主的主模型查看暂不可用':!decoderReady?'音视频解码组件需要检查':!a?'声音处理暂不可用':localSpeech?(local.ready?'本地语音已就绪，可以使用':busy?'正在准备本地语音':'使用本地语音前，还需准备资源'):(a.speechCloudConfigured?'已选择云端语音处理':'还需选择云端转写模型'));
 text('#detail',!s.mediaPreparation||!a?(s.error||s.audio?.error||'请查看资源状态与运行详情。'):data.pendingReload?'设置已保存，重载后生效。下方显示当前正在运行的能力。':good?(localSpeech?'当前语音使用本地识别，无需额外配置。云端能力可按需添加。':'音频片段将交给所选云端服务；保存配置不代表连接已通过测试。'):!s.mainModelViewing?'请检查宿主多模态接口支持；媒体准备服务仍按实际状态提供。':!decoderReady?'图片仍可使用，请检查完整安装包。':'展开对应设置查看需要完成的步骤。');
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
async function refresh(){if(loading||saving)return;loading=true;try{const data=await state();if(!saving)render(data);}catch{online=false;text('#state','暂时无法读取运行状态');text('#detail','页面会自动重试；已输入的设置不会被清空。');$('#hero').dataset.tone='warn';updateForm();}finally{loading=false;}}
form.addEventListener('input',()=>{show('#saveError',false);updateForm();});form.addEventListener('change',updateForm);
form.addEventListener('invalid',event=>{let parent=event.target.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}},true);
form.addEventListener('submit',async event=>{event.preventDefault();if(saving||!initialized)return;const config=readConfig();saving=true;show('#saveError',false);updateForm();const inputs=Array.from(form.querySelectorAll('input,select'));inputs.forEach(input=>input.disabled=true);
 try{const response=await fetch('/plugins/vision/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config,revision})});const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'保存失败，请重试。');const data=await state();inputs.forEach(input=>input.disabled=false);loadForm(data);render(data);}
 catch(error){text('#saveError',error.message||'保存结果无法确认，请刷新检查后再操作。');show('#saveError',true);}
 finally{inputs.forEach(input=>input.disabled=false);saving=false;updateForm();}
});
prepare.addEventListener('click',async()=>{if(prepare.disabled)return;preparing=true;prepareMessage='正在提交准备请求…';updateForm();try{const response=await fetch('/plugins/vision/audio/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'无法开始准备');prepareMessage='已开始准备，请查看进度。';}catch(error){prepareMessage=error.message||'无法开始准备';}finally{preparing=false;await refresh();updateForm();}});
await refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},2000);addEventListener('pagehide',()=>clearInterval(timer),{once:true});
</script></html>`;
