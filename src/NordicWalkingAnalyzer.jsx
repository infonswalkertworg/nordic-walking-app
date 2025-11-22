import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Play, Pause, Upload, Video as VideoIcon, Activity, Smartphone, Monitor, Settings, BarChart2, AlertCircle } from 'lucide-react';

/**
 * 北歐式健走分析儀 Web-app (優化版 v2)
 * * [更新日誌]
 * 1. 演算法優化: 調整 analyzeHandState 閾值，提升後擺手掌張開的識別率。
 * 2. 視覺優化: 在手部骨架上增加「握拳/張開」的顏色指示燈。
 * 3. 介面調整: 保持一頁式設計，並強化數據可讀性。
 */

// --- 樣式定義 ---
const THEME = {
  bg: 'bg-slate-950',
  panel: 'bg-slate-900',
  text: 'text-slate-100',
  textMuted: 'text-slate-400',
  accent: 'text-blue-400',
  border: 'border-slate-800',
  colors: {
    left: '#FF3B30',   // 左側紅
    right: '#34C759',  // 右側綠
    spine: '#FFD60A',  // 中軸黃
    ref: '#FF9500',    // 參考線橘
    text: '#FFFFFF',
    fist: '#FFCC00',   // 握拳 (黃)
    open: '#00FF00'    // 張開 (亮綠)
  }
};

// --- 幾何運算 ---
const getDistance = (p1, p2) => Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));

const getVerticalAngle = (p1, p2) => {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y; 
  const rad = Math.acos(dy / (Math.sqrt(dx*dx + dy*dy) + 0.0001)); 
  return (rad * 180) / Math.PI;
};

const getAngle = (A, B, C) => {
  const AB = Math.sqrt(Math.pow(B.x - A.x, 2) + Math.pow(B.y - A.y, 2));    
  const BC = Math.sqrt(Math.pow(B.x - C.x, 2) + Math.pow(B.y - C.y, 2)); 
  const AC = Math.sqrt(Math.pow(C.x - A.x, 2) + Math.pow(C.y - A.y, 2));
  const rad = Math.acos((AB*AB + BC*BC - AC*AC) / (2 * AB * BC + 0.0001));
  return (rad * 180) / Math.PI;
};

// 判斷手掌狀態 (優化版 V2)
const analyzeHandState = (landmarks, side) => {
  const offset = side === 'Left' ? 0 : 1;
  const wrist = landmarks[15 + offset];
  const elbow = landmarks[13 + offset];
  const pinky = landmarks[17 + offset];
  const index = landmarks[19 + offset];
  const thumb = landmarks[21 + offset];
  
  // 如果關鍵點信心度太低，直接回傳未知
  if (!wrist || !elbow || !pinky || !index || !thumb || 
      wrist.visibility < 0.5 || index.visibility < 0.5) return '未知';

  // 前臂長度 (作為比例尺)
  const forearmLen = getDistance(wrist, elbow);
  
  // 計算指尖到手腕的平均距離
  const fingerDist = (getDistance(wrist, pinky) + getDistance(wrist, index) + getDistance(wrist, thumb)) / 3;
  
  // 正規化比值
  const ratio = fingerDist / forearmLen;

  // [修正] 調降閾值：
  // 之前的 0.32 對於後擺(遠處)來說太嚴格，容易判斷成握拳。
  // 下修至 0.25，只要手指有一點伸展就算張開。
  return ratio > 0.25 ? '張開' : '握拳';
};

const NordicWalkingApp = () => {
  // --- State ---
  const [videoSource, setVideoSource] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [viewMode, setViewMode] = useState('side_left');
  const [userHeight, setUserHeight] = useState(170);
  const [isRecording, setIsRecording] = useState(false);
  const [alertMsg, setAlertMsg] = useState('');

  // 即時數據
  const [realtimeMetrics, setRealtimeMetrics] = useState({
    torsoAngle: 0,
    armAngleL: 0,
    armAngleR: 0,
    stepLength: 0,
    handL: '未知',
    handR: '未知',
    comX: 0
  });

  // 統計數據
  const statsRef = useRef({
    maxTorso: 0, minTorso: 90, sumTorso: 0, countTorso: 0,
    maxArmFwd: 0, maxArmBack: 0, sumArm: 0, countArm: 0,
    maxStep: 0, sumStep: 0, countStepSample: 0,
    stepCount: 0,
    fistCount: 0, openCount: 0, totalHandFrames: 0,
    lastAnkleDist: 0, stepTrend: 0
  });
  
  const [displayStats, setDisplayStats] = useState({
    avgTorso: 0, maxTorso: 0, minTorso: 0,
    avgArm: 0, maxArmFwd: 0, maxArmBack: 0,
    avgStep: 0, maxStep: 0,
    steps: 0,
    handRatio: 0
  });

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const poseRef = useRef(null);
  const requestRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  // --- 初始化 ---
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js';
    script.async = true;
    document.body.appendChild(script);

    script.onload = () => {
      const { Pose } = window;
      const pose = new Pose({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
      });
      pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      pose.onResults(onResults);
      poseRef.current = pose;
    };

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [viewMode, userHeight]);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoSource(url);
      resetStats();
    }
  };

  const resetStats = () => {
    statsRef.current = {
      maxTorso: 0, minTorso: 90, sumTorso: 0, countTorso: 0,
      maxArmFwd: 0, maxArmBack: 0, sumArm: 0, countArm: 0,
      maxStep: 0, sumStep: 0, countStepSample: 0,
      stepCount: 0,
      fistCount: 0, openCount: 0, totalHandFrames: 0,
      lastAnkleDist: 0, stepTrend: 0
    };
    setDisplayStats({
      avgTorso: 0, maxTorso: 0, minTorso: 0,
      avgArm: 0, maxArmFwd: 0, maxArmBack: 0,
      avgStep: 0, maxStep: 0,
      steps: 0,
      handRatio: 0
    });
  };

  // --- 核心分析迴圈 ---
  const onResults = (results) => {
    if (!canvasRef.current || !videoRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;

    // 繪製底圖
    ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

    if (!results.poseLandmarks) return;
    const lm = results.poseLandmarks;

    // --- 數據計算優先 ---
    const stats = statsRef.current;
    const pxHeight = Math.abs(lm[30].y - lm[2].y) * canvas.height;
    const cmPerPx = userHeight / (pxHeight || 1);

    // 手掌狀態分析
    const handLState = analyzeHandState(lm, 'Left');
    const handRState = analyzeHandState(lm, 'Right');

    // --- 繪圖函式 ---
    const drawLine = (i1, i2, color, w=3) => {
      if(lm[i1]?.visibility > 0.5 && lm[i2]?.visibility > 0.5) {
        ctx.beginPath();
        ctx.moveTo(lm[i1].x * canvas.width, lm[i1].y * canvas.height);
        ctx.lineTo(lm[i2].x * canvas.width, lm[i2].y * canvas.height);
        ctx.strokeStyle = color;
        ctx.lineWidth = w;
        ctx.stroke();
      }
    };

    // 繪製手掌狀態指示 (實心圓)
    const drawHandIndicator = (idx, state) => {
       if(lm[idx] && lm[idx].visibility > 0.5) {
          ctx.beginPath();
          ctx.arc(lm[idx].x * canvas.width, lm[idx].y * canvas.height, 8, 0, 2 * Math.PI);
          // 綠色表示張開，黃色表示握拳，灰色未知
          ctx.fillStyle = state === '張開' ? THEME.colors.open : (state === '握拳' ? THEME.colors.fist : '#888');
          ctx.fill();
          ctx.strokeStyle = '#FFF';
          ctx.lineWidth = 2;
          ctx.stroke();
       }
    };

    // 骨架繪製
    const leftColor = THEME.colors.left;
    const rightColor = THEME.colors.right;

    // 左側
    [11,13,23,25,27].forEach(i => drawLine(i, i+2, leftColor));
    drawLine(27, 31, leftColor);
    // 左手掌視覺化
    drawLine(15, 19, leftColor, 2); // Wrist to Index
    drawHandIndicator(19, handLState); // 在食指根部畫指示燈

    // 右側
    [12,14,24,26,28].forEach(i => drawLine(i, i+2, rightColor));
    drawLine(28, 32, rightColor);
    // 右手掌視覺化
    drawLine(16, 20, rightColor, 2);
    drawHandIndicator(20, handRState);

    // 軀幹中軸
    const midSh = { x: (lm[11].x + lm[12].x)/2, y: (lm[11].y + lm[12].y)/2 };
    const midHip = { x: (lm[23].x + lm[24].x)/2, y: (lm[23].y + lm[24].y)/2 };
    ctx.beginPath();
    ctx.moveTo(midSh.x * canvas.width, midSh.y * canvas.height);
    ctx.lineTo(midHip.x * canvas.width, midHip.y * canvas.height);
    ctx.strokeStyle = THEME.colors.spine;
    ctx.lineWidth = 4;
    ctx.stroke();

    // 質心
    const com = { x: midHip.x, y: midHip.y - (midHip.y - midSh.y) * 0.2 };
    ctx.beginPath();
    ctx.arc(com.x * canvas.width, com.y * canvas.height, 10, 0, 2 * Math.PI);
    ctx.fillStyle = THEME.colors.ref;
    ctx.fill();

    // 地面線 & 垂直線
    const groundY = Math.max(lm[27].y, lm[28].y, lm[31].y, lm[32].y) * canvas.height;
    ctx.beginPath();
    ctx.moveTo(0, groundY); ctx.lineTo(canvas.width, groundY);
    ctx.moveTo(com.x * canvas.width, 0); ctx.lineTo(com.x * canvas.width, canvas.height);
    ctx.strokeStyle = THEME.colors.ref;
    ctx.setLineDash([5,5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // --- 統計更新 ---
    // 1. 軀幹
    const lean = getVerticalAngle(midHip, midSh);
    stats.sumTorso += lean;
    stats.countTorso++;
    stats.maxTorso = Math.max(stats.maxTorso, lean);
    stats.minTorso = Math.min(stats.minTorso, lean);

    // 2. 手臂 & 手掌
    const armL = getAngle(lm[23], lm[11], lm[13]);
    const armR = getAngle(lm[24], lm[12], lm[14]);
    
    const isFaceLeft = viewMode === 'side_left';
    const lArmDir = (lm[13].x - lm[11].x) * (isFaceLeft ? -1 : 1); 
    const rArmDir = (lm[14].x - lm[12].x) * (isFaceLeft ? -1 : 1);

    if(lArmDir > 0) stats.maxArmFwd = Math.max(stats.maxArmFwd, armL);
    else stats.maxArmBack = Math.max(stats.maxArmBack, armL);
    if(rArmDir > 0) stats.maxArmFwd = Math.max(stats.maxArmFwd, armR);
    else stats.maxArmBack = Math.max(stats.maxArmBack, armR);

    stats.sumArm += (armL + armR)/2;
    stats.countArm++;

    stats.totalHandFrames++;
    if(handLState === '握拳') stats.fistCount++; else if(handLState === '張開') stats.openCount++;
    if(handRState === '握拳') stats.fistCount++; else if(handRState === '張開') stats.openCount++;

    // 3. 步幅
    const ankleDist = Math.abs(lm[27].x - lm[28].x) * canvas.width;
    const stepLen = ankleDist * cmPerPx;
    stats.sumStep += stepLen;
    stats.countStepSample++;
    stats.maxStep = Math.max(stats.maxStep, stepLen);

    const distThreshold = (userHeight * 0.2) / cmPerPx;
    if (ankleDist > stats.lastAnkleDist) {
        stats.stepTrend = 1; 
    } else if (ankleDist < stats.lastAnkleDist && stats.stepTrend === 1) {
        if (ankleDist > distThreshold) stats.stepCount++;
        stats.stepTrend = -1;
    }
    stats.lastAnkleDist = ankleDist;

    // UI 更新 (每 10 幀)
    if (stats.countTorso % 10 === 0) {
      setRealtimeMetrics({
        torsoAngle: lean,
        armAngleL: armL,
        armAngleR: armR,
        stepLength: stepLen,
        handL: handLState,
        handR: handRState,
        comX: com.x
      });
      
      setDisplayStats({
        avgTorso: stats.sumTorso / stats.countTorso,
        maxTorso: stats.maxTorso,
        minTorso: stats.minTorso,
        avgArm: stats.sumArm / stats.countArm,
        maxArmFwd: stats.maxArmFwd,
        maxArmBack: stats.maxArmBack,
        avgStep: stats.sumStep / stats.countStepSample,
        maxStep: stats.maxStep,
        steps: stats.stepCount,
        handRatio: (stats.fistCount / (stats.fistCount + stats.openCount || 1)) * 100
      });
    }
  };

  // --- 影片與錄製 ---
  const videoFrameCallback = () => {
    if (videoRef.current && !videoRef.current.paused && !videoRef.current.ended) {
      if (poseRef.current) {
        poseRef.current.send({ image: videoRef.current }).then(() => {
          requestRef.current = requestAnimationFrame(videoFrameCallback);
        });
      }
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setIsPlaying(true);
      videoFrameCallback();
    } else {
      video.pause();
      setIsPlaying(false);
      cancelAnimationFrame(requestRef.current);
    }
  };

  const startRecording = () => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.captureStream) {
      setAlertMsg("此瀏覽器不支援影片匯出 (iOS 請更新至最新版)");
      return;
    }
    const stream = canvas.captureStream(30);
    let options = { mimeType: 'video/webm;codecs=vp9' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { mimeType: 'video/mp4' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) options = undefined;
    }

    try {
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `nordic_analysis_${new Date().getTime()}.webm`;
        a.click();
        setIsRecording(false);
      };
      mediaRecorder.start();
      setIsRecording(true);
      if(videoRef.current.paused) togglePlay();
    } catch (e) {
      console.error(e);
      setAlertMsg("錄製失敗");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      if(!videoRef.current.paused) togglePlay();
    }
  };

  return (
    <div className={`flex flex-col h-screen w-full ${THEME.bg} ${THEME.text} overflow-hidden`}>
      
      {/* Top Nav */}
      <div className={`flex items-center justify-between px-4 py-2 ${THEME.border} border-b bg-slate-900 shrink-0`}>
        <div className="flex items-center gap-2">
          <Activity className="text-yellow-400" />
          <h1 className="font-bold text-lg hidden sm:block">Nordic Walking Analyzer v2</h1>
          <span className="text-xs bg-blue-900 px-2 py-1 rounded text-blue-200">Pro</span>
        </div>
        <div className="flex items-center gap-3">
           <div className="flex bg-slate-800 rounded-lg p-1 text-xs">
              {['side_left', 'side_right', 'front', 'back'].map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-3 py-1 rounded ${viewMode === mode ? 'bg-slate-600 text-white' : 'text-slate-400'}`}
                >
                  {mode === 'side_left' ? '左側' : mode === 'side_right' ? '右側' : mode === 'front' ? '正面' : '背面'}
                </button>
              ))}
           </div>
           <div className="flex items-center gap-1 text-xs bg-slate-800 px-2 py-1 rounded">
              <Settings size={14} />
              <input 
                type="number" 
                value={userHeight} 
                onChange={(e) => setUserHeight(Number(e.target.value))}
                className="w-10 bg-transparent text-right focus:outline-none"
              />
              <span>cm</span>
           </div>
           <label className="cursor-pointer bg-blue-600 hover:bg-blue-500 px-3 py-1 rounded text-xs font-bold flex items-center gap-1">
             <Upload size={14} />
             <span className="hidden sm:inline">匯入影片</span>
             <input type="file" accept="video/*" className="hidden" onChange={handleFile} />
           </label>
        </div>
      </div>

      {/* Alert */}
      {alertMsg && (
        <div className="absolute top-14 left-1/2 transform -translate-x-1/2 z-50 bg-red-600 px-4 py-2 rounded shadow-lg flex items-center gap-2 text-sm">
          <AlertCircle size={16}/> {alertMsg}
          <button onClick={() => setAlertMsg('')} className="ml-2 font-bold">✕</button>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
        
        {/* Canvas Area */}
        <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden">
           {!videoSource ? (
             <div className="text-center p-10 opacity-50">
               <VideoIcon size={48} className="mx-auto mb-4"/>
               <p>請點擊右上角匯入影片</p>
               <p className="text-xs mt-2">支援 iOS/Android/Windows/Mac</p>
             </div>
           ) : (
             <>
              <video 
                ref={videoRef} 
                src={videoSource} 
                className="hidden"
                playsInline muted crossOrigin="anonymous"
                onLoadedMetadata={() => {
                   if(canvasRef.current && videoRef.current) {
                     canvasRef.current.width = videoRef.current.videoWidth;
                     canvasRef.current.height = videoRef.current.videoHeight;
                   }
                }}
              />
              <canvas ref={canvasRef} className="max-w-full max-h-full object-contain" />
             </>
           )}

           <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center gap-4 bg-slate-900/80 px-6 py-2 rounded-full backdrop-blur-sm border border-slate-700">
              <button onClick={togglePlay} className="hover:text-yellow-400 transition">
                {isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
              </button>
              <button 
                onClick={isRecording ? stopRecording : startRecording}
                className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold transition ${
                  isRecording ? 'bg-red-600 animate-pulse' : 'bg-slate-700 hover:bg-slate-600'
                }`}
              >
                <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-white' : 'bg-red-500'}`} />
                {isRecording ? '停止錄製' : '匯出影片'}
              </button>
           </div>
        </div>

        {/* Dashboard */}
        <div className={`w-full lg:w-80 bg-slate-900 border-t lg:border-t-0 lg:border-l border-slate-800 flex flex-col overflow-y-auto transition-all duration-300 ${videoSource ? 'h-1/3 lg:h-full' : 'h-full'}`}>
           
           <div className="p-4 border-b border-slate-800">
             <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2">
               <BarChart2 size={14} /> 即時分析
             </h2>
             <div className="grid grid-cols-2 gap-3">
                <MetricCard label="軀幹傾斜" value={realtimeMetrics.torsoAngle.toFixed(1)} unit="°" />
                <MetricCard label="步幅" value={realtimeMetrics.stepLength.toFixed(0)} unit="cm" />
                <MetricCard 
                  label="左手" 
                  value={realtimeMetrics.handL} 
                  color={realtimeMetrics.handL === '張開' ? 'text-green-400' : 'text-yellow-400'}
                />
                <MetricCard 
                  label="右手" 
                  value={realtimeMetrics.handR} 
                  color={realtimeMetrics.handR === '張開' ? 'text-green-400' : 'text-yellow-400'}
                />
             </div>
           </div>

           <div className="p-4 flex-1">
             <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3">統計總覽</h2>
             <div className="space-y-4 text-sm">
               <StatRow label="總步數" val={displayStats.steps} unit="步" />
               <StatRow label="平均步幅" val={displayStats.avgStep.toFixed(1)} unit="cm" sub={`Max: ${displayStats.maxStep.toFixed(0)}`} />
               <div className="border-t border-slate-800 my-2 pt-2"></div>
               <StatRow label="軀幹角度 (Avg)" val={displayStats.avgTorso.toFixed(1)} unit="°" />
               <div className="flex justify-between text-xs text-slate-500 pl-2">
                 <span>Max: {displayStats.maxTorso.toFixed(1)}°</span>
                 <span>Min: {displayStats.minTorso.toFixed(1)}°</span>
               </div>
               <div className="border-t border-slate-800 my-2 pt-2"></div>
               <StatRow label="前擺臂 (Max)" val={displayStats.maxArmFwd.toFixed(1)} unit="°" />
               <StatRow label="後擺臂 (Max)" val={displayStats.maxArmBack.toFixed(1)} unit="°" />
               <div className="mt-4 bg-slate-800 p-3 rounded">
                 <div className="flex justify-between mb-1">
                   <span className="text-xs text-slate-400">握拳(黃) vs 張開(綠)</span>
                   <span className="text-xs font-bold text-yellow-400">{displayStats.handRatio.toFixed(0)}% 握拳</span>
                 </div>
                 <div className="w-full bg-slate-700 h-2 rounded-full overflow-hidden flex">
                   <div className="bg-yellow-500 h-full" style={{ width: `${displayStats.handRatio}%` }} />
                   <div className="bg-green-500 h-full" style={{ width: `${100 - displayStats.handRatio}%` }} />
                 </div>
               </div>
             </div>
           </div>
        </div>
      </div>
    </div>
  );
};

const MetricCard = ({ label, value, unit='', color = 'text-white' }) => (
  <div className="bg-slate-800 p-3 rounded border border-slate-700">
    <div className="text-xs text-slate-500 mb-1">{label}</div>
    <div className={`text-xl font-mono font-bold ${color}`}>
      {value}<span className="text-xs text-slate-400 ml-1">{unit}</span>
    </div>
  </div>
);

const StatRow = ({ label, val, unit, sub }) => (
  <div className="flex justify-between items-baseline">
    <span className="text-slate-400">{label}</span>
    <div className="text-right">
      <span className="font-mono font-bold text-white mr-1">{val}</span>
      <span className="text-xs text-slate-500">{unit}</span>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  </div>
);

export default NordicWalkingApp;