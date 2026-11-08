import type {CommandEnvelope, CommandResult, DeviceCapability, XoftDevice} from '@xoft/protocol';

export class XoftApi {
  constructor(private coreUrl: string, private apiKey: string) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.coreUrl.replace(/\/$/,'')}${path}`, {
      ...init, headers: {'Content-Type':'application/json','Authorization':`Bearer ${this.apiKey}`,...init.headers}
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }
  devices(){return this.request<XoftDevice[]>('/api/devices');}
  register(name:string, platform:'android'|'ios'){return this.request<XoftDevice>('/api/devices',{method:'POST',body:JSON.stringify({name,platform})});}
  heartbeat(id:string){return this.request<XoftDevice>(`/api/devices/${id}/heartbeat`,{method:'POST',body:'{}'});}
  capabilities(id:string, capabilities:DeviceCapability[]){return this.request<XoftDevice>(`/api/devices/${id}/capabilities`,{method:'POST',body:JSON.stringify({capabilities})});}
  state(id:string,state:Partial<XoftDevice['state']>){return this.request<XoftDevice>(`/api/devices/${id}/state`,{method:'POST',body:JSON.stringify(state)});}
  pending(id:string){return this.request<CommandEnvelope[]>(`/api/devices/${id}/commands/pending`);}
  result(id:string,commandId:string,payload:CommandResult){return this.request<CommandEnvelope>(`/api/devices/${id}/commands/${commandId}/result`,{method:'POST',body:JSON.stringify(payload)});}
}
