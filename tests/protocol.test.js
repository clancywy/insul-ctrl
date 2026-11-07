import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticText, stopKind, stopFailureText, parseFrame, initialDevice, countdown, deviceSeconds, canStart, errorMessage, hasCommandReadback} from '../src/protocol.js';
import {CommandQueue} from '../src/commandQueue.js';

test('parse real packets without substituting phone time', () => {
  let d=initialDevice();
  for(const f of ['S:0,0,04,23','D:I,1,1,0','F:0,0,I,0','C:1793937600,1','N:0']) d={...d,...parseFrame(f,100)};
  assert.equal(d.deviceTs,1793937600); assert.equal(d.feedback,0);
  assert.equal(canStart(d,101),true); assert.equal(canStart(d,3100),false);
  d={...d,...parseFrame('S:1,0,04,23',1500),...parseFrame('D:A,1,1,0',1500),...parseFrame('N:1793937603',1500)};
  assert.equal(deviceSeconds(d,2100),1793937602);
  assert.equal(countdown(d,2100),'00:00:01');
  assert.equal(countdown(d,5100),'--:--:--');
  for(const f of ['S:1,0,04,23','D:A,1,1,0','F:0,0,I,0','C:1793937605,1','N:1793937603']) d={...d,...parseFrame(f,5100)};
  assert.equal(countdown(d,5100),'00:00:00');
});
test('malformed frames and unknown feedback do not authorize output', () => {
  for(const f of ['S:1,0,24,00','S:2,1,4x,20','F:1,2,O,0','D:X,1,1,0','C:1,1','C:9999999999,1','N:-1','junk']) assert.equal(parseFrame(f),null,f);
  assert.equal(canStart(initialDevice(),0),false);
  assert.equal(errorMessage('E:FB_LOST'),'反馈异常，请检查接触器及反馈接线');
  assert.equal(parseFrame('F:0,-1,I,4').feedback,-1);
});
test('stop flushes unsent starts and GATT writes never overlap', async () => {
  const calls=[],release=[];
  const q=new CommandQueue(cmd=>{calls.push(cmd);return new Promise(resolve=>release.push(resolve));});
  const first=q.send('Q');
  const canceled=q.send('R:1').then(()=>false,()=>true);
  const stopped=q.send('R:0');
  assert.deepEqual(calls,['Q']);
  release.shift()(); await first; await Promise.resolve();
  assert.deepEqual(calls,['Q','R:0']);
  release.shift()(); await stopped; assert.equal(await canceled,true);
});
test('disconnect cancels old queue', async () => {
  let release;
  const calls=[];
  const q=new CommandQueue(cmd=>{calls.push(cmd);return new Promise(r=>release=r);});
  const first=q.send('Q'); const canceled=q.send('R:1').catch(e=>e.message);
  q.close(); release(); await first;
  assert.equal(await canceled,'连接已断开'); assert.deepEqual(calls,['Q']);
  await assert.rejects(q.send('R:1'));
});

test('the S frame cannot rewrite the business mode between heartbeats', () => {
  let d=initialDevice();
  for(const f of ['S:0,0,04,23','D:E,1,1,0','F:0,0,I,0','C:1793937600,1','N:0']) d={...d,...parseFrame(f,100)};
  d={...d,...parseFrame('S:0,0,04,23',1100)};
  assert.equal(d.mode,'SETTING');
  assert.equal(canStart(d,1101),false);
});
test('the X frame gates commands, and firmware without it needs no PIN', () => {
  const frames=['S:0,0,04,23','D:I,1,1,0','F:0,0,I,0','C:1793937600,1','N:0'];
  let d=initialDevice();
  for(const f of frames) d={...d,...parseFrame(f,100)};
  assert.equal(d.auth,null);
  assert.equal(canStart(d,101),true);
  d={...d,...parseFrame('X:0,0',100)};
  assert.equal(canStart(d,101),false);
  d={...d,...parseFrame('X:1,1',100)};
  assert.equal(canStart(d,101),true);
  assert.equal(d.resetNote,true);
  assert.equal(parseFrame('X:2,0'),null);
});
test('every firmware error code has a Chinese message', () => {
  for(const code of ['AUTH','PIN','LOCK','COOLDOWN','BUSY','UTF8','STATE','FEEDBACK','CANCELED','RANGE','FORMAT','CMD','LEN','RTC','STORE','CONFIG','OUTPUT','FB_PICKUP','FB_RELEASE','FB_LOST','FB_INPUT']) {
    const text=errorMessage('E:'+code);
    assert.ok(text,code);
    assert.doesNotMatch(text,/设备拒绝命令/,code);
  }
});
test('a failed write does not close the queue, so a stop can be retried', async () => {
  let fail=1; const sent=[];
  const q=new CommandQueue(async c=>{ if(fail-->0) throw new Error('GATT'); sent.push(c); });
  await assert.rejects(q.send('T:1'));
  await q.send('R:0');
  assert.deepEqual(sent,['R:0']);
});

test('command confirmation requires relevant readback newer than the write', () => {
  let d=initialDevice();
  for(const f of ['S:0,0,04,23','D:I,1,1,0','F:0,0,I,0','C:1793937600,1','N:0']) d={...d,...parseFrame(f,100)};
  assert.equal(hasCommandReadback(d,'T:1793937600',100,101),false);
  d={...d,...parseFrame('C:1793937600,1',120)};
  assert.equal(hasCommandReadback(d,'T:1793937600',100,121),true);
  assert.equal(hasCommandReadback(d,'A:04:23',100,121),false);
  d={...d,...parseFrame('S:0,0,04,23',130),...parseFrame('D:I,1,1,0',130)};
  assert.equal(hasCommandReadback(d,'A:04:23',100,131),true);
  assert.equal(hasCommandReadback(d,'R:0',100,131),false);
  d={...d,...parseFrame('F:0,0,I,0',140)};
  assert.equal(hasCommandReadback(d,'R:0',100,141),true);
  assert.equal(hasCommandReadback(d,'R:0',100,4000),false);
});

test('the display categories keep the cause available', () => {
  assert.equal(diagnosticText({fault:0,feedbackFault:0}),'无');
  assert.equal(diagnosticText({fault:5,feedbackFault:1}),'E5 吸合超时');
  assert.equal(diagnosticText({fault:0,feedbackFault:3}),'E7 运行中反馈丢失');
  assert.equal(diagnosticText({fault:3,feedbackFault:0}),'E3 配置异常');
});

test('a failed stop says what it really means for that state', () => {
  const on={relay:true,feedback:1}, off={relay:false,feedback:0};
  assert.equal(stopKind('R:0',on,true),'output');
  assert.equal(stopKind('R:0',off,false),'output');
  assert.equal(stopKind('R:0',off,true),'local');
  assert.equal(stopKind('M:0',off,true),'alarm');
  for(const stage of ['write','stuck','lost','gone']) {
    assert.match(stopFailureText('alarm',stage),/取消闹钟/);
    assert.doesNotMatch(stopFailureText('alarm',stage),/设备可能仍在运行/);
    assert.match(stopFailureText('output',stage),/关机命令/);
  }
});
