import React, { useState, useEffect, useRef } from 'react';
import { 
  Bluetooth, Clock, Settings, Zap, ShieldCheck, 
  RefreshCw, CheckCircle, AlertTriangle, Timer, XCircle 
} from 'lucide-react';

const SERVICE_UUID = "0000aaaa-0000-1000-8000-00805f9b34fb";
const CHAR_UUID_CMD = "0000bbbb-0000-1000-8000-00805f9b34fb";

// 辅助: 计算倒计时
const calculateCountdown = (deviceTs, alarmH, alarmM) => {
  if (!deviceTs) return "--:--:--";
  const now = new Date(deviceTs * 1000);
  let alarm = new Date(deviceTs * 1000);
  alarm.setHours(alarmH, alarmM, 0, 0);
  if (alarm <= now) alarm.setDate(alarm.getDate() + 1);
  const diff = alarm - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
};

export default function InsulCtrlApp() {
  const [connState, setConnState] = useState('disconnected');
  const [device, setDevice] = useState(null);
  const [server, setServer] = useState(null);
  const [characteristic, setCharacteristic] = useState(null);
  
  const [deviceData, setDeviceData] = useState({
    mode: "IDLE", 
    relay: false,
    alarmH: 7,
    alarmM: 30,
    deviceTs: Math.floor(Date.now() / 1000), 
  });

  const [logs, setLogs] = useState([]);
  const [pendingAlarmH, setPendingAlarmH] = useState(7);
  const [pendingAlarmM, setPendingAlarmM] = useState(30);
  
  // 日志
  const addLog = (msg) => setLogs(p => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...p].slice(0, 20));

  // ==========================================
  // 核心：短协议处理
  // ==========================================
  
  // 1. 接收数据: S:模式,继电器,时,分
  const handleNotifications = (event) => {
    try {
      const decoder = new TextDecoder('utf-8');
      const str = decoder.decode(event.target.value);
      // 格式: S:MODE,RELAY,HH,MM
      if (str.startsWith("S:")) {
        const parts = str.substring(2).split(","); // 去掉 S:
        if (parts.length >= 4) {
          const modeCode = parseInt(parts[0]);
          const modeStr = modeCode === 1 ? "ARMED" : (modeCode === 2 ? "ON" : "IDLE");
          
          setDeviceData(prev => ({
            ...prev,
            mode: modeStr,
            relay: parts[1] === "1",
            alarmH: parseInt(parts[2]),
            alarmM: parseInt(parts[3]),
            deviceTs: Math.floor(Date.now() / 1000) // 简单用本地时间更新 UI
          }));
        }
      }
    } catch (e) { console.error(e); }
  };

  // 2. 发送数据 (发送纯字符串)
  const sendStr = async (str) => {
    if (!characteristic) return;
    try {
      addLog(`TX: ${str}`);
      const encoder = new TextEncoder();
      await characteristic.writeValue(encoder.encode(str));
    } catch (e) {
      addLog(`Error: ${e.message}`);
    }
  };

  // ==========================================
  // 连接逻辑
  // ==========================================
  const connectBLE = async () => {
    try {
      setConnState('connecting');
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID]
      });
      
      setDevice(device);
      device.addEventListener('gattserverdisconnected', () => {
        setConnState('disconnected');
        setCharacteristic(null);
      });

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const char = await service.getCharacteristic(CHAR_UUID_CMD);
      
      await char.startNotifications();
      char.addEventListener('characteristicvaluechanged', handleNotifications);
      
      setCharacteristic(char);
      setConnState('connected');
      addLog("Connected (Short Protocol)");
    } catch (e) {
      setConnState('disconnected');
      alert(e.message);
    }
  };

  // ==========================================
  // 按钮事件
  // ==========================================
  const toggleRelay = () => sendStr(deviceData.relay ? "R:0" : "R:1");
  const toggleArm = () => sendStr(deviceData.mode === "ARMED" ? "M:0" : "M:1");
  const syncTime = () => sendStr(`T:${Math.floor(Date.now()/1000)}`);
  const setAlarm = () => sendStr(`A:${String(pendingAlarmH).padStart(2,'0')}:${String(pendingAlarmM).padStart(2,'0')}`);

  return (
    <div className="min-h-screen bg-slate-100 p-4 font-sans text-slate-800">
      <header className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-bold flex gap-2"><Zap className="text-blue-600"/> InsulCtrl Lite</h1>
        <div className={`w-3 h-3 rounded-full ${connState === 'connected' ? 'bg-green-500' : 'bg-red-500'}`}/>
      </header>

      {connState === 'disconnected' ? (
        <button onClick={connectBLE} className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold shadow-lg">
          连接设备 (Short Proto)
        </button>
      ) : (
        <div className="space-y-4">
          {/* 状态卡片 */}
          <div className="grid grid-cols-2 gap-4">
            <button onClick={toggleRelay} className={`p-4 rounded-2xl text-left transition-all ${deviceData.relay ? 'bg-red-500 text-white' : 'bg-white'}`}>
              <div className="text-xs font-bold opacity-70">RELAY</div>
              <div className="text-2xl font-black">{deviceData.relay ? 'ON' : 'OFF'}</div>
            </button>
            <button onClick={toggleArm} className={`p-4 rounded-2xl text-left transition-all ${deviceData.mode === 'ARMED' ? 'bg-green-500 text-white' : 'bg-white'}`}>
              <div className="text-xs font-bold opacity-70">MODE</div>
              <div className="text-2xl font-black">{deviceData.mode}</div>
            </button>
          </div>

          {/* 倒计时 */}
          <div className="bg-white p-6 rounded-2xl shadow-sm text-center">
            <div className="text-xs text-slate-400 mb-2">COUNTDOWN</div>
            <div className="text-4xl font-mono font-black text-slate-800">
              {deviceData.mode === 'ARMED' ? calculateCountdown(deviceData.deviceTs, deviceData.alarmH, deviceData.alarmM) : "--:--:--"}
            </div>
          </div>

          {/* 设置 */}
          <div className="bg-white p-4 rounded-2xl shadow-sm flex justify-between items-center">
            <div>
              <div className="text-xs text-slate-400">ALARM SET</div>
              <div className="flex items-baseline gap-1 text-xl font-bold">
                <select value={pendingAlarmH} onChange={e=>setPendingAlarmH(e.target.value)} className="bg-transparent outline-none">
                  {[...Array(24).keys()].map(h=><option key={h} value={h}>{h}</option>)}
                </select>
                :
                <select value={pendingAlarmM} onChange={e=>setPendingAlarmM(e.target.value)} className="bg-transparent outline-none">
                  {[...Array(60).keys()].map(m=><option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <button onClick={setAlarm} className="bg-slate-100 p-3 rounded-xl hover:bg-slate-200"><CheckCircle/></button>
          </div>

          <button onClick={syncTime} className="w-full bg-blue-50 text-blue-600 py-3 rounded-xl font-bold">同步时间</button>
          
          <div className="mt-4 bg-slate-200 p-2 rounded text-[10px] font-mono h-24 overflow-auto">
            {logs.map((l,i)=><div key={i}>{l}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}