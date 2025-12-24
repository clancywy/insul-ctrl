import React, { useState, useEffect, useRef } from 'react';
import { 
  Bluetooth, Clock, Settings, Zap, ShieldCheck, 
  RefreshCw, CheckCircle, AlertTriangle, Timer, XCircle, Info 
} from 'lucide-react';

// ==========================================
// BLE 协议常量定义 (必须与 ESP32 一致)
// ==========================================
const SERVICE_UUID = "0000aaaa-0000-1000-8000-00805f9b34fb";
const CHAR_UUID_CMD = "0000bbbb-0000-1000-8000-00805f9b34fb";

// ==========================================
// 辅助工具函数
// ==========================================
const formatTime = (ts) => {
  if (!ts) return "--:--:--";
  const date = new Date(ts * 1000);
  return date.toLocaleTimeString('en-GB', { hour12: false });
};

const formatShortTime = (h, m) => {
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
};

const calculateCountdown = (deviceTs, alarmH, alarmM) => {
  if (!deviceTs) return "--:--:--";
  const now = new Date(deviceTs * 1000);
  let alarm = new Date(deviceTs * 1000);
  alarm.setHours(alarmH, alarmM, 0, 0);
  
  if (alarm <= now) {
    alarm.setDate(alarm.getDate() + 1);
  }
  
  const diff = alarm - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
};

export default function InsulCtrlApp() {
  // ==========================================
  // 应用状态
  // ==========================================
  const [connState, setConnState] = useState('disconnected'); // disconnected, connecting, connected
  const [device, setDevice] = useState(null);
  const [server, setServer] = useState(null);
  const [characteristic, setCharacteristic] = useState(null);
  
  // 设备状态数据
  const [deviceData, setDeviceData] = useState({
    mode: "IDLE", 
    relay: false,
    alarmH: 7,
    alarmM: 30,
    deviceTs: Math.floor(Date.now() / 1000), 
    lastUpdate: 0,
  });

  const [logs, setLogs] = useState([]);
  const [isMockMode, setIsMockMode] = useState(false);
  
  // 配置输入框状态
  const [pendingAlarmH, setPendingAlarmH] = useState(7);
  const [pendingAlarmM, setPendingAlarmM] = useState(30);
  
  // 浏览器支持检查
  const [isBluetoothSupported, setIsBluetoothSupported] = useState(true);

  // Toast 提示
  const [toast, setToast] = useState({ show: false, msg: '', type: 'success' });

  // 版本标记，用于确认更新
  const APP_VERSION = "Debug v2.3 (CN Time)";

  // 用于 Mock 模式的回调引用
  const deviceDataRef = useRef(deviceData);
  useEffect(() => { 
    deviceDataRef.current = deviceData;
    // 更新本地 Pending 状态以匹配设备当前值 (仅在未编辑时)
    // 这里简单处理：不做自动覆盖，避免用户输入时跳变
  }, [deviceData]);

  // 初始化检查
  useEffect(() => {
    if (!navigator.bluetooth) {
      setIsBluetoothSupported(false);
      addLog("当前浏览器不支持 Web Bluetooth API", "error");
    }
  }, []);

  // 显示 Toast
  const showToast = (msg, type = 'success') => {
    setToast({ show: true, msg, type });
    setTimeout(() => setToast(prev => ({ ...prev, show: false })), 3000);
  };

  // ==========================================
  // 日志系统
  // ==========================================
  const addLog = (msg, type = 'info') => {
    const time = new Date().toLocaleTimeString().split(' ')[0];
    setLogs(prev => [`[${time}] ${msg}`, ...prev].slice(0, 50));
  };

  // ==========================================
  // 核心：BLE 连接与监听逻辑
  // ==========================================
  
  // 处理接收到的数据 (Notification)
  const handleNotifications = (event) => {
    const value = event.target.value;
    const decoder = new TextDecoder('utf-8');
    try {
      const jsonStr = decoder.decode(value);
      // addLog(`RX: ${jsonStr}`, "rx"); // 调试用，太频繁可关闭
      
      const data = JSON.parse(jsonStr);
      
      // 收到数据，更新 React 状态
      setDeviceData(prev => ({
        ...prev,
        ...data, // 合并设备发来的 mode, relay, alarmH, alarmM, deviceTs
        lastUpdate: Date.now()
      }));
      
    } catch (error) {
      console.error("RX Parse Error", error);
    }
  };

  const connectBLE = async () => {
    try {
      addLog("正在扫描蓝牙设备...", "info");
      setConnState('connecting');
      setIsMockMode(false);

      // 1. 请求设备
      // 使用 acceptAllDevices 以最大程度避免搜不到的问题
      // 必须配合 optionalServices 才能访问服务
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID]
      });

      addLog(`找到设备: ${device.name}`, "success");
      setDevice(device);
      
      // 监听断开事件
      device.addEventListener('gattserverdisconnected', onDisconnected);

      // 2. 连接 GATT Server
      const server = await device.gatt.connect();
      setServer(server);
      
      // 3. 获取服务和特征值
      const service = await server.getPrimaryService(SERVICE_UUID);
      const char = await service.getCharacteristic(CHAR_UUID_CMD);
      
      // 4. 【关键修复】开启通知 (订阅)
      await char.startNotifications();
      char.addEventListener('characteristicvaluechanged', handleNotifications);
      addLog("已开启数据监听", "info");

      setCharacteristic(char);
      setConnState('connected');
      addLog("连接成功", "success");
      showToast("蓝牙连接成功");

    } catch (error) {
      console.error(error);
      addLog(`连接失败: ${error.message}`, "error");
      setConnState('disconnected');
      alert(`连接失败:\n${error.message}\n\n提示：请确保 ESP32 已重置且未被其他 App/系统连接。`);
    }
  };

  const onDisconnected = () => {
    addLog("设备已断开", "warn");
    setConnState('disconnected');
    setDevice(null);
    setServer(null);
    setCharacteristic(null);
    showToast("设备已断开连接", "error");
  };

  // ==========================================
  // 演示模式 (Mock)
  // ==========================================
  const connectMock = () => {
    setIsMockMode(true);
    setConnState('connecting');
    setTimeout(() => {
      setConnState('connected');
      addLog("Mock 设备已连接", "success");
      showToast("虚拟设备已连接");
      startMockHeartbeat();
    }, 600);
  };

  const mockIntervalRef = useRef(null);
  const startMockHeartbeat = () => {
    if (mockIntervalRef.current) clearInterval(mockIntervalRef.current);
    mockIntervalRef.current = setInterval(() => {
      setDeviceData(prev => {
        let nextTs = prev.deviceTs + 1;
        let nextRelay = prev.relay;
        let nextMode = prev.mode;
        
        if (prev.mode === 'ARMED') {
           const now = new Date(nextTs * 1000);
           if (now.getHours() === prev.alarmH && now.getMinutes() === prev.alarmM && now.getSeconds() === 0) {
             nextRelay = true;
             nextMode = 'ON';
             addLog("Mock: 闹钟触发!", "warn");
             showToast("闹钟触发！", "error");
           }
        }
        return { ...prev, deviceTs: nextTs, relay: nextRelay, mode: nextMode };
      });
    }, 1000);
  };

  // ==========================================
  // 指令发送
  // ==========================================
  const sendCommand = async (payload) => {
    const jsonStr = JSON.stringify(payload);
    if(payload.cmd !== 'sync_time') addLog(`TX: ${jsonStr}`, "tx");

    // Mock 处理
    if (isMockMode) {
      setTimeout(() => { 
        if (payload.cmd === "sync_time") { 
          // Mock 模式下，忽略 payload.ts (因为它是本地时间)，直接用 UTC 保证显示正确
          setDeviceData(prev => ({ ...prev, deviceTs: Math.floor(Date.now() / 1000) })); 
          showToast("时间同步成功"); 
        } else if (payload.cmd === "set_alarm") {
          setDeviceData(prev => ({ ...prev, alarmH: payload.h, alarmM: payload.m }));
          addLog("Mock: 闹钟已更新", "rx");
          showToast(`闹钟已设为 ${formatShortTime(payload.h, payload.m)}`);
        } else if (payload.cmd === "toggle_arm") {
          const newMode = deviceDataRef.current.mode === 'ARMED' ? 'IDLE' : 'ARMED';
          setDeviceData(prev => ({ ...prev, mode: newMode, relay: false }));
          showToast(newMode === 'ARMED' ? "已启动定时 (ARMED)" : "已取消 (IDLE)");
        } else if (payload.cmd === "toggle_relay") {
           const newVal = !deviceDataRef.current.relay;
           setDeviceData(prev => ({ ...prev, relay: newVal }));
           showToast(`继电器已${newVal ? '吸合' : '断开'}`);
        }
      }, 100);
      return;
    }

    // BLE 处理
    if (!characteristic) return;
    try {
      const encoder = new TextEncoder();
      await characteristic.writeValue(encoder.encode(jsonStr));
      // 注意：这里我们不立即 showToast，而是等待 handleNotifications 收到回包后再更新 UI
      // 这样能确保 UI 显示的是真实硬件状态
    } catch (error) {
      addLog(`TX Fail: ${error.message}`, "error");
      showToast("发送失败", "error");
    }
  };

  // ========================================== 
  // 功能处理 
  // ========================================== 
  const handleSyncTime = () => {
    // 获取当前时间
    const now = new Date();
    // 计算本地时间对应的秒数（即：让设备收到 12:00 的数值，而不是 04:00）
    // 北京时间 (UTC+8) = UTC + 8小时
    // getTimezoneOffset() 返回分钟差 (UTC - 本地)，北京时间是 -480
    const offsetSeconds = now.getTimezoneOffset() * 60 * -1; 
    const localTs = Math.floor(Date.now() / 1000) + offsetSeconds;
    
    sendCommand({ cmd: "sync_time", ts: localTs });
  };

  const handleSetAlarm = () => sendCommand({ cmd: "set_alarm", h: parseInt(pendingAlarmH), m: parseInt(pendingAlarmM) });
  const toggleRelay = () => sendCommand({ cmd: "toggle_relay" });
  const toggleArm = () => sendCommand({ cmd: "toggle_arm" });

  // ==========================================
  // 界面渲染
  // ==========================================
  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-10 relative select-none">
      
      {/* Toast 通知 */}
      <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ${toast.show ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'}`}>
        <div className={`px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 text-sm font-bold ${
          toast.type === 'error' ? 'bg-red-500 text-white' : 'bg-slate-800 text-white'
        }`}>
          {toast.type === 'success' && <CheckCircle className="w-4 h-4" />}
          {toast.type === 'error' && <AlertTriangle className="w-4 h-4" />}
          {toast.msg}
        </div>
      </div>

      {/* 顶部栏 */}
      <header className="bg-white shadow-sm sticky top-0 z-20">
        <div className="max-w-md mx-auto px-4 h-16 flex items-center justify-between">
          <h1 className="font-bold text-xl text-slate-800 flex items-center gap-2">
            <Settings className="w-6 h-6 text-blue-600" />
            InsulCtrl <span className="text-[10px] text-slate-400 font-mono bg-slate-100 px-1 rounded">{APP_VERSION}</span>
          </h1>
          <div className={`px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 ${
            connState === 'connected' ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-500'
          }`}>
            <div className={`w-2 h-2 rounded-full ${connState === 'connected' ? 'bg-green-500 animate-pulse' : 'bg-slate-400'}`} />
            {connState === 'connected' ? (isMockMode ? 'Mock' : 'Online') : 'Offline'}
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto p-4 space-y-5">

        {/* Debug Banner - 仅用于调试阶段 */}
        <div className="bg-blue-400 text-blue-900 text-center py-2 px-4 rounded-xl font-bold text-sm shadow-sm animate-pulse">
          DEBUG v2.3 - 已修复北京时间差
        </div>

        {/* 连接页 */}
        {connState === 'disconnected' && (
          <div className="bg-white rounded-3xl p-8 shadow-sm text-center space-y-6 mt-10">
            <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto ring-8 ring-blue-50/50">
              <Bluetooth className="w-10 h-10 text-blue-600" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-slate-800">开始连接</h2>
              <p className="text-slate-400 mt-2">控制您的 InsulCtrl 绝缘件设备</p>
            </div>

            {!isBluetoothSupported && (
              <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-left text-sm text-red-600 space-y-2">
                <div className="font-bold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  当前浏览器不支持蓝牙
                </div>
                <p>iOS 用户：请使用 <span className="font-bold">Bluefy</span> 浏览器 APP。</p>
                <p>Android 用户：请使用 <span className="font-bold">Chrome</span> 浏览器。</p>
                <p>PC 用户：请使用 <span className="font-bold">Chrome</span> 或 Edge。</p>
              </div>
            )}

            <div className="space-y-3">
              <button 
                onClick={connectBLE} 
                disabled={!isBluetoothSupported}
                className={`w-full font-bold py-4 rounded-xl shadow-lg transition-transform ${
                  isBluetoothSupported 
                    ? 'bg-blue-600 text-white shadow-blue-200 active:scale-95' 
                    : 'bg-slate-300 text-slate-500 cursor-not-allowed'
                }`}
              >
                扫描蓝牙设备
              </button>
              <button onClick={connectMock} className="w-full text-slate-400 text-sm font-medium py-2 hover:text-slate-600">
                演示模式 (Mock Mode)
              </button>
            </div>
          </div>
        )}

        {/* 控制面板 */}
        {connState === 'connected' && (
          <>
            {/* 1. 顶部状态与控制 Dashboard */}
            <section className="grid grid-cols-2 gap-4">
              {/* 继电器控制 */}
              <button 
                onClick={toggleRelay}
                className={`relative overflow-hidden rounded-3xl p-5 text-left transition-all duration-300 shadow-sm group active:scale-95 ${
                  deviceData.relay 
                    ? 'bg-gradient-to-br from-red-500 to-red-600 text-white shadow-red-200' 
                    : 'bg-white text-slate-600 hover:border-slate-300 border border-transparent'
                }`}
              >
                <div className="absolute top-4 right-4 opacity-20 group-hover:opacity-40 transition-opacity">
                  <Zap className="w-12 h-12" />
                </div>
                <div className="relative z-10">
                  <div className={`p-2 rounded-xl w-fit mb-3 ${deviceData.relay ? 'bg-white/20' : 'bg-slate-100'}`}>
                    <Zap className="w-6 h-6" />
                  </div>
                  <div className="text-xs font-bold opacity-80 uppercase tracking-wider mb-1">RELAY</div>
                  <div className="text-xl font-black tracking-tight">
                    {deviceData.relay ? 'ON' : 'OFF'}
                  </div>
                </div>
              </button>

              {/* 模式切换 */}
              <button 
                onClick={toggleArm}
                className={`relative overflow-hidden rounded-3xl p-5 text-left transition-all duration-300 shadow-sm group active:scale-95 ${
                  deviceData.mode === 'ARMED' 
                    ? 'bg-gradient-to-br from-green-500 to-green-600 text-white shadow-green-200' 
                    : 'bg-white text-slate-600 hover:border-slate-300 border border-transparent'
                }`}
              >
                <div className="absolute top-4 right-4 opacity-20 group-hover:opacity-40 transition-opacity">
                  <ShieldCheck className="w-12 h-12" />
                </div>
                <div className="relative z-10">
                  <div className={`p-2 rounded-xl w-fit mb-3 ${deviceData.mode === 'ARMED' ? 'bg-white/20' : 'bg-slate-100'}`}>
                    <ShieldCheck className="w-6 h-6" />
                  </div>
                  <div className="text-xs font-bold opacity-80 uppercase tracking-wider mb-1">MODE</div>
                  <div className="text-xl font-black tracking-tight">
                    {deviceData.mode === 'ARMED' ? 'ARMED' : 'IDLE'}
                  </div>
                </div>
              </button>
            </section>

            {/* 2. 倒计时卡片 */}
            <section className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100 relative overflow-hidden">
              <div className="flex justify-between items-start mb-4 relative z-10">
                <div>
                  <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                    <Timer className="w-5 h-5 text-orange-500" />
                    倒计时
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    {deviceData.mode === 'ARMED' ? '距离下一次自动启动' : '定时器未启动'}
                  </p>
                </div>
                {deviceData.mode === 'ARMED' && (
                  <span className="bg-orange-100 text-orange-600 text-xs font-bold px-2 py-1 rounded-lg">
                    运行中
                  </span>
                )}
              </div>
              
              <div className="relative z-10 text-center py-2">
                <div className={`text-4xl font-mono font-black tracking-wider ${
                  deviceData.mode === 'ARMED' ? 'text-slate-800' : 'text-slate-300'
                }`}>
                  {deviceData.mode === 'ARMED' 
                    ? calculateCountdown(deviceData.deviceTs, deviceData.alarmH, deviceData.alarmM)
                    : '--:--:--'
                  }
                </div>
                {deviceData.mode !== 'ARMED' && (
                  <div className="text-xs text-slate-400 mt-2">
                    点击上方 <span className="font-bold text-slate-600">IDLE</span> 按钮以启动定时
                  </div>
                )}
              </div>
            </section>

            {/* 3. 参数配置区 */}
            <section className="space-y-4">
              <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider ml-2">Configuration</h3>
              
              {/* 闹钟设定 */}
              <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="bg-orange-50 p-3 rounded-xl text-orange-500">
                    <AlertTriangle className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-400 mb-1">定时时间</div>
                    {/* 显示当前设备设定值，作为参考 */}
                    <div className="text-[10px] text-slate-400 font-mono mb-1">
                      当前设备设定: <span className="text-orange-600 font-bold">{formatShortTime(deviceData.alarmH, deviceData.alarmM)}</span>
                    </div>
                    <div className="flex items-baseline gap-1">
                      <select 
                        value={pendingAlarmH} 
                        onChange={(e) => setPendingAlarmH(e.target.value)}
                        className="bg-transparent font-bold text-xl text-slate-800 outline-none p-0 cursor-pointer hover:text-orange-600 appearance-none"
                      >
                        {[...Array(24).keys()].map(h => <option key={h} value={h}>{String(h).padStart(2,'0')}</option>)}
                      </select>
                      <span className="text-slate-300">:</span>
                      <select 
                        value={pendingAlarmM} 
                        onChange={(e) => setPendingAlarmM(e.target.value)}
                        className="bg-transparent font-bold text-xl text-slate-800 outline-none p-0 cursor-pointer hover:text-orange-600 appearance-none"
                      >
                        {[...Array(60).keys()].map(m => <option key={m} value={m}>{String(m).padStart(2,'0')}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
                <button 
                  onClick={handleSetAlarm} 
                  className="bg-slate-800 text-white p-3 rounded-xl active:scale-95 transition-transform shadow-lg shadow-slate-200"
                  title="保存并发送"
                >
                  <CheckCircle className="w-5 h-5" />
                </button>
              </div>

              {/* 时间同步 */}
              <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="bg-blue-50 p-3 rounded-xl text-blue-500">
                    <Clock className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-400">设备时钟</div>
                    <div className="font-mono text-lg font-bold text-slate-700">
                      {formatTime(deviceData.deviceTs)}
                    </div>
                  </div>
                </div>
                <button 
                  onClick={handleSyncTime} 
                  className="bg-blue-50 text-blue-600 p-3 rounded-xl hover:bg-blue-100 active:scale-95 transition-colors"
                  title="同步手机时间"
                >
                  <RefreshCw className="w-5 h-5" />
                </button>
              </div>
            </section>

            {/* 4. 底部断开 */}
            <section className="pt-4">
              <button 
                onClick={() => { if(server) server.disconnect(); onDisconnected(); }} 
                className="w-full py-3 text-red-400 text-sm font-medium hover:text-red-600 flex items-center justify-center gap-2"
              >
                <XCircle className="w-4 h-4" /> 断开设备连接
              </button>
              
              <div className="mt-4 bg-slate-200 rounded-lg p-2 h-20 overflow-y-auto text-[10px] font-mono text-slate-500">
                {logs.map((l,i) => <div key={i}>{l}</div>)}
              </div>
            </section>

          </>
        )}
      </main>
    </div>
  );
}