import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CommandQueue} from '../src/commandQueue.js';

test('a queued time sync is prepared at the actual write, not at enqueue', async()=>{
  let release, now=1000;
  const writes=[];
  const queue=new CommandQueue(command=>{
    writes.push(command);
    return command==='Q' ? new Promise(resolve=>{release=resolve;}) : Promise.resolve();
  });
  const query=queue.send('Q');
  const sync=queue.send('T:1000',()=>`T:${now}`);
  now=1062;
  release();await query;
  const actual=await sync;
  assert.deepEqual(writes,['Q','T:1062']);
  assert.equal(actual,'T:1062');
});

test('a stop discards queued preparation without invoking it', async()=>{
  let release, prepared=0;
  const writes=[];
  const queue=new CommandQueue(command=>{
    writes.push(command);
    return command==='Q' ? new Promise(resolve=>{release=resolve;}) : Promise.resolve();
  });
  const query=queue.send('Q');
  const sync=queue.send('T:1000',()=>{prepared++;return 'T:1062';}).catch(e=>e.canceled);
  const stop=queue.send('R:0');
  release();await query;await stop;
  assert.equal(await sync,true);
  assert.equal(prepared,0);
  assert.deepEqual(writes,['Q','R:0']);
});

test('a failed preparation does not poison the following stop', async()=>{
  const writes=[];
  const queue=new CommandQueue(async command=>{writes.push(command);});
  await assert.rejects(queue.send('T:1000',()=>{throw new Error('expired');}),/expired/);
  await queue.send('R:0');
  assert.deepEqual(writes,['R:0']);
});
