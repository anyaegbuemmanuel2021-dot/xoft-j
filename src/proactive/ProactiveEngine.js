import crypto from 'node:crypto';
export class ProactiveEngine {
 constructor({worldState,eventBus,activityLog,intervalMs=30000}={}){this.worldState=worldState;this.eventBus=eventBus;this.activityLog=activityLog;this.intervalMs=intervalMs;this.suggestions=[];this.timer=null;this.activeKeys=new Set();}
 start(){if(this.timer)return;this.evaluate();this.timer=setInterval(()=>this.evaluate(),this.intervalMs);this.timer.unref?.();}
 stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
 // Bug fix: condition keys used to be added to a Set that was never cleared,
 // so once a suggestion fired once (e.g. "battery low") it could never fire
 // again even after the condition resolved and re-occurred later. Each
 // evaluate() pass now tracks which condition keys are CURRENTLY true and
 // clears any key that is no longer true, so a resolved-then-recurring
 // condition can raise a fresh suggestion.
 evaluate(){const world=this.worldState?.snapshot?.()??{};const currentKeys=new Set();for(const d of world.devices??[]){const b=Number(d.state?.battery);if(Number.isFinite(b)&&b<=20&&d.online){const key=`device.health:${d.id}`;currentKeys.add(key);this.addSuggestion({key,type:'device.health',title:`${d.name} battery is low`,reason:`${d.name} is at ${b}% battery.`,priority:b<=10 ? 0.95 : 0.75,action:{type:'device',deviceId:d.id,capability:'system',action:'read_system_info'}});}}if((world.approvals??[]).length){const key='approval:pending';currentKeys.add(key);this.addSuggestion({key,type:'approval',title:'XOFT needs your approval',reason:`${world.approvals.length} action(s) are waiting for approval.`,priority:.9,action:{type:'approval'}});}for(const key of [...this.activeKeys]){if(!currentKeys.has(key))this.activeKeys.delete(key);}return this.list();}
 addSuggestion(input){const key=input.key??`${input.type}:${input.title}`;if(this.activeKeys.has(key))return null;const s={id:crypto.randomUUID(),createdAt:new Date().toISOString(),status:'new',...input};this.suggestions.push(s);this.activeKeys.add(key);if(this.suggestions.length>100)this.suggestions.shift();this.activityLog?.log({type:'proactive_suggestion',detail:s});this.eventBus?.emitEvent('proactive.suggestion',s);return s;}
 list({status}={}){return this.suggestions.filter(s=>!status||s.status===status).slice().reverse();}
 dismiss(id){return this._set(id,'dismissed');} acknowledge(id){return this._set(id,'acknowledged');}
 _set(id,status){const s=this.suggestions.find(x=>x.id===id);if(!s)throw new Error(`Suggestion '${id}' not found`);s.status=status;if(status==='dismissed'&&s.key)this.activeKeys.delete(s.key);return s;}
}
