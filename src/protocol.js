export const FAULTS = ['正常', '时钟无效，请同步时间', '配置保存失败', '配置异常，请重新保存', '输出故障', '吸合超时', '释放超时', '运行中反馈丢失', 'DI 读取异常'];
export const PHASES = { I: '已关机', P: '正在开机', O: '已开机', R: '等待释放' };
export const initialDevice = () => ({ mode: 'UNKNOWN', relay: false, alarmH: 7, alarmM: 30, deviceTs: 0, clockAt: null, targetTs: 0, targetAt: null, statusAt: null, detailAt: null, feedbackAt: null, rtcValid: false, settingsOk: false, fault: null, feedback: -1, phase: null, feedbackFault: 0, haveFeedback: false, lastUpdate: 0 });

export function parseFrame(raw, now = performance.now()) {
  let m;
  if ((m = /^S:([012]),([01]),(\d{1,2}),(\d{1,2})$/.exec(raw))) {
    if (+m[3] > 23 || +m[4] > 59) return null;
    return { mode: ['IDLE','ARMED','ON'][+m[1]], relay: m[2] === '1', alarmH: +m[3], alarmM: +m[4], statusAt: now, lastUpdate: now };
  }
  if ((m = /^D:([IEAO]),([01]),([01]),([0-8])$/.exec(raw)))
    return { mode: {I:'IDLE',E:'SETTING',A:'ARMED',O:'ON'}[m[1]], rtcValid: m[2] === '1', settingsOk: m[3] === '1', fault: +m[4], detailAt: now, lastUpdate: now };
  if ((m = /^F:([01]),(-1|0|1),([IPOR]),([0-4])$/.exec(raw)))
    return { relay: m[1] === '1', feedback: +m[2], phase: m[3], feedbackFault: +m[4], haveFeedback: true, feedbackAt: now, lastUpdate: now };
  if ((m = /^C:(\d{1,10}),([01])$/.exec(raw))) {
    const ts = +m[1];
    if (m[2] === '1' && (ts < 946684800 || ts > 4102444799)) return null;
    return { deviceTs: m[2] === '1' ? ts : 0, rtcValid: m[2] === '1', clockAt: now, lastUpdate: now };
  }
  if ((m = /^N:(\d{1,10})$/.exec(raw))) {
    if (+m[1] !== 0 && (+m[1] < 946684800 || +m[1] > 4102531199)) return null;
    return { targetTs: +m[1], targetAt: now, lastUpdate: now };
  }
  return null;
}

export function errorMessage(raw) {
  const messages = { RTC: FAULTS[1], STORE: FAULTS[2], CONFIG: FAULTS[3], OUTPUT: FAULTS[4], FB_PICKUP: FAULTS[5], FB_RELEASE: FAULTS[6], FB_LOST: FAULTS[7], FB_INPUT: FAULTS[8], FEEDBACK: '请先确认输出已关闭、DI 已释放', STATE: '当前状态不允许此操作', CANCELED: '命令已被停止操作取消', FULL: '命令队列已满，请稍后重试', RANGE: '参数超出范围', FORMAT: '命令格式错误', CMD: '设备不支持此命令', LEN: '命令长度错误', UTF8: '命令编码错误' };
  if (!/^E:[A-Z_]+$/.test(raw)) return null;
  return messages[raw.slice(2)] || `设备拒绝命令：${raw.slice(2)}`;
}

export function deviceSeconds(data, now) {
  return data.rtcValid && data.deviceTs ? data.deviceTs + Math.floor(Math.max(0, now-data.clockAt)/1000) : 0;
}
export function countdown(data, now) {
  const ts = deviceSeconds(data, now);
  if (!statusFresh(data, now) || !recent(data.targetAt, now) || data.mode !== 'ARMED' || !data.targetTs || !ts) return '--:--:--';
  const left = Math.max(0, data.targetTs-ts);
  return [Math.floor(left/3600),Math.floor(left/60)%60,left%60].map(v=>String(v).padStart(2,'0')).join(':');
}
export function canStart(data, now) {
  return statusFresh(data, now) && data.deviceTs > 0 && data.fault === 0 && data.rtcValid && data.settingsOk && data.feedbackFault === 0 && data.feedback === 0 && data.phase === 'I' && !data.relay && data.mode === 'IDLE';
}

export function recent(at, now) {
  return Number.isFinite(at) && now-at < 3000;
}

export function statusFresh(data, now) {
  // An RTC heartbeat must not make an old DI or fault report look current.
  return data.haveFeedback && [data.statusAt, data.detailAt, data.feedbackAt, data.clockAt].every(at => recent(at, now));
}

export function canConfigure(data, now) {
  return statusFresh(data, now) && data.mode === 'IDLE' && !data.relay && data.feedback === 0 && data.phase === 'I' && data.feedbackFault === 0 && [0,1,2,3].includes(data.fault);
}

export function canAcknowledge(data, now) {
  return statusFresh(data, now) && data.feedbackFault > 0 && !data.relay && data.feedback === 0 && data.phase === 'I';
}
