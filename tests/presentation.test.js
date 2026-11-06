import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialDevice, parseFrame, statusFresh, canStart, canConfigure, canAcknowledge } from '../src/protocol.js';
import { displayState, triggerTime, LAMPS } from '../src/presentation.js';

const fixture = (mode='I', relay=0, di=0, phase='I', fault=0, feedbackFault=0, at=100) => {
  let data=initialDevice();
  const modeCode=mode==='A'?1:mode==='O'?2:0;
  for (const frame of [`S:${modeCode},${relay},04,23`, `D:${mode},1,1,${fault}`, `F:${relay},${di},${phase},${feedbackFault}`, 'C:1793979600,1', 'N:0'])
    data={...data,...parseFrame(frame,at)};
  return data;
};

test('normal state names and lamps follow the controller', () => {
  const cases=[
    [fixture(), 'IDLE','空闲','green'],
    [fixture('E'), 'SETTING','设置','amber'],
    [fixture('A'), 'ARMED','闹钟','blue'],
    [fixture('O',1,0,'P'), 'PICKUP','正在开机','red'],
    [fixture('O',1,1,'O'), 'ON','已开机','red'],
    [fixture('I',0,1,'R'), 'RELEASE','等待释放','green'],
  ];
  for(const [data,key,title,lamp] of cases) {
    const view=displayState(data,101);
    assert.deepEqual([view.key,view.title,view.lamp],[key,title,lamp]);
    assert.ok(LAMPS[lamp].rgb);
  }
});

test('a relay command alone never means confirmed power on', () => {
  assert.equal(displayState(fixture('O',1,0,'P'),101).title,'正在开机');
  assert.equal(displayState(fixture('O',1,1,'P'),101).title,'正在开机');
  assert.equal(displayState(fixture('O',1,0,'O'),101).title,'正在开机');
  assert.equal(displayState(fixture('O',1,1,'O'),101).title,'已开机');
  assert.equal(displayState(fixture('I',0,1,'O'),101).title,'等待释放');
});

test('every fault overrides the mode lamp and inhibits starting', () => {
  for(let fault=1;fault<=8;fault++) {
    const data=fixture('I',0,0,'I',fault);
    assert.equal(displayState(data,101).lamp,'pink');
    assert.equal(canStart(data,101),false);
  }
  const data=fixture('I',0,1,'R',0,2);
  assert.equal(displayState(data,101).detail,'释放超时');
  assert.equal(displayState(data,101).lamp,'pink');
});

test('clock or status traffic cannot renew stale feedback or fault information', () => {
  for(const missing of ['S','D','F','C']) {
    let data=fixture();
    for(const frame of ['S:0,0,04,23','D:I,1,1,0','F:0,0,I,0','C:1793979603,1','N:0'])
      if(!frame.startsWith(missing+':')) data={...data,...parseFrame(frame,3200)};
    assert.equal(statusFresh(data,3201),false,missing);
    assert.equal(canStart(data,3201),false,missing);
    assert.equal(displayState(data,3201).key,'WAIT',missing);
    assert.equal(displayState(data,3201).lamp,null,missing);
  }
  assert.equal(statusFresh({...initialDevice(),...parseFrame('S:0,0,04,23',100)},101),false);
});

test('start and settings are unavailable until idle with confirmed release', () => {
  for(const data of [fixture('A'),fixture('E'),fixture('O',1,0,'P'),fixture('O',1,1,'O'),fixture('I',0,1,'R')]) {
    assert.equal(canStart(data,101),false);
    assert.equal(canConfigure(data,101),false);
  }
  assert.equal(canStart(fixture(),101),true);
  assert.equal(canConfigure(fixture(),101),true);
  for(const fault of [1,2,3]) assert.equal(canConfigure(fixture('I',0,0,'I',fault),101),true);
});

test('fault acknowledgement needs fresh feedback and fully released output', () => {
  assert.equal(canAcknowledge(fixture('I',0,1,'R',6,2),101),false);
  assert.equal(canAcknowledge(fixture('I',0,0,'I',6,2),101),true);
  assert.equal(canAcknowledge(fixture('I',0,0,'I',6,2),3200),false);
  assert.equal(canAcknowledge(fixture(),101),false);
});

test('trigger time is the actual controller target in UTC+8', () => {
  const target=Date.UTC(2026,10,6,15,41,0)/1000;
  const data={...fixture('A'),...parseFrame(`N:${target}`,100)};
  assert.equal(triggerTime(data,101),'23:41');
  assert.equal(triggerTime({...data,targetAt:null},101),'--:--');
  assert.equal(triggerTime({...data,mode:'IDLE'},101),'--:--');
});

test('rotary instructions have no power-off action in alarm mode or two-second stop while on', () => {
  assert.doesNotMatch(displayState(fixture('A'),101).hint,/10 秒|关机/);
  assert.match(displayState(fixture('O',1,1,'O'),101).hint,/10 秒关机/);
  assert.doesNotMatch(displayState(fixture('O',1,1,'O'),101).hint,/回到空闲/);
  assert.doesNotMatch(displayState(fixture('I',0,1,'R'),101).hint,/2 秒|10 秒/);
});
