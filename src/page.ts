/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export const settingsPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>视觉</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:860px;margin:0 auto;padding:32px;line-height:1.6}h1{font-size:24px;margin:0 0 6px}.muted{opacity:.72}.card{border:1px solid #8885;border-radius:14px;padding:22px;margin:24px 0}.row{display:grid;grid-template-columns:180px 1fr;gap:16px;margin:14px 0;align-items:center}input{font:inherit;padding:9px 12px;border:1px solid #8888;border-radius:8px;min-width:0}button{font:inherit;border:0;border-radius:8px;background:#167b84;color:white;padding:10px 22px;cursor:pointer}button:disabled{opacity:.6}#notice{white-space:pre-wrap}code{font-size:13px}@media(max-width:600px){body{padding:20px}.row{grid-template-columns:1fr;gap:4px}}
</style><h1>让她看到图片和视频</h1><div class="muted">接收其他插件提供的媒体，准备画面概览，并按需查看细节。</div>
<section class="card"><strong id="state">正在检查状态…</strong><p id="detail"></p><p id="decoder">正在检查内置视频组件…</p><div class="muted" id="usage"></div></section>
<section class="card"><h2>临时媒体</h2><p class="muted">媒体按会话隔离，到期或停用后清理。收藏由图库负责。</p><form id="settings">
<label class="row">引用有效期（秒）<input name="ttlSeconds" type="number" min="30" max="7200" required></label>
<label class="row">单文件上限（MiB）<input name="maxMediaMiB" type="number" min="1" max="64" required></label>
<label class="row">总容量上限（MiB）<input name="maxTotalMiB" type="number" min="1" max="512" required></label>
<button id="save" type="submit">保存设置</button><p id="notice" role="status">保存后在插件管理中重载生效。</p></form></section>
<section class="card"><strong>本版本的可用范围</strong><p>具备多模态接口的宿主可将画面交给当前主模型；具体模型须支持图片。旧宿主显示主模型查看暂不可用，媒体准备成功不代表模型已经看到画面。</p><p class="muted">视频按时间段采样，每次最多 60 秒、8 个画面；支持指定时刻和局部细节。当前不包含音频。视频组件随插件提供，无需另行配置。</p></section>
<script type="module">
const form=document.querySelector('#settings'), notice=document.querySelector('#notice');
let revision;
try{const response=await fetch('/plugins/vision/state');if(!response.ok)throw Error('无法读取状态');const data=await response.json();
document.querySelector('#state').textContent=data.status.mediaPreparation?'媒体准备就绪':'媒体准备不可用';
document.querySelector('#detail').textContent=data.status.message||data.status.error||'请检查配置。';
document.querySelector('#decoder').textContent=data.status.decoder?.ready?'内置视频组件已就绪':'内置视频组件不可用，请重新安装对应系统的完整插件；图片仍可使用。';
document.querySelector('#usage').textContent='临时媒体 '+(data.status.items||0)+' 份 · '+((data.status.bytes||0)/1048576).toFixed(1)+' MiB'+(data.status.cleanupFailed?' · 有临时文件清理失败，请检查插件状态':'');
for(const [name,value] of Object.entries(data.config)){const field=form.elements.namedItem(name);if(field)field.value=value;}revision=data.revision;if(data.pendingReload)notice.textContent='设置已保存，等待在插件管理中重载生效。';
}catch(error){document.querySelector('#state').textContent='无法读取插件状态';}
form.addEventListener('submit',async(event)=>{event.preventDefault();const button=document.querySelector('#save');button.disabled=true;try{const config=Object.fromEntries(new FormData(form));for(const key of ['ttlSeconds','maxMediaMiB','maxTotalMiB'])config[key]=Number(config[key]);
const response=await fetch('/plugins/vision/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config,revision})});const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'保存失败');const state=await(await fetch('/plugins/vision/state')).json();revision=state.revision;notice.textContent='已保存。请在插件管理中重载视觉插件后使用新设置。';}catch(error){notice.textContent=error.message;}finally{button.disabled=false;}});
</script></html>`;
