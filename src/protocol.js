// Display categories only; the numeric D/F codes and raw diagnostic frames stay distinct.
export const FAULTS = ['正常', '时钟异常', '设置异常', '设置异常', '设备恢复中', '反馈异常', '反馈异常', '反馈异常', '反馈异常'];
// The cause behind each category, for the drawer and the connection log.
export const DIAGNOSTICS = ['', '时钟无效', '配置保存失败', '配置异常', '输出故障', '吸合超时', '释放超时', '运行中反馈丢失', 'DI 读取异常'];
export function diagnosticText(data) {
  const code = data.fault || [0,5,6,7,8][data.feedbackFault] || 0;
  return code ? `E${code} ${DIAGNOSTICS[code]}` : '无';
}
export const PHASES = { I: '已关机', P: '正在开机', O: '已开机', R: '等待释放' };
export const initialDevice = () => ({ mode: 'UNKNOWN', relay: false, alarmH: 7, alarmM: 30, deviceTs: 0, clockAt: null, targetTs: 0, targetAt: null, statusAt: null, detailAt: null, feedbackAt: null, rtcValid: false, settingsOk: false, fault: null, feedback: -1, phase: null, feedbackFault: 0, haveFeedback: false, auth: null, resetNote: false, lastUpdate: 0 });

export function parseFrame(raw, now = performance.now()) {
  let m;
  if ((m = /^S:([012]),([01]),(\d{1,2}),(\d{1,2})$/.exec(raw))) {
    if (+m[3] > 23 || +m[4] > 59) return null;
    // mode 0 cannot tell idle from local setting, so only the D frame may write the mode.
    return { relay: m[2] === '1', alarmH: +m[3], alarmM: +m[4], statusAt: now, lastUpdate: now };
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
  // X only exists on firmware with a PIN; auth stays null (no PIN needed) on older firmware.
  if ((m = /^X:([01]),([01])$/.exec(raw)))
    return { auth: m[1] === '1', resetNote: m[2] === '1', lastUpdate: now };
  if ((m = /^N:(\d{1,10})$/.exec(raw))) {
    if (+m[1] !== 0 && (+m[1] < 946684800 || +m[1] > 4102531199)) return null;
    return { targetTs: +m[1], targetAt: now, lastUpdate: now };
  }
  return null;
}

export function errorMessage(raw) {
  const feedback = '反馈异常，请检查接触器及反馈接线';
  const settings = '设置异常，请重新设置并保存';
  const messages = { RTC: '时钟异常，请同步时间', STORE: settings, CONFIG: settings, OUTPUT: '设备恢复中，请等待重启后重新连接', FB_PICKUP: feedback, FB_RELEASE: feedback, FB_LOST: feedback, FB_INPUT: feedback, FEEDBACK: '请先确认输出已关闭、DI 已释放', STATE: '当前状态不允许此操作', CANCELED: '命令已被停止操作取消', BUSY: '设备命令队列已满，请稍后重试', AUTH: '请先输入控制器屏幕上显示的口令', PIN: '口令不正确', LOCK: '口令错误次数过多，请 1 分钟后再试', COOLDOWN: '刚关机，5 秒内不能再开机', RANGE: '参数超出范围', FORMAT: '命令格式错误', CMD: '设备不支持此命令', LEN: '命令长度错误', UTF8: '命令编码错误' };
  if (!/^E:[A-Z0-9_]+$/.test(raw)) return null;
  return messages[raw.slice(2)] || `设备拒绝命令：${raw.slice(2)}`;
}

export function deviceSeconds(data, now) {
  return data.rtcValid && data.deviceTs ? data.deviceTs + Math.floor(Math.max(0, now-data.clockAt)/1000) : 0;
}

// What a stop command means depends on the state it was tapped in, so its failure text does too.
export function stopKind(command, data, fresh) {
  if (command === 'M:0') return 'alarm';
  return !fresh || data.relay || data.feedback === 1 ? 'output' : 'local';
}
const STOP_WHAT = {
  output: { name: '关机命令', risk: '设备可能仍在运行', local: '到现场按住旋钮 10 秒' },
  alarm: { name: '取消闹钟命令', risk: '闹钟仍可能到时开机', local: '到现场按住旋钮 2 秒取消' },
};
export function stopFailureText(kind, stage) {
  const what = STOP_WHAT[kind];
  if (stage === 'write') return `${what.name}未发出。${what.risk}：请重试，或${what.local}。`;
  if (stage === 'stuck') return `${what.name}还没发出（蓝牙没有响应）。${what.risk}：请${what.local}。`;
  if (stage === 'lost') return `${what.name}未确认，蓝牙已断开。${what.risk}：请重新连接，或${what.local}。`;
  return `${what.name}未发出，蓝牙已断开。${what.risk}：请重新连接，或${what.local}。`;
}

// A matching value from before a write is not acknowledgement of that write.
export function hasCommandReadback(data, command, sentAt, now) {
  if (!statusFresh(data, now)) return false;
  const fields = command.startsWith('T:') ? ['clockAt']
    : command.startsWith('A:') ? ['statusAt','detailAt']
    : command === 'F:0' ? ['feedbackAt','detailAt'] : ['feedbackAt','detailAt'];
  return fields.every(field => Number.isFinite(data[field]) && data[field] > sentAt);
}
export function countdown(data, now) {
  const ts = deviceSeconds(data, now);
  if (!statusFresh(data, now) || !recent(data.targetAt, now) || data.mode !== 'ARMED' || !data.targetTs || !ts) return '--:--:--';
  const left = Math.max(0, data.targetTs-ts);
  return [Math.floor(left/3600),Math.floor(left/60)%60,left%60].map(v=>String(v).padStart(2,'0')).join(':');
}
export function canStart(data, now) {
  return statusFresh(data, now) && data.auth !== false && data.deviceTs > 0 && data.fault === 0 && data.rtcValid && data.settingsOk && data.feedbackFault === 0 && data.feedback === 0 && data.phase === 'I' && !data.relay && data.mode === 'IDLE';
}

export function recent(at, now) {
  return Number.isFinite(at) && now-at < 3000;
}

export function statusFresh(data, now) {
  // An RTC heartbeat must not make an old DI or fault report look current.
  return data.haveFeedback && [data.statusAt, data.detailAt, data.feedbackAt, data.clockAt].every(at => recent(at, now));
}

export function canConfigure(data, now) {
  return statusFresh(data, now) && data.auth !== false && data.mode === 'IDLE' && !data.relay && data.feedback === 0 && data.phase === 'I' && data.feedbackFault === 0 && [0,1,2,3].includes(data.fault);
}

export function canAcknowledge(data, now) {
  return statusFresh(data, now) && data.auth !== false && data.feedbackFault > 0 && !data.relay && data.feedback === 0 && data.phase === 'I';
}

// Same rule as the firmware's _compute_next_alarm: today's HH:MM:00 if not earlier than now, else tomorrow.
const SHANGHAI_DAY = 86400;
const UTC8 = 8 * 3600;
export function armPreview(data, now, hour, minute) {
  const ts = deviceSeconds(data, now);
  if (!ts) return null;
  const local = ts + UTC8;
  const dayStart = local - (local % SHANGHAI_DAY);
  const target = dayStart + hour * 3600 + minute * 60;
  return target >= local ? '今天' : '明天';
}
export function targetDay(data, now) {
  const ts = deviceSeconds(data, now);
  if (!ts || !data.targetTs) return null;
  const diff = Math.floor((data.targetTs + UTC8) / SHANGHAI_DAY) - Math.floor((ts + UTC8) / SHANGHAI_DAY);
  return diff <= 0 ? '今天' : diff === 1 ? '明天' : null;
}
