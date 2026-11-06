import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFrame, initialDevice, countdown, deviceSeconds, canStart, errorMessage} from '../src/protocol.js';
import {CommandQueue} from '../src/commandQueue.js';

test('parse real packets without substituting phone time', () => {
  let d=initialDevice();
  for(const f of ['S:0,0,04,23','D:I,1,1,0','F:0,0,I,0','C:1793937600,1','N:0']) d={...d,...parseFrame(f,100)};
  assert.equal(d.deviceTs,1793937600); assert.equal(d.feedback,0);
  assert.equal(canStart(d,101),true); assert.equal(canStart(d,3100),false);
  d={...d,...parseFrame('S:1,0,04,23',1500),...parseFrame('N:1793937603',1500)};
  assert.equal(deviceSeconds(d,2100),1793937602);
  assert.equal(countdown(d,2100),'00:00:01');
  assert.equal(countdown(d,5100),'--:--:--');
  for(const f of ['S:1,0,04,23','D:A,1,1,0','F:0,0,I,0','C:1793937605,1','N:1793937603']) d={...d,...parseFrame(f,5100)};
  assert.equal(countdown(d,5100),'00:00:00');
});
test('malformed frames and unknown feedback do not authorize output', () => {
  for(const f of ['S:1,0,24,00','S:2,1,4x,20','F:1,2,O,0','D:X,1,1,0','C:1,1','C:9999999999,1','N:-1','junk']) assert.equal(parseFrame(f),null,f);
  assert.equal(canStart(initialDevice(),0),false);
  assert.equal(errorMessage('E:FB_LOST'),'运行中反馈丢失');
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
