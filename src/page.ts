/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export const settingsPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>视听理解</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:900px;margin:0 auto;padding:32px;line-height:1.65}h1{font-size:25px;margin:0 0 6px}h2{font-size:18px;margin-top:0}.muted{opacity:.72}.card{border:1px solid #8885;border-radius:14px;padding:22px;margin:24px 0}.row{display:grid;grid-template-columns:190px 1fr;gap:16px;margin:14px 0;align-items:center}input,select{font:inherit;padding:9px 12px;border:1px solid #8888;border-radius:8px;min-width:0;max-width:100%;background:transparent}button{font:inherit;border:0;border-radius:8px;background:#167b84;color:white;padding:10px 22px;cursor:pointer}button:disabled{opacity:.6;cursor:default}.notice{white-space:pre-wrap}progress{width:100%;height:14px}.actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap}small{display:block}@media(max-width:600px){body{padding:20px}.row{grid-template-columns:1fr;gap:4px}.card{padding:18px}}
</style><h1>让她一起看、一起听</h1><div class="muted">从来源插件取得媒体，用同一时间轴理解画面和声音，继续由当前主模型与你交流。</div>
<section class="card"><strong id="state">正在检查状态…</strong><p id="detail"></p><p id="decoder"></p><div class="muted" id="usage"></div></section>
<form id="settings"><section class="card"><h2>声音处理</h2>
<p class="muted">按用途选择后端。云端处理会将所选片段的声音上传到对应模型服务并产生该服务的用量；失败后不会自动换模型或后端。</p>
<label class="row">语音与歌词转写<select name="speechBackend"><option value="local">轻量本地识别</option><option value="cloud">云端语音识别</option></select></label>
<label class="row">云端转写模型<select name="speechModelId"><option value="">尚未选择</option></select></label>
<small class="muted">选择主干模型设置中的 STT 配置，使用 OpenAI 兼容协议的音频转写接口。缺少时间戳时会明确按整个片段标记。</small>
<label class="row">音乐专项分析<select name="musicBackend"><option value="local">本地特征估计</option><option value="cloud">云端音频理解</option></select></label>
<label class="row">环境声／音乐理解模型<select name="understandingModelId"><option value="">尚未选择</option></select></label>
<small class="muted">选择支持 Qwen-Omni 音频输入的对话或自定义模型配置，使用 OpenAI 兼容协议和兼容 API 根地址。普通文字模型不能直接听音频；本地声音标签也不等于完整环境声理解。</small>
</section>
<section class="card"><h2>本地语音资源</h2><strong id="localState">正在检查…</strong><p id="localDetail" class="muted"></p>
<label class="row">资源下载代理<input name="resourceProxyUrl" type="url" maxlength="500" placeholder="留空直连，例如 http://127.0.0.1:7890"></label>
<small class="muted">仅用于下载本地语音资源，支持不含用户名密码的 HTTP/HTTPS 代理。修改后先保存并重载，再准备资源；不会自动切换连接。</small>
<progress id="download" max="1" value="0" hidden></progress><p id="downloadText" class="muted"></p>
<div class="actions"><button type="button" id="prepare" disabled>一键准备本地能力</button><span id="prepareNotice" class="notice" role="status"></span></div>
<p class="muted">只在你点击时下载固定版本的 CPU 运行组件和识别模型，准备完后她可以自主调用。资源保存在本插件内；同一时间只运行一个本地声音分析任务，未准备好不自动切到云端。</p>
</section>
<section class="card"><h2>临时媒体</h2><p class="muted">媒体按会话隔离，到期或停用后清理。声音原文件不长期收藏。</p>
<label class="row">引用有效期（秒）<input name="ttlSeconds" type="number" min="30" max="7200" required></label>
<label class="row">单文件上限（MiB）<input name="maxMediaMiB" type="number" min="1" max="64" required></label>
<label class="row">总容量上限（MiB）<input name="maxTotalMiB" type="number" min="1" max="512" required></label>
<button id="save" type="submit" disabled>保存设置</button><p id="notice" class="notice" role="status">保存后在插件管理中重载生效。</p></section></form>
<section class="card"><h2>实际理解范围</h2><p>视频可在一次请求中取得画面和语音，再按需要补听环境声或分析音乐。默认看听 30 秒，单次最多 60 秒；长媒体由她按任务继续处理，不把采样片段说成已完整理解全片。</p>
<p class="muted">具备多模态接口的宿主将画面交给当前主模型；旧宿主显示主模型查看暂不可用。音频通过所选后端形成转写或分析资料，当前主模型没有直接收到原音频。本地音乐结果是有局限的信号估计，不是完整乐谱或确定的段落标签。</p></section>
<script type="module">
const form=document.querySelector('#settings'),notice=document.querySelector('#notice'),prepare=document.querySelector('#prepare');
let revision,loading=false,initialized=false;
const text=(id,value)=>{document.querySelector(id).textContent=value;};
const mib=n=>((Number(n)||0)/1048576).toFixed(1)+' MiB';
function render(data){
const s=data.status;text('#state',s.mediaPreparation?'媒体准备就绪':'媒体准备不可用');text('#detail',s.message||s.error||'请检查配置。');
text('#decoder',s.decoder?.ready?'内置音视频解码组件已就绪':'内置音视频组件不可用；图片仍可使用，请检查完整安装包。');
text('#usage','临时媒体 '+(s.items||0)+' 份 · '+mib(s.bytes)+(s.cleanupFailed?' · 有临时文件清理失败':'')+' · 本地声音任务 '+(s.audio?.localJobs||0));
const local=s.audio?.local||{},busy=['checking','downloading','extracting','installing','verifying','preparing'].includes(local.phase);
text('#localState',local.ready?'本地语音已就绪':busy?'正在准备本地语音':'本地语音尚未就绪');
text('#localDetail',(local.fixedThreads?'CPU 运行，固定 '+local.fixedThreads+' 线程。':'CPU 运行。')+(local.error?' '+String(local.error):s.audio?.error?' '+String(s.audio.error):''));
const total=Number(local.totalBytes)||0,done=Number(local.downloadBytes)||0,progress=document.querySelector('#download');
progress.hidden=!busy;if(total>0){progress.max=total;progress.value=Math.min(done,total);}else progress.removeAttribute('value');
text('#downloadText',busy?mib(done)+' / '+(total?mib(total):'正在确认资源大小'):total?'资源下载总量约 '+mib(total):'资源大小由固定发行清单确定。');
prepare.disabled=busy||!!local.ready||!s.audio?.local;prepare.textContent=local.ready?'资源已准备':'一键准备本地能力';
if(!initialized){
 const choices=data.models||[];
 for(const name of ['speechModelId','understandingModelId']){const select=form.elements.namedItem(name),accepted=choices.filter(m=>name==='speechModelId'?m.type==='stt':m.type==='chat'||m.type==='custom');for(const model of accepted){const option=document.createElement('option');option.value=model.id;option.textContent=model.name+' · '+model.id;select.append(option);}}
 const values={...data.config,...data.audioDefaults,...(data.config.audio||{})};
 for(const [key,value] of Object.entries(values)){const field=form.elements.namedItem(key);if(field){if(field.tagName==='SELECT'&&value&&!Array.from(field.options).some(o=>o.value===value)){const option=document.createElement('option');option.value=value;option.textContent='原配置不可用 · '+value;field.append(option);}field.value=value;}}
 revision=data.revision;initialized=true;document.querySelector('#save').disabled=false;if(data.pendingReload)notice.textContent='设置已保存，等待在插件管理中重载生效。';
}}
async function refresh(){if(loading)return;loading=true;try{const response=await fetch('/plugins/vision/state');if(!response.ok)throw Error();render(await response.json());}catch{text('#state','无法读取插件状态');}finally{loading=false;}}
await refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},2000);addEventListener('pagehide',()=>clearInterval(timer),{once:true});
form.addEventListener('submit',async event=>{event.preventDefault();const button=document.querySelector('#save');button.disabled=true;try{
const fields=Object.fromEntries(new FormData(form)),config={ttlSeconds:Number(fields.ttlSeconds),maxMediaMiB:Number(fields.maxMediaMiB),maxTotalMiB:Number(fields.maxTotalMiB),audio:{speechBackend:fields.speechBackend,speechModelId:fields.speechModelId,understandingModelId:fields.understandingModelId,musicBackend:fields.musicBackend,resourceProxyUrl:fields.resourceProxyUrl}};
const response=await fetch('/plugins/vision/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config,revision})});const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'保存失败');const state=await(await fetch('/plugins/vision/state')).json();revision=state.revision;notice.textContent='设置已保存。请在插件管理中重载视听插件后使用新设置。';
}catch(error){notice.textContent=error.message;}finally{button.disabled=false;}});
prepare.addEventListener('click',async()=>{prepare.disabled=true;text('#prepareNotice','正在提交准备请求…');try{const response=await fetch('/plugins/vision/audio/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'无法开始准备');text('#prepareNotice','已开始，请查看进度与结果。');}catch(error){text('#prepareNotice',error.message);}finally{await refresh();}});
</script></html>`;
