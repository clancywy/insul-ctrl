import { FAULTS, statusFresh, recent } from './protocol.js';

// The colors follow the controller's RGB status lamp. Connection status is separate.
export const LAMPS = {
  green: { name: '绿灯', rgb: '#00ff00' },
  blue: { name: '蓝灯', rgb: '#0040ff' },
  red: { name: '红灯', rgb: '#ff0000' },
  amber: { name: '橙灯', rgb: '#ff6000' },
  pink: { name: '粉红灯', rgb: '#ff0060' },
};

// Mirrors Controller._redraw(): any fault -> pink, otherwise the business mode decides.
const MODE_LAMP = { IDLE: 'green', SETTING: 'amber', ARMED: 'blue', ON: 'red' };

export function displayState(data, now) {
  if (!statusFresh(data, now)) return {
    key: 'WAIT', title: '等待有效状态', detail: '状态未更新，暂不能开机或启用闹钟。', lamp: null,
    hint: '可发送关机；若状态没有恢复，请重新连接。',
  };
  // A clock fault does not stop a running output (same page as the controller: running, pink lamp).
  if (data.fault === 1 && data.feedbackFault === 0 && data.relay) {
    const confirmed = data.phase === 'O' && data.feedback === 1;
    return { key: confirmed ? 'ON' : 'PICKUP', title: confirmed ? '已开机' : '正在开机', lamp: 'pink',
      detail: '时钟异常，不影响运行；关机后校时才能启用闹钟。',
      hint: '旋钮：长按 10 秒关机；按住满 2 秒无操作。' };
  }
  if (data.fault > 0 || data.feedbackFault > 0) {
    const fault = data.fault || [0,5,6,7,8][data.feedbackFault];
    const feedback = fault >= 5;
    const ready = feedback && !data.relay && data.feedback === 0 && data.phase === 'I';
    return {
      key: 'FAULT', title: FAULTS[fault], lamp: 'pink',
      detail: feedback ? (ready ? '请检查接触器及反馈接线，再确认。' : '请检查接触器及反馈接线。')
        : fault === 1 ? '请同步设备时间。'
        : fault === 4 ? '请等待控制器重启，再重新连接。'
        : '请重新设置时间并保存。',
      hint: feedback ? (ready ? '旋钮：长按满 2 秒后松手确认；也可点击手机确认按钮。确认只清除记录、保持空闲；问题没解决，下次开机还会再报。' : '检查接触器及反馈接线，输出关闭且 DI 恢复为 0、释放完成后再确认。')
        : fault === 1 ? (data.auth !== null ? '时钟异常：旋钮长按 10 秒仍可手动开机；闹钟要先同步时间。' : '时钟异常：当前固件需先同步时间，再手动开机或启用闹钟。')
        : fault === 4 ? '等待控制器恢复；重新连接后核对状态。'
        : '重新设置时间并保存；旋钮上长按满 2 秒后松手保存。保存成功后仍需手动启用闹钟。',
    };
  }
  if (data.phase === 'R' || (!data.relay && data.feedback === 1)) {
    const unexpected = data.mode === 'ARMED' || data.mode === 'SETTING';
    return {
      key: 'RELEASE', title: '等待释放', lamp: MODE_LAMP[data.mode] ?? 'green',
      detail: unexpected ? '未发开机命令却检测到吸合反馈，1 秒内未释放将报故障。' : '输出已关闭，等待反馈释放。',
      hint: '等待期间不能开机、启用闹钟或修改设置。',
    };
  }
  if (data.relay) {
    const confirmed = data.phase === 'O' && data.feedback === 1;
    return { key: confirmed ? 'ON' : 'PICKUP', title: confirmed ? '已开机' : '正在开机',
      detail: confirmed ? '开机反馈已确认。' : '开机命令已发出，等待反馈确认。', lamp: 'red',
      hint: '旋钮：长按 10 秒关机；按住满 2 秒无操作。' };
  }
  if (data.phase !== 'I' || data.feedback !== 0 || data.mode === 'ON') return {
    key: 'WAIT', title: '等待状态确认', detail: '正在接收设备状态，暂不能开机。', lamp: null,
    hint: '可发送关机；若状态没有恢复，请重新连接。',
  };
  if (data.mode === 'ARMED') return {
    key: 'ARMED', title: '闹钟', detail: '已关机，等待到时自动开机。', lamp: 'blue',
    hint: '旋钮：长按满 2 秒后松手，取消闹钟并回到空闲。',
  };
  if (data.mode === 'SETTING') return {
    key: 'SETTING', title: '设置', detail: '已关机，正在使用控制器旋钮设置时间。', lamp: 'amber',
    hint: '旋钮：短按切换时／分，旋转调时，长按满 2 秒后松手保存。',
  };
  return { key: 'IDLE', title: '空闲', detail: '已关机，闹钟未启用。', lamp: 'green',
    hint: '旋钮：短按设置；长按 2 秒后松手启用闹钟；长按 10 秒开机。' };
}

// Unknown must stay unknown: a stale frame cannot say the alarm was cancelled.
export function alarmStatus(data, now) {
  if (!statusFresh(data, now)) return { text: '待确认', armed: false, known: false };
  return data.mode === 'ARMED' ? { text: '已启用', armed: true, known: true } : { text: '未启用', armed: false, known: true };
}

export function triggerTime(data, now) {
  if (!statusFresh(data, now) || data.mode !== 'ARMED' || !data.targetTs || !recent(data.targetAt, now)) return '--:--';
  return new Date(data.targetTs * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
  });
}
