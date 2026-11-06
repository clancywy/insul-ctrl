import { FAULTS, statusFresh, recent } from './protocol.js';

// The colors follow the controller's RGB status lamp. Connection status is separate.
export const LAMPS = {
  green: { name: '绿灯', rgb: '#00ff00' },
  blue: { name: '蓝灯', rgb: '#0040ff' },
  red: { name: '红灯', rgb: '#ff0000' },
  amber: { name: '橙灯', rgb: '#ff6000' },
  pink: { name: '粉红灯', rgb: '#ff0060' },
};

export function displayState(data, now) {
  if (!statusFresh(data, now)) return {
    key: 'WAIT', title: '等待有效状态', detail: '状态未更新，暂不能开机或启用闹钟。', lamp: null,
    hint: '可发送关机；若状态没有恢复，请重新连接。',
  };
  if (data.fault > 0 || data.feedbackFault > 0) return {
    key: 'FAULT', title: '故障', lamp: 'pink',
    detail: FAULTS[data.fault || [0,5,6,7,8][data.feedbackFault]],
    hint: data.feedbackFault ? '反馈恢复后确认故障，再手动启用。' : '处理故障后，再手动启用。',
  };
  if (data.phase === 'R' || (!data.relay && data.feedback === 1)) return {
    key: 'RELEASE', title: '等待释放', detail: '关机命令已发出，等待反馈释放。', lamp: 'green',
    hint: '等待期间不能开机、启用闹钟或修改设置。',
  };
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

export function triggerTime(data, now) {
  if (!statusFresh(data, now) || data.mode !== 'ARMED' || !data.targetTs || !recent(data.targetAt, now)) return '--:--';
  return new Date(data.targetTs * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
  });
}
