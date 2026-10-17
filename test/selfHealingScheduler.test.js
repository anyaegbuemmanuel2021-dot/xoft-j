import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackgroundJobManager } from '../src/background/BackgroundJobManager.js';
import { RecoveryEngine } from '../src/recovery/RecoveryEngine.js';

test('RecoveryEngine can restart an app through the device capability layer', async () => {
  const calls=[];
  const r=new RecoveryEngine();
  const result=await r.recoverDeviceStep({deviceManager:{execute:async x=>{calls.push(x);return {success:true};}},deviceId:'phone-1',application:'Example',toolName:'device_launch_app',error:new Error('app crashed'),attempt:1});
  assert.equal(result.success,true); assert.equal(calls[0].action,'restart_application');
});

test('BackgroundJobManager schedules an autonomous task for a future time', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xoft-scheduler-'));
  let planned=false, executed=false;
  const manager=new BackgroundJobManager({toolRegistry:{has:()=>true,execute:async()=>({success:true})},taskPlanner:{plan:async goal=>{planned=true;return{id:'task-1',goal};},execute:async()=>{executed=true;return{status:'completed'}}},dataDir:dir,activityLog:{log:()=>{}},eventBus:{emitEvent:()=>{}}});
  const {task,job}=await manager.scheduleTask({goal:'post my update',delayMs:20});
  assert.equal(task.id,'task-1'); assert.equal(job.kind,'task'); assert.equal(planned,true);
  await new Promise(r=>setTimeout(r,60)); assert.equal(executed,true);
});
