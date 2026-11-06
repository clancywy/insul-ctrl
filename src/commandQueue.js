// One GATT write in flight. Stop discards unsent commands; reconnect discards
// the previous connection's queue. A write already in flight cannot be recalled.
export class CommandQueue {
  constructor(write) { this.write=write; this.pending=[]; this.running=false; this.closed=false; }
  send(command) {
    if (this.closed) return Promise.reject(new Error('连接已断开'));
    if (command === 'R:0' || command === 'M:0') this.cancelPending('命令已被停止操作取消');
    return new Promise((resolve,reject) => {
      this.pending.push({command,resolve,reject});
      this.drain();
    });
  }
  cancelPending(reason) { for (const item of this.pending.splice(0)) item.reject(new Error(reason)); }
  close() { this.closed=true; this.cancelPending('连接已断开'); }
  async drain() {
    if (this.running) return;
    this.running=true;
    try {
      while (!this.closed && this.pending.length) {
        const item=this.pending.shift();
        try { await this.write(item.command); item.resolve(); }
        catch (error) { item.reject(error); this.close(); }
      }
    } finally { this.running=false; }
  }
}
