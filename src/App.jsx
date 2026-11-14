import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Bluetooth, MoreHorizontal, Power, ShieldCheck, RefreshCw, AlertTriangle, Loader2, X, Check } from 'lucide-react';
import { initialDevice, parseFrame, errorMessage, deviceSeconds, countdown, canStart, statusFresh, canConfigure, canAcknowledge, armPreview, targetDay, hasCommandReadback, stopKind, stopFailureText, diagnosticText } from './protocol.js';
import { CommandQueue } from './commandQueue.js';
import { displayState, triggerTime, alarmStatus, LAMPS } from './presentation.js';
import HoldActionButton from './HoldActionButton.jsx';

const SERVICE_UUID = '0000aaaa-0000-1000-8000-00805f9b34fb';
const CHAR_UUID_CMD = '0000bbbb-0000-1000-8000-00805f9b34fb';
const APP_VERSION = 'v4.2.1';
const TAP_GUARD_MS = 400;      // a double tap must not land on the button that replaces the first one
const START_LOCK_MS = 5000;    // same as the controller's restart interval
const TAP_LOCK_MS = 2000;      // after cancelling without an output-off: only guards against a repeated tap
const PIN_STORE_PREFIX = 'insulctrl.pin.';
const CONFIRM_TIMEOUT_MS = 3000;
const CONNECT_TIMEOUT_MS = 15000;
const BAND = { green: 'bg-green-700', blue: 'bg-blue-700', red: 'bg-red-700', amber: 'bg-orange-700', pink: 'bg-pink-700', none: 'bg-slate-600' };
const BAND_HEX = { green: '#15803d', blue: '#1d4ed8', red: '#b91c1c', amber: '#c2410c', pink: '#be185d', none: '#475569' };
const formatTime = ts => ts ? new Date(ts*1000).toLocaleTimeString('en-GB', { hour12:false, timeZone:'Asia/Shanghai' }) : '--:--:--';
const pad = v => String(v).padStart(2,'0');
const formatShortTime = (h,m) => `${pad(h)}:${pad(m)}`;
const HOURS = [...Array(24).keys()];
const MINUTES = [...Array(60).keys()];
const sameDevice = (a,b) => Boolean(a && b && (a===b || (a.id && a.id===b.id)));

function formatDrift(drift) {
  const size = Math.abs(drift);
  const dir = drift > 0 ? '快' : '慢';
  if (size >= 3600) return `比手机${dir} ${(size/3600).toFixed(1)} 小时`;
  if (size >= 60) return `比手机${dir} ${Math.round(size/60)} 分钟`;
  return `比手机${dir} ${size} 秒`;
}

function storedPin(device) {
  try { return localStorage.getItem(PIN_STORE_PREFIX+(device.id ?? device.name)); } catch { return null; }
}
function storePin(device,pin) {
  try {
    if(pin) localStorage.setItem(PIN_STORE_PREFIX+(device.id ?? device.name),pin);
    else localStorage.removeItem(PIN_STORE_PREFIX+(device.id ?? device.name));
  } catch { /* the phone keeps asking; nothing else depends on it */ }
}

const actionBase = 'action-button flex items-center justify-center gap-2 rounded-xl px-3 text-lg font-bold active:scale-[.98] disabled:opacity-40';
const STOP_BUTTON = `${actionBase} w-full bg-green-700 text-white`;

export default function InsulCtrlApp() {
  const [connState,setConnState]=useState('disconnected');
  const [deviceData,setDeviceData]=useState(initialDevice);
  const [logs,setLogs]=useState([]);
  const [draft,setDraft]=useState(null);
  const [toast,setToast]=useState({show:false,msg:'',type:'success'});
  const [now,setNow]=useState(()=>performance.now());
  const [sheet,setSheet]=useState(false);
  const [sendFailure,setSendFailure]=useState(null);
  const [pending,setPending]=useState(null);
  const [startLock,setStartLock]=useState({until:0,text:''});
  const [pinInput,setPinInput]=useState('');
  const [lastKnown,setLastKnown]=useState(null);
  const isBluetoothSupported=Boolean(navigator.bluetooth);
  const connection=useRef(null);
  const attempt=useRef(null);
  const lastDevice=useRef(null);
  const toastTimer=useRef(null);
  const guardUntil=useRef(0);
  const failCount=useRef(0);
  const previousOutput=useRef({value:null,at:null});
  const unresolvedStop=useRef(null);
  const pendingRef=useRef(null);
  const stuckWarned=useRef(null);

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

  const onDisconnected=(quiet=false,preserveFailure=false)=>{
    const c=connection.current;
    if(c) {
      c.queue?.close(); c.char?.removeEventListener('characteristicvaluechanged',c.notify);
      c.device.removeEventListener('gattserverdisconnected',c.disconnected);
      c.device.gatt.disconnect();
      const inFlight=pendingRef.current;
      if(inFlight?.stopKind && inFlight.stopKind!=='local' && !unresolvedStop.current)
        unresolvedStop.current={device:c.device,command:inFlight.command,expect:inFlight.expect,stopping:true,at:inFlight.at,kind:inFlight.stopKind,text:stopFailureText(inFlight.stopKind,'lost')};
    }
    connection.current=null;
    attempt.current=null;
    pendingRef.current=null;
    setConnState('disconnected'); setDeviceData(initialDevice());
    setSendFailure(f=>unresolvedStop.current ?? (preserveFailure ? f : null));
    setPending(null); setDraft(null); setSheet(false);
    failCount.current=0;
    previousOutput.current={value:null,at:null};
    if(!quiet) addLog('设备已断开');
  };

  const connectBLE=async(reuse=false,targetDevice=null)=>{
    const token={};
    attempt.current=token;
    let c;
    let timeout;
    const retireAttempt=()=>{
      const active=connection.current?.device;
      if(c && active!==c.device && (!c.device.id || active?.id!==c.device.id)) c.device.gatt.disconnect();
    };
    try {
      setConnState('connecting'); setDeviceData(initialDevice());
      const device=targetDevice ?? (reuse && lastDevice.current ? lastDevice.current
        : await navigator.bluetooth.requestDevice({filters:[{namePrefix:'InsulCtrl'}],optionalServices:[SERVICE_UUID]}));
      if(attempt.current!==token) return;
      // The system chooser has no time limit of its own: the user may take as long as they need.
      timeout=setTimeout(()=>{ if(attempt.current===token) { onDisconnected(true,Boolean(sendFailure?.stopping)); showToast('连接超时，请靠近控制器后重试','error'); } },CONNECT_TIMEOUT_MS);
      lastDevice.current=device;
      c={device}; connection.current=c;
      c.disconnected=()=>{ if(connection.current===c) onDisconnected(); };
      device.addEventListener('gattserverdisconnected',c.disconnected);
      const server=await device.gatt.connect();
      if(connection.current!==c || attempt.current!==token) {
        retireAttempt();
        return;
      }
      const service=await server.getPrimaryService(SERVICE_UUID);
      if(connection.current!==c || attempt.current!==token) { retireAttempt(); return; }
      c.char=await service.getCharacteristic(CHAR_UUID_CMD);
      if(connection.current!==c || attempt.current!==token) { retireAttempt(); return; }
      c.queue=new CommandQueue(command=>c.char.writeValue(new TextEncoder().encode(command)));
      c.notify=event=>{
        if(connection.current!==c) return;
        const raw=new TextDecoder().decode(event.target.value).trim();
        const error=errorMessage(raw);
        if(error) {
          setPending(null);
          if(raw==='E:PIN') { storePin(c.device,null); c.typedPin=null; setPinInput(''); }
          showToast(error,'error'); addLog(`${error}（${raw}）`); return;
        }
        const patch=parseFrame(raw,performance.now());
        if(!patch) return;
        setDeviceData(p=>({...p,...patch}));
        if(patch.auth===true && c.typedPin) { storePin(c.device,c.typedPin); c.typedPin=null; setPinInput(''); }
        if(patch.auth===false && !c.pinTried) {
          c.pinTried=true;
          const saved=storedPin(c.device);
          if(saved) c.queue?.send(`P:${saved}`).catch(()=>{});
        }
      };
      c.char.addEventListener('characteristicvaluechanged',c.notify);
      await c.char.startNotifications();
      if(connection.current!==c || attempt.current!==token) throw new Error('连接已断开');
      setConnState('connected');
      await c.queue.send('Q');
      addLog('已连接，已请求设备状态');
    } catch(error) {
      if(attempt.current!==token) { retireAttempt(); return; } // the user already cancelled this attempt
      if(!c || connection.current===c) onDisconnected(true,Boolean(sendFailure?.stopping));
      // Closing the system device chooser is a choice, not a failure.
      if(error?.name!=='NotFoundError') showToast(`连接失败：${error.message}`,'error');
    } finally {
      clearTimeout(timeout);
    }
  };

  const fresh=statusFresh(deviceData,now);
  const display=displayState(deviceData,now);
  const lamp=LAMPS[display.lamp];
  const configureAllowed=canConfigure(deviceData,now);
  const startAllowed=canStart(deviceData,now);
  const ackAllowed=canAcknowledge(deviceData,now);
  const alarm=alarmStatus(deviceData,now);
  const saved={h:deviceData.alarmH,m:deviceData.alarmM};
  const shownTime=configureAllowed && draft ? draft : saved;
  const dirty=configureAllowed && draft!==null && (draft.h!==saved.h || draft.m!==saved.m);
  const startLockLeft=Math.max(0,Math.ceil((startLock.until-now)/1000));
  const needPin=fresh && deviceData.auth===false;
  const deviceClock=deviceSeconds(deviceData,now);
  const drift=fresh && deviceClock ? deviceClock-Math.floor(Date.now()/1000) : 0;
  const bandKey=display.lamp ?? 'none';

  useEffect(()=>{
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',connState==='connected'?BAND_HEX[bandKey]:'#ffffff');
  },[bandKey,connState]);

  // Follow a new feedback report, including a stop caused by a fault or the knob.
  // RELEASE -> IDLE must not restart the five-second interval a second time.
  useLayoutEffect(()=>{
    if(!fresh || connState!=='connected' || previousOutput.current.at===deviceData.feedbackAt) return;
    const previous=previousOutput.current.value;
    previousOutput.current={value:deviceData.relay,at:deviceData.feedbackAt};
    if(previous===true && !deviceData.relay)
      setStartLock({until:performance.now()+START_LOCK_MS,text:'刚关机，5 秒内不能再开机。'});
  },[fresh,connState,deviceData.relay,deviceData.feedbackAt]);

  useEffect(()=>{
    if(fresh && connState==='connected') setLastKnown({key:display.key,title:display.title,relay:deviceData.relay,mode:deviceData.mode,trigger:triggerTime(deviceData,now),at:formatTime(deviceClock)});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshed by the once-a-second device clock
  },[fresh,connState,display.key,deviceData.mode,deviceClock]);

  useEffect(()=>{
    if(draft && !dirty && configureAllowed) setDraft(null);
  },[draft,dirty,configureAllowed]);

  useEffect(()=>{
    if(sendFailure?.command==='R:1' && !startAllowed) setSendFailure(null);
  },[sendFailure,startAllowed]);

  useEffect(()=>{
    const failed=unresolvedStop.current;
    const active=connection.current?.device;
    // A failed alarm cancel is settled once the device is no longer armed: cancelled, or the alarm already fired.
    const settled=failed?.kind==='alarm' ? deviceData.mode!=='ARMED' : !deviceData.relay && deviceData.mode==='IDLE';
    if(failed && sameDevice(failed.device,active) && hasCommandReadback(deviceData,failed.command,failed.at,now) && settled) {
      unresolvedStop.current=null;
      if(pendingRef.current?.command===failed.command) pendingRef.current=null;
      setSendFailure(f=>f?.stopping ? null : f);
    }
  },[deviceData,now]);

  // The UI spinner may time out, but an unconfirmed stop must survive until a
  // new readback confirms it or disconnection turns it into a persistent warning.
  useEffect(()=>{
    const request=pendingRef.current;
    if(request?.sentAt!=null && hasCommandReadback(deviceData,request.command,request.sentAt,now) && request.done(deviceData,now)) {
      pendingRef.current=null;
      setSendFailure(f=>f?.soft && f.command===request.command ? null : f);
    }
  },[deviceData,now]);

  useEffect(()=>{
    if(!pending) return;
    // A readback can only confirm a command that has actually left the phone.
    if(pending.sentAt!==null && hasCommandReadback(deviceData,pending.command,pending.sentAt,now) && pending.done(deviceData,now)) {
      if(pending.ok) showToast(pending.ok);
      failCount.current=0;
      setSendFailure(f=>f?.soft ? null : f);
      setPending(null);
    } else if(pending.sentAt===null && now-pending.at>CONFIRM_TIMEOUT_MS) {
      // Still inside the GATT write: say so instead of spinning silently.
      if(stuckWarned.current===pending) return;
      stuckWarned.current=pending;
      addLog(`${pending.command} 还没发出`);
      if(pending.stopKind && pending.stopKind!=='local') {
        if(!unresolvedStop.current) unresolvedStop.current={device:connection.current?.device,command:pending.command,expect:pending.expect,stopping:true,at:pending.at,kind:pending.stopKind,text:stopFailureText(pending.stopKind,'stuck')};
        setSendFailure(unresolvedStop.current);
      } else if(!unresolvedStop.current) setSendFailure({soft:true,command:pending.command,text:`${pending.label}还没发出（蓝牙没有响应），请看上方状态。`});
    } else if(pending.sentAt!==null && now-pending.sentAt>CONFIRM_TIMEOUT_MS) {
      if(!unresolvedStop.current) setSendFailure({soft:true,command:pending.command,text:`${pending.label}已发送，但 ${CONFIRM_TIMEOUT_MS/1000} 秒内未收到设备确认，请看上方状态。`});
      addLog(`${pending.command} 未收到确认`);
      setPending(null);
    }
  },[deviceData,now,pending]);

  const sendCommand=async(command,expect)=>{
    const c=connection.current;
    if(!c?.queue) return;
    const stopping=command==='R:0' || command==='M:0';
    const kind=stopping ? stopKind(command,deviceData,fresh) : null;
    if(stopping) setStartLock(deviceData.relay || deviceData.feedback===1
      ? {until:performance.now()+START_LOCK_MS,text:'刚关机，5 秒内不能再开机。'}
      : {until:performance.now()+TAP_LOCK_MS,text:'短暂锁定，防止连点。'});
    if(!unresolvedStop.current) setSendFailure(null);
    const request=expect ? {...expect,expect,command,at:performance.now(),sentAt:null,stopKind:kind} : null;
    if(request) { pendingRef.current=request; setPending(request); }
    try {
      const written=await c.queue.send(command,command.startsWith('T:')
        ? ()=>`T:${Math.floor(Date.now()/1000)}` : undefined);
      if(connection.current!==c) return;
      const sent=request ? {...request,command:written,sentAt:performance.now()} : null;
      if(pendingRef.current===request) pendingRef.current=sent;
      setPending(p=>p===request ? sent : p);
      addLog(`已发送 ${written}`); failCount.current=0;
    }
    catch(error) {
      if(connection.current!==c) return;
      setPending(p=>p===request ? null : p);
      if(error.canceled) { addLog(`${command}：${error.message}`); return; }
      failCount.current+=1;
      addLog(`${command} 发送失败：${error.message}`);
      const guarded=stopping && kind!=='local';
      if(pendingRef.current===request) pendingRef.current=null;
      if(guarded && !unresolvedStop.current) unresolvedStop.current={device:c.device,command,expect,stopping:true,at:performance.now(),kind,text:stopFailureText(kind,'write')};
      if(!c.device.gatt.connected || failCount.current>=2) {
        onDisconnected(true,guarded);
        if(guarded) {
          unresolvedStop.current={...unresolvedStop.current,text:stopFailureText(unresolvedStop.current.kind ?? kind,'gone')};
          setSendFailure(unresolvedStop.current);
        }
        showToast(guarded?stopFailureText(kind,'gone'):'蓝牙已断开，命令未发出。','error');
        return;
      }
      setSendFailure(unresolvedStop.current ?? {device:c.device,command,expect,stopping,text:`${expect?.label ?? '命令'}未发出（蓝牙写入失败）。${command==='R:1'?'请在下方按住开机按钮2秒重试。':''}`});
    }
  };
  const submitPin=event=>{
    event.preventDefault();
    const c=connection.current;
    if(!c?.queue || pinInput.length!==6) return;
    c.typedPin=pinInput;
    c.queue.send(`P:${pinInput}`).catch(error=>showToast(error.message,'error'));   // never logged
  };
  // One entry point for the action bar so a double tap cannot reach the replacement button.
  const act=(command,expect)=>{
    const t=performance.now();
    // Only R:0 may never be dropped. 取消闹钟 appears where 启用闹钟 was, so a double tap must not cancel what it just armed.
    if(command!=='R:0' && t<guardUntil.current) return;
    guardUntil.current=t+TAP_GUARD_MS;
    sendCommand(command,expect);
  };
  const stopOff=d=>!d.relay && d.mode==='IDLE';
  const doStop=()=>act('R:0',{label:display.key==='SETTING' ? '取消设置命令' : '关机命令',done:stopOff});
  const doStart=()=>{
    if(!canStart(deviceData,performance.now()) || performance.now()<startLock.until) return;
    act('R:1',{label:'开机命令',done:d=>d.relay || d.fault>0 || d.feedbackFault>0});
  };
  const doArm=()=>act('M:1',{label:'启用闹钟命令',done:d=>d.mode==='ARMED' || d.fault>0 || d.feedbackFault>0});
  const doDisarm=()=>act('M:0',{label:'取消闹钟命令',done:d=>d.mode!=='ARMED'});
  const doAck=()=>act('F:0',{label:'确认故障命令',done:d=>d.feedbackFault===0,ok:'故障已确认，需手动重新启用'});
  const doSave=()=>{
    const target=shownTime;
    act(`A:${formatShortTime(target.h,target.m)}`,{label:'保存命令',done:d=>d.alarmH===target.h && d.alarmM===target.m && d.settingsOk,ok:`闹钟时间已保存 ${formatShortTime(target.h,target.m)}`});
  };
  const doSync=()=>{
    const ts=Math.floor(Date.now()/1000);
    act(`T:${ts}`,{label:'同步时间命令',done:(d,t)=>Math.abs(deviceSeconds(d,t)-Math.floor(Date.now()/1000))<=2,ok:'设备时间已同步'});
  };
  const retryPermitted=(command,t)=>command==='R:0'
    || (command==='M:0' && statusFresh(deviceData,t) && deviceData.mode==='ARMED')
    || ((command?.startsWith('A:') || command?.startsWith('T:')) && canConfigure(deviceData,t))
    || (command==='M:1' && canStart(deviceData,t) && t>=startLock.until && !dirty)
    || (command==='F:0' && canAcknowledge(deviceData,t));
  const retryFailure=()=>{
    const failure=sendFailure;
    if(!failure || !sameDevice(failure.device,connection.current?.device)
      || !retryPermitted(failure.command,performance.now())) return;
    if(failure.command.startsWith('T:')) doSync();
    else act(failure.command,failure.expect);
  };
  const reconnectFailure=()=>{
    const target=sendFailure?.device;
    if(!target) return;
    onDisconnected(true,true);
    connectBLE(false,target);
  };
  const failureOnCurrentDevice=sameDevice(sendFailure?.device,connection.current?.device);
  const sending=command=>pending?.command===command || (command==='T' && pending?.command?.startsWith('T:')) || (command==='A' && pending?.command?.startsWith('A:'));

  const fbFault=display.key==='FAULT' && deviceData.feedbackFault>0;
  const settingsFault=display.key==='FAULT' && [2,3].includes(deviceData.fault);
  const rtcFault=display.key==='FAULT' && deviceData.fault===1;
  const localEditing=fresh && deviceData.mode==='SETTING';

  const stopFault=display.key==='FAULT' && deviceData.relay;
  const immediateStop=display.key==='WAIT' || display.key==='FAULT' || deviceData.fault>0 || deviceData.feedbackFault>0;
  // A hold belongs to this device/state only; it must not survive a new action bar or overlay.
  const holdContext=`${connState}:${display.key}:${deviceData.mode}:${deviceData.fault}:${deviceData.feedbackFault}:${needPin}:${sheet}`;
  const actionStatus=command=>sending(command) ? (pending.sentAt===null ? '正在发送' : '等待设备回读') : '';
  const ackReason=deviceData.feedback===1 ? '反馈 DI 仍为 1，释放后才能确认。' : deviceData.feedback<0 ? '反馈 DI 未知，请检查反馈。' : ackAllowed ? '确认只清除故障，不会开机。' : '等待输出关闭与反馈释放。';

  const toastView=toast.show && <div role="status" className={`app-toast rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-slate-800 text-white'}`}>
    {toast.msg}
  </div>;

  return (
    <div className={`app-shell font-sans text-slate-800 ${connState === 'connected' ? 'is-connected' : ''}`}>
      {connState !== 'connected' && toastView}

      {connState !== 'connected' && <>
        <header className="flex h-11 shrink-0 items-center justify-between bg-white px-4 shadow-sm">
          <h1 className="text-base font-bold">装备控制器</h1>
          <span className="text-xs text-slate-600" aria-label="蓝牙连接状态">{connState === 'connecting' ? '连接中' : '未连接'}</span>
        </header>
        <main className="flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-y-auto bg-slate-100 p-4">
          {sendFailure?.stopping && <div role="alert" className="app-banner rounded-xl bg-red-600 p-3 text-sm font-medium text-white">
            <p>{sendFailure.text}</p>
            {connState==='disconnected' && <button onClick={()=>connectBLE(false,sendFailure.device)} className="mt-2 rounded-lg bg-white px-3 py-2 font-bold text-red-700">重试连接</button>}
          </div>}
          {connState === 'disconnected' && <>
            {lastKnown && ['ON','PICKUP','RELEASE','ARMED','FAULT'].includes(lastKnown.key) && <div role="alert" className="flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p><b>断开前：{lastKnown.title}</b>（{lastKnown.at}）。{lastKnown.mode==='ARMED'?`闹钟仍会在 ${lastKnown.trigger} 触发，断线不会取消。`:lastKnown.relay?'断线不会关机，设备可能仍在运行。':'断线不会改变设备状态。'}</p>
            </div>}
            <section className="space-y-4 rounded-2xl bg-white p-5 text-center shadow-sm">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-blue-50"><Bluetooth className="h-7 w-7 text-blue-600" /></div>
              <div>
                <h2 className="text-xl font-bold">连接控制器</h2>
                <p className="mt-1 text-sm text-slate-600">查看开关机反馈，设置定时开机。</p>
              </div>
              {!isBluetoothSupported && <div role="alert" className="space-y-1 rounded-xl bg-amber-50 p-3 text-left text-sm text-amber-900">
                <p className="font-bold">当前浏览器无法连接蓝牙</p>
                <p>iPhone 请用 Bluefy，安卓请用 Chrome，并通过 HTTPS 打开此页面。</p>
              </div>}
              {lastDevice.current && isBluetoothSupported && <button onClick={()=>connectBLE(true)} className={`${actionBase} w-full bg-blue-600 text-white`}><RefreshCw className="h-5 w-5" />重新连接 {lastDevice.current.name ?? '控制器'}</button>}
              <button onClick={()=>connectBLE(false)} disabled={!isBluetoothSupported} className={lastDevice.current ? 'w-full py-3 text-sm font-semibold text-blue-700' : `${actionBase} w-full bg-blue-600 text-white disabled:bg-slate-300`}>
                {lastDevice.current ? '扫描其他设备' : '扫描蓝牙设备'}
              </button>
              <p className="text-xs text-slate-500">请开启手机蓝牙，并靠近控制器。</p>
            </section>
          </>}
          {connState === 'connecting' && <section role="status" className="space-y-4 rounded-2xl bg-white p-6 text-center shadow-sm">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-600" />
            <p className="font-medium">正在连接设备…</p>
            <button onClick={()=>onDisconnected(true)} className="w-full rounded-xl border border-slate-300 py-3 font-semibold text-slate-700">取消</button>
          </section>}
        </main>
      </>}

      {connState === 'connected' && <>
        <section aria-label="设备状态" className={`app-band shrink-0 px-4 pb-3 pt-1 text-white ${BAND[bandKey]}`}>
          <div className="flex h-10 items-center justify-between">
            <h1 className="text-sm font-semibold opacity-90">装备控制器</h1>
            <div className="flex items-center gap-1">
              <span className="text-xs opacity-90" aria-label="蓝牙连接状态">{sendFailure && !sendFailure.soft ? '发送失败' : fresh ? '蓝牙在线' : '等待状态'}</span>
              <button aria-label="更多" onClick={()=>setSheet(true)} className="-mr-2 flex h-10 w-10 items-center justify-center rounded-full active:bg-white/20"><MoreHorizontal className="h-5 w-5" /></button>
            </div>
          </div>
          <div className="flex items-start justify-between gap-2">
            <h2 data-testid="state-title" className="app-title font-bold leading-tight tracking-tight">{display.title}</h2>
            {lamp ? <div aria-label={`状态灯：${lamp.name}`} className="mt-1 flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-2.5 py-1 text-sm text-slate-800">
              <span data-testid="status-lamp" className="h-3 w-3 rounded-full border border-black/10" style={{backgroundColor:lamp.rgb}} />{lamp.name}
            </div> : <span className="mt-2 whitespace-nowrap text-sm opacity-90">状态待确认</span>}
          </div>
          <p className="text-[15px] font-medium leading-snug" role={display.key === 'FAULT' ? 'alert' : undefined}>{display.detail}</p>
          {display.key === 'FAULT' && <p className="text-sm leading-snug opacity-95">{deviceData.relay ? '输出尚未确认关闭，请关机。' : '控制器输出已关闭；接触器状态以反馈为准。'}</p>}
          <p data-testid="readback" className="mt-1 text-sm tabular-nums opacity-95">
            输出 {fresh ? (deviceData.relay ? '开启' : '关闭') : '待确认'} · 反馈 DI {fresh && deviceData.feedback >= 0 ? deviceData.feedback : '待确认'}{localEditing && display.key==='FAULT' ? ' · 控制器正在本地设置' : ''}
          </p>
        </section>

        {sendFailure && <div role="alert" className={`app-banner flex shrink-0 items-center gap-2 px-4 py-2 text-sm font-medium ${sendFailure.soft ? 'bg-amber-100 text-amber-900' : 'bg-red-600 text-white'}`}>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1">{sendFailure.stopping && !failureOnCurrentDevice && <span>原设备 {sendFailure.device?.name ?? 'InsulCtrl'} 的停止尚未确认，当前连接了其他设备。 </span>}{sendFailure.text}</p>
          {!sendFailure.soft && !failureOnCurrentDevice && sendFailure.device && <button onClick={reconnectFailure} className="shrink-0 rounded-lg bg-white px-3 py-1.5 font-bold text-red-700">重新连接原设备</button>}
          {!sendFailure.soft && failureOnCurrentDevice && sendFailure.command!=='R:1' && <button onClick={retryFailure} disabled={!retryPermitted(sendFailure.command,now)} className="shrink-0 rounded-lg bg-white px-3 py-1.5 font-bold text-red-700 disabled:opacity-40">重试</button>}
          {sendFailure.soft && <button aria-label="关闭提示" onClick={()=>setSendFailure(null)} className="shrink-0 p-1"><X className="h-4 w-4" /></button>}
        </div>}

        <main className="app-body flex min-h-0 flex-1 flex-col divide-y divide-slate-200 overflow-y-auto bg-white">
          <section aria-label="当前时间" className="app-row">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 text-sm text-slate-600">当前时间{Math.abs(drift)>=5 && <span className="font-medium text-amber-700"> · {formatDrift(drift)}</span>}</div>
              <button onClick={doSync} disabled={!configureAllowed} className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-blue-50 px-2.5 py-1.5 text-sm font-semibold text-blue-700 disabled:opacity-40">
                <RefreshCw className={`h-3.5 w-3.5 ${sending('T') ? 'animate-spin' : ''}`} />同步时间
              </button>
            </div>
            <div data-testid="device-clock" className="big-time font-mono font-bold tabular-nums">{formatTime(fresh ? deviceClock : 0)}</div>
          </section>

          <section aria-label="闹钟时间" className="app-row">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm text-slate-600">{alarm.armed ? `触发时间${targetDay(deviceData,now) ? ` · ${targetDay(deviceData,now)}` : ''}` : '闹钟时间'}</h2>
              <span data-testid="alarm-status" className={`rounded-full px-2 py-0.5 text-xs font-semibold ${alarm.armed ? 'bg-blue-100 text-blue-800' : alarm.known ? 'bg-slate-100 text-slate-600' : 'bg-amber-100 text-amber-800'}`}>{alarm.text}</span>
            </div>
            {configureAllowed ? <div data-testid="alarm-time" className="mt-0.5 flex items-center gap-1.5">
              <select aria-label="小时" value={shownTime.h} onChange={e=>setDraft({h:+e.target.value,m:shownTime.m})} className="big-time time-select font-mono font-bold tabular-nums">
                {HOURS.map(h=><option key={h} value={h}>{pad(h)}</option>)}
              </select>
              <span className="big-time font-mono font-bold">:</span>
              <select aria-label="分钟" value={shownTime.m} onChange={e=>setDraft({h:shownTime.h,m:+e.target.value})} className="big-time time-select font-mono font-bold tabular-nums">
                {MINUTES.map(m=><option key={m} value={m}>{pad(m)}</option>)}
              </select>
              <div className="ml-auto">
                {dirty ? <button onClick={doSave} className="min-h-12 rounded-xl bg-slate-800 px-4 font-semibold text-white active:scale-[.98]">{sending('A') ? '保存中' : '保存'}</button>
                  : settingsFault ? null : <span className="flex items-center gap-1 text-sm text-slate-500"><Check className="h-4 w-4" />已保存</span>}
              </div>
            </div> : <div className="flex items-end justify-between gap-2">
              <div data-testid="alarm-time" className="big-time font-mono font-bold tabular-nums">{fresh ? (alarm.armed ? triggerTime(deviceData,now) : formatShortTime(saved.h,saved.m)) : '--:--'}</div>
              {alarm.armed && <div className="pb-1 text-right text-blue-700"><div className="text-xs">距开机</div><div className="font-mono text-lg font-semibold tabular-nums">{countdown(deviceData,now)}</div></div>}
            </div>}
            <p data-testid="alarm-note" className="mt-0.5 text-[13px] leading-snug text-slate-500">
              {dirty ? <span className="text-amber-700">未保存，设备仍为 {formatShortTime(saved.h,saved.m)} · <button onClick={()=>setDraft(null)} className="font-semibold underline">还原</button></span>
                : deviceData.resetNote && display.key==='IDLE' ? <span className="text-amber-700">上次闹钟因断电、复位或时钟故障已取消，需要重新启用。</span>
                : needPin ? '输入口令后可修改时间。'
                : configureAllowed && display.key==='IDLE' ? `启用后：${armPreview(deviceData,now,saved.h,saved.m) ?? ''} ${formatShortTime(saved.h,saved.m)} 自动开机`
                : configureAllowed ? '保存后仍需排除故障才能启用。'
                : alarm.armed ? '取消闹钟后可修改时间。'
                : !fresh ? '状态恢复后才能修改。'
                : '回到空闲后可修改时间。'}
            </p>
          </section>
        </main>

        <footer aria-label="控制操作" className="app-actions relative flex shrink-0 flex-col gap-1.5 border-t border-slate-200 bg-slate-50 px-4 pt-2.5">
          {toastView}
          {needPin && <form onSubmit={submitPin} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input id="ble-pin" aria-label="蓝牙口令" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={6} value={pinInput} onChange={e=>setPinInput(e.target.value.replace(/\D/g,''))} placeholder="6 位口令" className="action-button min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-center font-mono text-xl font-bold tracking-widest" />
              <button type="submit" disabled={pinInput.length!==6} className={`${actionBase} bg-slate-800 text-white`}>确认</button>
            </div>
            <p className="text-center text-xs text-slate-600">输入控制器屏幕上显示的口令，手机会记住。关机不需要口令。</p>
          </form>}
          {needPin && display.key==='IDLE' && <HoldActionButton label="关机" onConfirm={doStop} cancelKey={holdContext} statusText={actionStatus('R:0')} className={STOP_BUTTON}><Power className="h-5 w-5" />关机</HoldActionButton>}
          {display.key === 'IDLE' && !needPin && <>
            <div className="grid grid-cols-[2fr_3fr] gap-4">
              <HoldActionButton label="开机" onConfirm={doStart} cancelKey={holdContext} statusText={actionStatus('R:1')} disabled={!startAllowed || startLockLeft>0 || sending('R:1')} className={`${actionBase} bg-red-600 text-white`}>
                {sending('R:1') ? <Loader2 className="h-5 w-5 animate-spin" /> : <Power className="h-5 w-5" />}开机{startLockLeft>0 ? ` ${startLockLeft}s` : ''}
              </HoldActionButton>
              <button onClick={doArm} disabled={!startAllowed || startLockLeft>0 || dirty} className={`${actionBase} bg-blue-600 text-white`}>
                {sending('M:1') ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShieldCheck className="h-5 w-5" />}启用闹钟{startLockLeft>0 ? ` ${startLockLeft}s` : ''}
              </button>
            </div>
            <p className="text-center text-xs text-slate-500">{dirty ? '请先保存或还原时间，再启用闹钟。' : startLockLeft>0 ? startLock.text : '长按2秒开机 · 点击启用闹钟'}</p>
          </>}
          {display.key === 'ARMED' && <button onClick={doDisarm} className={`${actionBase} w-full bg-blue-600 text-white`}>{sending('M:0') && <Loader2 className="h-5 w-5 animate-spin" />}取消闹钟</button>}
          {['ON','PICKUP','RELEASE'].includes(display.key) && (immediateStop
            ? <button aria-label="关机" onClick={doStop} className={STOP_BUTTON}><Power className="h-5 w-5" />立即关机</button>
            : <HoldActionButton label="关机" onConfirm={doStop} cancelKey={holdContext} statusText={actionStatus('R:0')} className={STOP_BUTTON}>{sending('R:0') ? <Loader2 className="h-5 w-5 animate-spin" /> : <Power className="h-5 w-5" />}关机</HoldActionButton>)}
          {display.key === 'WAIT' && <>
            <button aria-label="关机" onClick={doStop} className={STOP_BUTTON}><Power className="h-5 w-5" />立即关机</button>
            <button onClick={()=>{ onDisconnected(true); connectBLE(true); }} className="py-1.5 text-sm font-semibold text-blue-700">状态一直不恢复？重新连接</button>
          </>}
          {display.key === 'SETTING' && <>
            <p className="rounded-lg bg-amber-50 p-2 text-center text-sm text-amber-800">请先在控制器上保存设置，再使用手机操作。</p>
            <button onClick={doStop} className={`${actionBase} w-full border border-slate-300 bg-white text-base text-slate-700`}>取消本地设置（不保存）</button>
          </>}
          {display.key === 'FAULT' && (stopFault || deviceData.fault===4 || needPin ? <button aria-label="关机" onClick={doStop} className={STOP_BUTTON}><Power className="h-5 w-5" />立即关机</button> : <>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              {fbFault && <button onClick={doAck} disabled={!ackAllowed} className={`${actionBase} border border-pink-300 bg-pink-50 text-pink-800`}>确认故障</button>}
              {rtcFault && (configureAllowed ? <button onClick={doSync} className={`${actionBase} bg-blue-600 text-white`}><RefreshCw className="h-5 w-5" />同步时间</button> : <span className="flex items-center text-sm text-slate-600">请先在控制器上保存设置。</span>)}
              {settingsFault && (configureAllowed ? <button onClick={doSave} className={`${actionBase} bg-slate-800 text-white`}>重新保存 {formatShortTime(shownTime.h,shownTime.m)}</button> : <span className="flex items-center text-sm text-slate-600">请先在控制器上保存设置。</span>)}
              <button onClick={doStop} aria-label="关机" className={`${actionBase} bg-green-700 text-base text-white`}>{localEditing ? '关机并取消设置' : '立即关机'}</button>
            </div>
            {fbFault && <p className="text-center text-xs text-slate-600">{ackReason}</p>}
          </>)}
        </footer>

        {sheet && <div className="app-sheet" role="dialog" aria-label="更多信息">
          <button aria-label="关闭" className="absolute inset-0 bg-black/40" onClick={()=>setSheet(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[88%] space-y-3 overflow-y-auto rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-sm text-slate-700">
            <div className="flex items-center justify-between"><h2 className="text-base font-bold">更多信息</h2><button aria-label="关闭" onClick={()=>setSheet(false)} className="-mr-2 p-2"><X className="h-5 w-5" /></button></div>
            <div><h3 className="font-semibold">控制器旋钮操作</h3><p className="mt-1 leading-relaxed" data-testid="knob-hint">{display.hint}</p></div>
            <div><h3 className="font-semibold">操作规则</h3><p className="mt-1 leading-relaxed">开机、正常关机需按住2秒，进度满后执行，提前松手或滑出取消。故障或状态待确认时可点击立即关机。其他按钮仍为点击执行。关机同时取消闹钟；保存的时间会保留，重新上电后需手动启用闹钟。设备时钟按 UTC+8 显示。</p></div>
            <div><h3 className="font-semibold">设备回读</h3>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
                <dt>控制输出</dt><dd>{fresh ? (deviceData.relay ? '开启' : '关闭') : '待确认'}</dd>
                <dt>DI 反馈</dt><dd>{fresh && deviceData.feedback >= 0 ? deviceData.feedback : '待确认'}</dd>
                <dt>设备已保存</dt><dd>{fresh ? formatShortTime(saved.h,saved.m) : '--:--'}</dd>
                <dt>诊断</dt><dd data-testid="diagnostic">{fresh ? diagnosticText(deviceData) : '待确认'}</dd>
              </dl>
            </div>
            <div><h3 className="font-semibold">连接记录</h3><div className="mt-1 max-h-32 overflow-y-auto break-words rounded-lg bg-slate-50 p-2 font-mono text-xs">{logs.length ? logs.map((line,i)=><div key={i}>{line}</div>) : '暂无记录'}</div></div>
            <div className="border-t border-slate-100 pt-3">
              <button onClick={()=>onDisconnected()} className="w-full rounded-xl border border-slate-300 py-3 font-semibold text-slate-700">断开蓝牙连接</button>
              <p className="mt-1 text-center text-xs text-slate-500">断开不会关机，也不会取消闹钟。{APP_VERSION}</p>
              {lastDevice.current && storedPin(lastDevice.current) && <button onClick={()=>{ storePin(lastDevice.current,null); showToast('已清除本机保存的口令'); setSheet(false); }} className="mt-1 w-full py-2 text-xs font-semibold text-slate-500 underline">清除本机保存的口令</button>}
            </div>
          </div>
        </div>}
      </>}
    </div>
  );
}
