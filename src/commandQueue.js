// One GATT write in flight. Stop discards unsent commands; reconnect discards
// the previous connection's queue. A write already in flight cannot be recalled.
// A failed write rejects only that command: the App decides from the GATT link
// state whether the session is gone, so a stop can still be retried.
export class CommandQueue {
  constructor(write) { this.write=write; this.pending=[]; this.running=false; this.closed=false; }
  send(command, prepare) {
    if (this.closed) return Promise.reject(new Error('连接已断开'));
    if (command === 'R:0' || command === 'M:0') this.cancelPending('命令已被停止操作取消');
    return new Promise((resolve,reject) => {
      this.pending.push({command,prepare,resolve,reject});
      this.drain();
    });
  }
  cancelPending(reason) {
    for (const item of this.pending.splice(0)) {
      const error=new Error(reason); error.canceled=true;
      item.reject(error);
    }
  }
  close() { this.closed=true; this.cancelPending('连接已断开'); }
  async drain() {
    if (this.running) return;
    this.running=true;
    try {
      while (!this.closed && this.pending.length) {
        const item=this.pending.shift();
        try {
          // Time-sensitive payloads are created only once they reach the writer.
          const command=item.prepare ? item.prepare(item.command) : item.command;
          await this.write(command); item.resolve(command);
        }
        catch (error) { item.reject(error); }
      }
    } finally { this.running=false; }
  }
}
