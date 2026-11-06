import { useState, useEffect, useRef } from 'react';
import { Bluetooth, Clock, Settings, Power, ShieldCheck, RefreshCw, CheckCircle, AlertTriangle, Timer, XCircle } from 'lucide-react';
import { initialDevice, parseFrame, errorMessage, deviceSeconds, countdown, canStart, statusFresh, canConfigure, canAcknowledge } from './protocol.js';
import { CommandQueue } from './commandQueue.js';
import { displayState, triggerTime, LAMPS } from './presentation.js';

const SERVICE_UUID = '0000aaaa-0000-1000-8000-00805f9b34fb';
const CHAR_UUID_CMD = '0000bbbb-0000-1000-8000-00805f9b34fb';
const formatTime = ts => ts ? new Date(ts*1000).toLocaleTimeString('en-GB', { hour12:false, timeZone:'Asia/Shanghai' }) : '--:--:--';
const formatShortTime = (h,m) => `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;

export default function InsulCtrlApp() {
  const [connState,setConnState]=useState('disconnected');
  const [deviceData,setDeviceData]=useState(initialDevice);
  const [logs,setLogs]=useState([]);
  const [pendingAlarmH,setPendingAlarmH]=useState(7);
  const [pendingAlarmM,setPendingAlarmM]=useState(30);
  const [toast,setToast]=useState({show:false,msg:'',type:'success'});
  const [now,setNow]=useState(()=>performance.now());
  const isBluetoothSupported=Boolean(navigator.bluetooth);
  const APP_VERSION='v4.1.0';
  const connection=useRef(null);
  const toastTimer=useRef(null);
  useEffect(()=>{
    const timer=setInterval(()=>setNow(performance.now()),250);
    return ()=>{
      clearInterval(timer); clearTimeout(toastTimer.current);
      const c=connection.current;
      if(c) { c.queue?.close(); c.char?.removeEventListener('characteristicvaluechanged',c.notify); c.device.removeEventListener('gattserverdisconnected',c.disconnected); c.device.gatt.disconnect(); }
    };
  },[]);
  const showToast=(msg,type='success')=>{
    clearTimeout(toastTimer.current);
    setToast({show:true,msg,type});
    toastTimer.current=setTimeout(()=>setToast(p=>({...p,show:false})),3500);
  };
  const addLog=msg=>setLogs(p=>[...p.slice(-29),msg]);
  const onDisconnected=()=>{
    const c=connection.current;
    if(c) {
      c.queue?.close(); c.char?.removeEventListener('characteristicvaluechanged',c.notify);
      c.device.removeEventListener('gattserverdisconnected',c.disconnected);
      c.device.gatt.disconnect();
    }
    connection.current=null;
    setConnState('disconnected'); setDeviceData(initialDevice());
    addLog('设备已断开');
  };
  const connectBLE=async()=>{
    let c;
    try {
      setConnState('connecting'); setDeviceData(initialDevice());
      const device=await navigator.bluetooth.requestDevice({filters:[{namePrefix:'InsulCtrl'}],optionalServices:[SERVICE_UUID]});
      c={device}; connection.current=c;
      c.disconnected=()=>{ if(connection.current===c) onDisconnected(); };
      device.addEventListener('gattserverdisconnected',c.disconnected);
      const server=await device.gatt.connect();
      const service=await server.getPrimaryService(SERVICE_UUID);
      c.char=await service.getCharacteristic(CHAR_UUID_CMD);
      let firstStatus=true;
      c.notify=event=>{
        if(connection.current!==c) return;
        const raw=new TextDecoder().decode(event.target.value).trim();
        const error=errorMessage(raw);
        if(error) { showToast(error,'error'); addLog(error); return; }
        const patch=parseFrame(raw,performance.now());
        if(!patch) return;
        setDeviceData(p=>({...p,...patch}));
        if(firstStatus && raw.startsWith('S:')) {
          firstStatus=false; setPendingAlarmH(patch.alarmH); setPendingAlarmM(patch.alarmM);
        }
      };
      c.char.addEventListener('characteristicvaluechanged',c.notify);
      await c.char.startNotifications();
      if(connection.current!==c) throw new Error('连接已断开');
      c.queue=new CommandQueue(command=>c.char.writeValue(new TextEncoder().encode(command)));
      setConnState('connected');
      await c.queue.send('Q');
      addLog('已连接，已请求设备状态');
    } catch(error) {
      if(!c || connection.current===c) onDisconnected();
      showToast(`连接失败：${error.message}`,'error');
    }
  };
  const sendCommand=async command=>{
    const c=connection.current;
    if(!c?.queue) return;
    try { await c.queue.send(command); addLog(`已发送 ${command}`); }
    catch(error) { showToast(error.message,'error'); addLog(error.message); }
  };
  const fresh=statusFresh(deviceData,now);
  const display=displayState(deviceData,now);
  const lamp=LAMPS[display.lamp];
  const configureAllowed=canConfigure(deviceData,now);
  const startAllowed=canStart(deviceData,now);
  const handleSyncTime=()=>sendCommand(`T:${Math.floor(Date.now()/1000)}`);
  const handleSetAlarm=()=>sendCommand(`A:${formatShortTime(pendingAlarmH,pendingAlarmM)}`);
  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-8 relative">
      {toast.show && <div role="status" className={`fixed top-3 left-4 right-4 mx-auto max-w-md z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-slate-800 text-white'}`}>
        {toast.msg}
      </div>}
      <header className="bg-white shadow-sm sticky top-0 z-20">
        <div className="max-w-md mx-auto px-4 h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Settings className="w-5 h-5 text-blue-600 shrink-0" />
            <h1 className="font-bold text-lg whitespace-nowrap">装备控制器</h1>
            <span className="text-xs text-slate-500 font-mono">{APP_VERSION}</span>
          </div>
          <span className="text-xs text-slate-600 whitespace-nowrap" aria-label="蓝牙连接状态">
            {connState === 'connected' ? (fresh ? '蓝牙在线' : '等待状态') : connState === 'connecting' ? '连接中' : '未连接'}
          </span>
        </div>
      </header>
      <main className="max-w-md mx-auto p-4 space-y-4">
        {connState === 'disconnected' && (
          <section className="bg-white rounded-3xl p-6 shadow-sm text-center space-y-6 mt-6">
            <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto">
              <Bluetooth className="w-10 h-10 text-blue-600" />
            </div>
            <div>
              <h2 className="text-2xl font-bold">连接控制器</h2>
              <p className="text-slate-600 mt-2">查看开关机反馈，设置定时开机。</p>
            </div>
            {!isBluetoothSupported && <div role="alert" className="bg-amber-50 rounded-xl p-4 text-left text-sm text-amber-900 space-y-2">
              <p className="font-bold">当前浏览器无法连接蓝牙</p>
              <p>iPhone 请用 Bluefy，安卓请用 Chrome，并通过 HTTPS 打开此页面。</p>
            </div>}
            <button onClick={connectBLE} disabled={!isBluetoothSupported} className="w-full font-bold py-4 rounded-xl bg-blue-600 text-white disabled:bg-slate-300 disabled:text-slate-600 active:scale-[.98]">
              扫描蓝牙设备
            </button>
            <p className="text-sm text-slate-500">请开启手机蓝牙，并靠近控制器。</p>
          </section>
        )}
        {connState === 'connecting' && <div role="status" className="bg-white rounded-2xl p-6 text-center">正在连接设备…</div>}
        {connState === 'connected' && <>
          <section aria-label="设备状态" className="bg-white rounded-3xl p-5 shadow-sm space-y-4">
            <div className="flex justify-between items-start gap-3">
              <div>
                <div className="text-sm text-slate-500 mb-1">设备状态</div>
                <h2 data-testid="state-title" className="text-3xl font-bold tracking-tight">{display.title}</h2>
              </div>
              {lamp ? <div aria-label={`状态灯：${lamp.name}`} className="flex items-center gap-2 rounded-full bg-slate-50 px-3 py-2 text-sm whitespace-nowrap">
                <span data-testid="status-lamp" className="w-3.5 h-3.5 rounded-full border border-black/10" style={{backgroundColor:lamp.rgb}} />
                {lamp.name}
              </div> : <span className="text-sm text-slate-500 pt-2">状态待确认</span>}
            </div>
            <p className={display.key === 'FAULT' ? 'text-pink-700 font-medium' : 'text-slate-600'} role={display.key === 'FAULT' ? 'alert' : undefined}>{display.detail}</p>
            {display.key === 'FAULT' && <p className="text-sm text-slate-600">{deviceData.relay ? '输出尚未确认关闭，请关机。' : '控制器输出已关闭；接触器状态以反馈为准。'}</p>}
            <div className="pt-3 border-t border-slate-100">
              <div className="text-sm text-slate-500">当前时间</div>
              <div data-testid="device-clock" className="text-[clamp(2.25rem,11vw,3rem)] leading-tight font-mono font-bold tabular-nums mt-1">
                {formatTime(fresh ? deviceSeconds(deviceData,now) : 0)}
              </div>
            </div>
          </section>

          <section aria-label="控制操作" className="space-y-3">
            {display.key === 'IDLE' && <div className="grid grid-cols-2 gap-3">
              <button onClick={()=>sendCommand('R:1')} disabled={!startAllowed} className="flex items-center justify-center gap-2 rounded-2xl bg-red-600 text-white font-bold py-4 disabled:opacity-40 active:scale-[.98]">
                <Power className="w-5 h-5" />开机
              </button>
              <button onClick={()=>sendCommand('M:1')} disabled={!startAllowed} className="flex items-center justify-center gap-2 rounded-2xl bg-blue-600 text-white font-bold py-4 disabled:opacity-40 active:scale-[.98]">
                <ShieldCheck className="w-5 h-5" />启用闹钟
              </button>
            </div>}
            {display.key === 'ARMED' && <button onClick={()=>sendCommand('M:0')} className="w-full rounded-2xl bg-blue-600 text-white font-bold py-4 active:scale-[.98]">取消闹钟</button>}
            {['ON','PICKUP','RELEASE','FAULT','WAIT'].includes(display.key) && <button onClick={()=>sendCommand('R:0')} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-red-600 text-white font-bold py-4 active:scale-[.98]">
              <Power className="w-5 h-5" />关机
            </button>}
            {display.key === 'SETTING' && <p className="text-sm text-amber-800 bg-amber-50 rounded-xl p-3">请先在控制器上保存设置，再使用手机操作。</p>}
            {display.key === 'FAULT' && deviceData.feedbackFault > 0 && <button onClick={()=>sendCommand('F:0')} disabled={!canAcknowledge(deviceData,now)} className="w-full rounded-xl border border-pink-300 bg-pink-50 text-pink-800 font-bold py-3 disabled:opacity-40">确认故障已恢复</button>}
            <p className="text-sm text-slate-500 text-center">手机按钮点击即执行，关机同时取消闹钟。</p>
          </section>

          <section aria-label="闹钟时间" className="bg-white rounded-3xl p-5 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold flex items-center gap-2"><Timer className="w-5 h-5 text-blue-600" />{display.key === 'ARMED' ? '触发时间' : '闹钟时间'}</h2>
              <span className="text-sm text-slate-500">{display.key === 'ARMED' ? '已启用' : '未启用'}</span>
            </div>
            <div data-testid="alarm-time" className="text-[clamp(2.25rem,11vw,3rem)] leading-tight font-mono font-bold tabular-nums mt-3">
              {fresh ? (display.key === 'ARMED' ? triggerTime(deviceData,now) : formatShortTime(deviceData.alarmH,deviceData.alarmM)) : '--:--'}
            </div>
            {display.key === 'ARMED' ? <p className="text-sm text-blue-700 mt-2">距开机 <span className="font-mono tabular-nums">{countdown(deviceData,now)}</span></p> : <p className="text-sm text-slate-500 mt-2">保存的时间会保留，重新上电后需手动启用闹钟。</p>}
          </section>

          <section aria-label="设置" className="bg-white rounded-3xl p-5 shadow-sm space-y-5">
            <h2 className="font-semibold text-base">设置</h2>
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="text-sm text-slate-600">闹钟时间</span>
                <span className="text-sm text-slate-500">设备已保存 {fresh ? formatShortTime(deviceData.alarmH,deviceData.alarmM) : '--:--'}</span>
              </div>
              <div className="flex items-center gap-2">
                <select aria-label="小时" value={pendingAlarmH} onChange={e=>setPendingAlarmH(e.target.value)} disabled={!configureAllowed} className="min-w-0 flex-1 rounded-xl bg-slate-100 p-3 text-xl font-mono font-bold disabled:opacity-50">
                  {[...Array(24).keys()].map(h=><option key={h} value={h}>{String(h).padStart(2,'0')}</option>)}
                </select>
                <span className="font-bold">:</span>
                <select aria-label="分钟" value={pendingAlarmM} onChange={e=>setPendingAlarmM(e.target.value)} disabled={!configureAllowed} className="min-w-0 flex-1 rounded-xl bg-slate-100 p-3 text-xl font-mono font-bold disabled:opacity-50">
                  {[...Array(60).keys()].map(m=><option key={m} value={m}>{String(m).padStart(2,'0')}</option>)}
                </select>
                <button onClick={handleSetAlarm} disabled={!configureAllowed} className="rounded-xl bg-slate-800 text-white px-4 py-3 font-semibold disabled:opacity-40">保存</button>
              </div>
              {!configureAllowed && <p className="text-sm text-slate-500 mt-2">回到空闲并确认反馈正常后，可修改设置。</p>}
            </div>
            <div className="border-t border-slate-100 pt-4 flex items-center justify-between gap-2">
              <div className="text-sm text-slate-600 flex items-center gap-2"><Clock className="w-4 h-4 shrink-0" />设备时钟 · UTC+8</div>
              <button onClick={handleSyncTime} disabled={!configureAllowed} className="flex items-center gap-1.5 rounded-xl bg-blue-50 text-blue-700 px-3 py-3 text-sm font-semibold disabled:opacity-40"><RefreshCw className="w-4 h-4" />同步时间</button>
            </div>
          </section>

          <details className="bg-white rounded-2xl p-4 text-sm text-slate-600">
            <summary className="cursor-pointer font-medium">控制器旋钮操作</summary>
            <p className="mt-3 leading-relaxed" data-testid="knob-hint">{display.hint}</p>
          </details>
          <details className="bg-white rounded-2xl p-4 text-sm text-slate-600">
            <summary className="cursor-pointer font-medium">设备回读与连接记录</summary>
            <dl className="grid grid-cols-2 gap-2 mt-3">
              <dt>控制输出</dt><dd>{fresh ? (deviceData.relay ? '开启' : '关闭') : '待确认'}</dd>
              <dt>DI 反馈</dt><dd>{fresh && deviceData.feedback >= 0 ? deviceData.feedback : '待确认'}</dd>
            </dl>
            <div className="mt-3 bg-slate-50 rounded-lg p-3 max-h-32 overflow-y-auto break-words text-xs font-mono">{logs.map((line,i)=><div key={i}>{line}</div>)}</div>
          </details>
          <button onClick={onDisconnected} className="w-full py-3 text-slate-600 text-sm font-medium flex items-center justify-center gap-2"><XCircle className="w-4 h-4" />断开蓝牙连接</button>
        </>}
      </main>
    </div>
  );
}
