import {invoke} from '@tauri-apps/api/core';
import type {XoftDevice} from '@xoft/protocol';
const root=document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML=`<main><h1>XOFT</h1><p>Universal desktop agent</p><input id="url" value="http://127.0.0.1:3000" placeholder="Core URL"><input id="key" type="password" placeholder="API key"><button id="connect">Connect</button><pre id="out">Disconnected</pre></main>`;
document.querySelector('#connect')!.addEventListener('click',async()=>{const url=(document.querySelector('#url') as HTMLInputElement).value;const key=(document.querySelector('#key') as HTMLInputElement).value;try{const d=await invoke<XoftDevice>('connect_core',{coreUrl:url,apiKey:key});document.querySelector('#out')!.textContent=JSON.stringify(d,null,2);}catch(e){document.querySelector('#out')!.textContent=String(e);}});
