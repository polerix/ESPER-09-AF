/**
 * Orbitcam LDAF – Web Controller Logic
 *
 * Implements camera video streaming, tactile PTZ motion controls,
 * real-time Web Audio VU metering, pure-JS AI Face Auto-Tracking, and UVC hardware settings.
 */

(() => {
  'use strict';

  // ── State & Configuration ──────────────────────────────────────────
  const state = {
    connected: false,
    pan: 0,
    tilt: 0,
    stepSpeed: 3,
    activeMode: 'dpad', // 'dpad' | 'joystick'
    videoStream: null,
    audioStream: null,
    audioSource: null,
    audioContext: null,
    analyserNode: null,
    audioDeviceId: null,
    micGain: 3.8,
    audioMuted: false,
    crtActive: true,
    lastLockChirp: 0,
    faceTracking: false,
    faceDetector: null,
    picoClassifier: null,
    picoMemory: null,
    picoLoaded: false,
    trackingCadence: 180,
    trackingDeadzone: 0.15,
    lastTrackTime: 0,
    joystickActive: false,
    joystickCenter: { x: 0, y: 0 },
    joystickMaxRadius: 65,
    customPreset: null,
  };

  // ── DOM Elements ───────────────────────────────────────────────────
  const el = {
    statusChip: document.getElementById('device-status-chip'),
    statusLabel: document.getElementById('status-label'),
    panDisplay: document.getElementById('pan-display'),
    tiltDisplay: document.getElementById('tilt-display'),
    ledSelect: document.getElementById('led-mode-select'),
    btnRecalibrate: document.getElementById('btn-recalibrate'),
    btnToggleSettings: document.getElementById('btn-toggle-settings'),
    settingsDrawer: document.getElementById('settings-drawer'),
    settingsBackdrop: document.getElementById('settings-backdrop'),
    btnCloseDrawer: document.getElementById('btn-close-drawer'),
    btnResetSettings: document.getElementById('btn-reset-settings'),

    // Video & Viewport
    video: document.getElementById('webcam-video'),
    canvas: document.getElementById('overlay-canvas'),
    videoResBadge: document.getElementById('video-res-badge'),
    cameraSelect: document.getElementById('camera-select'),
    audioSelect: document.getElementById('audio-select'),
    resolutionSelect: document.getElementById('resolution-select'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    btnToggleCrt: document.getElementById('btn-toggle-crt'),
    crtOverlay: document.getElementById('crt-overlay'),
    viewportContainer: document.getElementById('viewport-container'),

    // Audio & Analogue Meter Elements
    btnToggleMic: document.getElementById('btn-toggle-mic'),
    micSwitchHandle: document.getElementById('mic-switch-handle'),
    analogueMeterCanvas: document.getElementById('analogue-meter-canvas'),
    vuPeakLed: document.getElementById('vu-peak-led'),
    vuFill: document.getElementById('vu-meter-fill'),
    vuPeak: document.getElementById('vu-meter-peak'),
    spectrumCanvas: document.getElementById('spectrum-canvas'),

    // Motion & D-Pad
    tabDpad: document.getElementById('tab-dpad'),
    tabJoystick: document.getElementById('tab-joystick'),
    dpadView: document.getElementById('dpad-view'),
    joystickView: document.getElementById('joystick-view'),
    dpadButtons: document.querySelectorAll('.dpad-btn'),
    btnCenter: document.getElementById('btn-center'),
    joystickBoundary: document.getElementById('joystick-boundary'),
    joystickThumb: document.getElementById('joystick-thumb'),

    // Speed & Presets
    stepSlider: document.getElementById('step-slider'),
    speedDisplay: document.getElementById('speed-display'),
    presetButtons: document.querySelectorAll('.preset-grid .preset-btn'),
    btnCustom1: document.getElementById('btn-custom-1'),

    // Vision & Tracking
    toggleFacetrack: document.getElementById('toggle-facetrack'),
    facetrackParams: document.getElementById('facetrack-params'),
    trackDeadzone: document.getElementById('track-deadzone'),
    trackInterval: document.getElementById('track-interval'),
    valDeadzone: document.getElementById('val-deadzone'),
    valCadence: document.getElementById('val-cadence'),
    trackingPill: document.getElementById('tracking-status-pill'),
    trackingText: document.getElementById('tracking-text'),
    trackingHud: document.getElementById('tracking-hud'),
    reticleBox: document.getElementById('reticle-box'),
  };

  // ── API Communication ──────────────────────────────────────────────

  async function apiPost(endpoint, data = {}) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return await resp.json();
    } catch (err) {
      console.warn(`API POST ${endpoint} failed:`, err);
      return { success: false, error: err.message };
    }
  }

  async function apiGet(endpoint) {
    try {
      const resp = await fetch(endpoint);
      return await resp.json();
    } catch (err) {
      console.warn(`API GET ${endpoint} failed:`, err);
      return null;
    }
  }

  // ── Serialized Motion Queue (Prevents USB packet collision) ─────────

  let isSendingMotion = false;
  let pendingMotion = null;

  async function sendPanTilt(pan, tilt, isExplicitDegrees = false) {
    if (pan === 0 && tilt === 0) return;

    let scaledPan = pan;
    let scaledTilt = tilt;

    if (!isExplicitDegrees) {
      // Distinct speed scaling (in degrees):
      // Speed 1 (Fine) = 2°
      // Speed 2 (Gentle) = 3°
      // Speed 3 (Normal) = 5°
      // Speed 4 (Medium) = 8°
      // Speed 5 (Brisk) = 12°
      // Speed 6 (Swift) = 16°
      // Speed 7 (Fast) = 20°
      // Speed 8 (Rapid) = 25°
      const speedDegrees = [2, 3, 5, 8, 12, 16, 20, 25];
      const degMultiplier = speedDegrees[Math.min(7, Math.max(0, state.stepSpeed - 1))] || 5;
      scaledPan = Math.round(pan * degMultiplier);
      scaledTilt = Math.round(tilt * degMultiplier);
    }

    // Update relative estimated angle display
    state.pan += scaledPan;
    state.tilt += scaledTilt;
    updatePositionHUD();

    if (isSendingMotion) {
      if (!pendingMotion) pendingMotion = { pan: 0, tilt: 0 };
      pendingMotion.pan += scaledPan;
      pendingMotion.tilt += scaledTilt;
      return;
    }

    isSendingMotion = true;
    try {
      await apiPost('/api/ptz', { pan: scaledPan, tilt: scaledTilt });
    } finally {
      isSendingMotion = false;
      if (pendingMotion) {
        const next = pendingMotion;
        pendingMotion = null;
        sendPanTilt(next.pan, next.tilt, true);
      }
    }
  }

  async function sendReset() {
    state.pan = 0;
    state.tilt = 0;
    updatePositionHUD();

    const res = await apiPost('/api/reset');
    if (res && res.success) {
      flashStatus('Motors Centered');
    }
  }

  function updatePositionHUD() {
    if (el.panDisplay) el.panDisplay.textContent = `${state.pan >= 0 ? '+' : ''}${state.pan}°`;
    if (el.tiltDisplay) el.tiltDisplay.textContent = `${state.tilt >= 0 ? '+' : ''}${state.tilt}°`;
  }

  function flashStatus(msg) {
    if (!el.statusLabel) return;
    const prev = el.statusLabel.textContent;
    el.statusLabel.textContent = msg.toUpperCase();
    setTimeout(() => {
      el.statusLabel.textContent = prev;
    }, 1800);
  }

  // ── Device Status Polling ──────────────────────────────────────────

  async function checkDeviceStatus() {
    const data = await apiGet('/api/status');
    if (data && data.connected) {
      state.connected = true;
      el.statusChip.classList.remove('disconnected');
      el.statusChip.classList.add('connected');
      el.statusLabel.textContent = 'ONLINE';
      if (data.led_mode && el.ledSelect) {
        el.ledSelect.value = data.led_mode;
      }
    } else {
      state.connected = false;
      el.statusChip.classList.remove('connected');
      el.statusChip.classList.add('disconnected');
      el.statusLabel.textContent = 'CAMERA DISCONNECTED';
    }
  }

  // ── Video & Camera Stream (AVFoundation / getUserMedia) ────────────

  async function initCamera() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');

      el.cameraSelect.innerHTML = '';
      if (videoDevices.length === 0) {
        el.cameraSelect.innerHTML = '<option value="">No cameras detected</option>';
        return;
      }

      let selectedId = '';
      videoDevices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Camera ${el.cameraSelect.children.length + 1}`;
        el.cameraSelect.appendChild(opt);

        // Prefer Orbit / USB Camera VID 1133 PID 2452
        const name = (d.label || '').toLowerCase();
        if (name.includes('orbit') || name.includes('quickcam') || name.includes('1133') || name.includes('2452') || name.includes('usb camera')) {
          selectedId = d.deviceId;
        }
      });

      if (!selectedId && videoDevices.length > 0) {
        selectedId = videoDevices[0].deviceId;
      }

      el.cameraSelect.value = selectedId;
      await startStream(selectedId);
    } catch (err) {
      console.error('Camera enumeration error:', err);
      el.statusLabel.textContent = 'PERM REQUIRED';
    }
  }

  async function startStream(deviceId) {
    if (state.videoStream) {
      state.videoStream.getTracks().forEach(t => t.stop());
    }

    const resChoice = el.resolutionSelect.value;
    let constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
      }
    };

    if (resChoice === '1600x1200') {
      constraints.video.width = { ideal: 1600 };
      constraints.video.height = { ideal: 1200 };
    } else if (resChoice === '1280x720') {
      constraints.video.width = { ideal: 1280 };
      constraints.video.height = { ideal: 720 };
    } else if (resChoice === '960x720') {
      constraints.video.width = { ideal: 960 };
      constraints.video.height = { ideal: 720 };
    } else if (resChoice === '640x480') {
      constraints.video.width = { ideal: 640 };
      constraints.video.height = { ideal: 480 };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.videoStream = stream;
      el.video.srcObject = stream;

      el.video.onloadedmetadata = () => {
        el.videoResBadge.textContent = `${el.video.videoWidth}x${el.video.videoHeight}`;
        resizeOverlayCanvas();
      };
    } catch (err) {
      console.warn('Could not start video stream with chosen constraints:', err);
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: true });
        state.videoStream = fallbackStream;
        el.video.srcObject = fallbackStream;
      } catch (fErr) {
        console.error('Total camera failure:', fErr);
      }
    }
  }

  function resizeOverlayCanvas() {
    if (!el.canvas || !el.video) return;
    el.canvas.width = el.video.clientWidth || el.video.videoWidth || 640;
    el.canvas.height = el.video.clientHeight || el.video.videoHeight || 480;
  }

  window.addEventListener('resize', resizeOverlayCanvas);

  // ── D'Arsonval Galvanometer Ballistic Meter Engine ──────────────────

  let meterAngle = -46;       // degrees (-48 to +48)
  let meterTargetAngle = -46; // target angle from signal level
  let meterVelocity = 0;      // 2nd-order ballistic velocity

  function drawAnalogueMeterFace(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);

    // Warm radial incandescent bulb glow background
    const bgGrad = ctx.createRadialGradient(w / 2, h + 10, 4, w / 2, h / 2, w / 1.1);
    bgGrad.addColorStop(0, '#fff6de');
    bgGrad.addColorStop(0.55, '#eee1c4');
    bgGrad.addColorStop(1, '#ded0af');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h - 6;
    const arcRadius = h * 0.74;

    // Scale arcs (-20 dB to +3 dB)
    const startRad = (-46 * Math.PI) / 180 - Math.PI / 2;
    const zeroRad  = ( 22 * Math.PI) / 180 - Math.PI / 2;
    const endRad   = ( 46 * Math.PI) / 180 - Math.PI / 2;

    // Black nominal arc (-20 to 0 dB)
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#1e242b';
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, startRad, zeroRad);
    ctx.stroke();

    // Red overload arc (0 to +3 dB)
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#dc2626';
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, zeroRad, endRad);
    ctx.stroke();

    // Scale tick marks and text
    const ticks = [
      { db: -20, deg: -45, label: '20' },
      { db: -10, deg: -27, label: '10' },
      { db:  -7, deg: -16, label: '7'  },
      { db:  -5, deg:  -7, label: '5'  },
      { db:  -3, deg:   3, label: '3'  },
      { db:  -1, deg:  14, label: '1'  },
      { db:   0, deg:  22, label: '0', isRed: true },
      { db:  +1, deg:  30, label: '1', isRed: true },
      { db:  +2, deg:  38, label: '2', isRed: true },
      { db:  +3, deg:  45, label: '3', isRed: true },
    ];

    ctx.font = '7px "Share Tech Mono", "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ticks.forEach(t => {
      const rad = (t.deg * Math.PI) / 180 - Math.PI / 2;
      const x1 = cx + Math.cos(rad) * (arcRadius - 1);
      const y1 = cy + Math.sin(rad) * (arcRadius - 1);
      const x2 = cx + Math.cos(rad) * (arcRadius - (t.isRed ? 7 : 5));
      const y2 = cy + Math.sin(rad) * (arcRadius - (t.isRed ? 7 : 5));

      ctx.strokeStyle = t.isRed ? '#dc2626' : '#1e242b';
      ctx.lineWidth = t.db === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      if (t.label) {
        const tx = cx + Math.cos(rad) * (arcRadius - 12);
        const ty = cy + Math.sin(rad) * (arcRadius - 12);
        ctx.fillStyle = t.isRed ? '#b91c1c' : '#2b323c';
        ctx.fillText(t.label, tx, ty);
      }
    });

    // Printed VU Label in classic italic serif
    ctx.font = 'italic bold 11px serif';
    ctx.fillStyle = '#2b323c';
    ctx.fillText('VU', cx - 18, cy - 26);

    ctx.font = 'bold 6px "Share Tech Mono", monospace';
    ctx.fillStyle = '#64748b';
    ctx.fillText('AUDIO LEVEL', cx + 18, cy - 26);
    ctx.fillText('- dB +', cx, cy - 36);
  }

  function drawNeedle(ctx, w, h, angleDeg) {
    const cx = w / 2;
    const cy = h - 6;
    const needleLength = h * 0.82;
    const rad = (angleDeg * Math.PI) / 180 - Math.PI / 2;

    const tipX = cx + Math.cos(rad) * needleLength;
    const tipY = cy + Math.sin(rad) * needleLength;

    // Needle drop shadow on the ivory faceplate
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.32)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 1.5;
    ctx.shadowOffsetY = 2;

    ctx.strokeStyle = '#14171c';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.restore();

    // Pivot cap in matte black with chrome center screw
    ctx.fillStyle = '#1e2329';
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 2, cy - 1);
    ctx.lineTo(cx + 2, cy + 1);
    ctx.stroke();
  }

  // Global user-gesture resume for Chromium / Brave Autoplay Policies
  function ensureAudioContextResumed() {
    if (state.audioContext && state.audioContext.state === 'suspended') {
      state.audioContext.resume().then(() => {
        console.log('AudioContext successfully resumed via user interaction');
      }).catch(err => {
        console.warn('AudioContext resume error:', err);
      });
    }
  }
  ['click', 'touchstart', 'keydown'].forEach(evt => {
    window.addEventListener(evt, ensureAudioContextResumed, { passive: true });
  });

  async function initAudio(preferredDeviceId = null) {
    try {
      // 1. Enumerate all audio input devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');

      if (el.audioSelect) {
        el.audioSelect.innerHTML = '';
        let matchedId = '';

        audioInputs.forEach((d, idx) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Microphone ${idx + 1}`;
          el.audioSelect.appendChild(opt);

          const name = (d.label || '').toLowerCase();
          // Detect Logitech Orbit AF USB mic / Burr-Brown USB audio
          if (name.includes('orbit') || name.includes('quickcam') || name.includes('unknown usb audio') || name.includes('codec') || name.includes('usb')) {
            matchedId = d.deviceId;
          }
        });

        if (preferredDeviceId) {
          el.audioSelect.value = preferredDeviceId;
        } else if (matchedId) {
          el.audioSelect.value = matchedId;
          preferredDeviceId = matchedId;
        } else if (audioInputs.length > 0) {
          preferredDeviceId = audioInputs[0].deviceId;
        }
      }

      // 2. Teardown existing stream/source if switching devices
      if (state.audioStream) {
        state.audioStream.getTracks().forEach(t => t.stop());
      }
      if (state.audioSource) {
        try { state.audioSource.disconnect(); } catch (e) {}
      }

      // 3. Acquire chosen microphone stream
      const constraints = {
        audio: preferredDeviceId ? { deviceId: { exact: preferredDeviceId } } : true
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.audioStream = stream;
      state.audioDeviceId = preferredDeviceId;

      // 4. Initialize Web Audio Context & Analyser
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!state.audioContext) {
        state.audioContext = new AudioCtx();
      }

      if (state.audioContext.state === 'suspended') {
        state.audioContext.resume().catch(() => {});
      }

      state.audioSource = state.audioContext.createMediaStreamSource(stream);
      const analyser = state.audioContext.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.45;
      state.audioSource.connect(analyser);
      state.analyserNode = analyser;

      state.audioMuted = false;
      if (el.btnToggleMic) el.btnToggleMic.classList.remove('muted');

      renderAudioMeters();
    } catch (err) {
      console.warn('Microphone access denied or unavailable:', err);
      if (el.btnToggleMic) el.btnToggleMic.style.opacity = '0.5';
    }
  }

  if (el.audioSelect) {
    el.audioSelect.addEventListener('change', (e) => {
      ensureAudioContextResumed();
      initAudio(e.target.value);
    });
  }

  // CRT Scanlines Toggle
  if (el.btnToggleCrt) {
    el.btnToggleCrt.addEventListener('click', () => {
      state.crtActive = !state.crtActive;
      el.btnToggleCrt.classList.toggle('active', state.crtActive);
      if (el.crtOverlay) el.crtOverlay.classList.toggle('active', state.crtActive);
    });
  }

  // ESPER Audio Chime for Target Lock
  function playEsperChirp() {
    const nowMs = Date.now();
    if (nowMs - state.lastLockChirp < 2500) return;
    state.lastLockChirp = nowMs;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!state.audioContext) state.audioContext = new AudioCtx();
      if (state.audioContext.state === 'suspended') return;

      const now = state.audioContext.currentTime;
      const osc = state.audioContext.createOscillator();
      const gain = state.audioContext.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1480, now);
      osc.frequency.setValueAtTime(2200, now + 0.035);

      gain.gain.setValueAtTime(0.035, now);
      gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.08);

      osc.connect(gain);
      gain.connect(state.audioContext.destination);

      osc.start(now);
      osc.stop(now + 0.09);
    } catch (e) {}
  }

  function renderAudioMeters() {
    if (!state.analyserNode) {
      requestAnimationFrame(renderAudioMeters);
      return;
    }

    // 1. Time-domain waveform analysis (RMS + Peak amplitude)
    const timeData = new Uint8Array(state.analyserNode.fftSize);
    state.analyserNode.getByteTimeDomainData(timeData);

    let sumSquares = 0;
    let maxAbs = 0;
    for (let i = 0; i < timeData.length; i++) {
      const val = (timeData[i] - 128) / 128.0;
      const abs = Math.abs(val);
      if (abs > maxAbs) maxAbs = abs;
      sumSquares += val * val;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);

    // Dynamic response: scale human speech (normal vocal range produces 25%..80%)
    const signal = Math.min(1.0, (rms * 0.75 + maxAbs * 0.25) * state.micGain);

    // D'Arsonval Ballistic Needle Physics Simulation
    if (!state.audioMuted && signal > 0.005 && state.audioContext && state.audioContext.state === 'running') {
      const targetDeg = -46 + Math.min(92, Math.pow(signal, 0.56) * 90);
      meterTargetAngle = targetDeg;
    } else {
      meterTargetAngle = -46;
    }

    // ANSI C16.5 Galvanometer spring-mass-damper equation
    const springForce = (meterTargetAngle - meterAngle) * 0.28;
    meterVelocity = (meterVelocity + springForce) * 0.70; // 1.5% ballistic overshoot
    meterAngle += meterVelocity;

    if (meterAngle < -48) { meterAngle = -48; meterVelocity = 0; }
    if (meterAngle > 48)  { meterAngle = 48;  meterVelocity = 0; }

    // Overload Ruby Peak LED
    if (el.vuPeakLed) {
      const ruby = el.vuPeakLed.querySelector('.led-ruby');
      if (ruby) {
        if (!state.audioMuted && meterAngle > 20) {
          ruby.classList.add('flash');
        } else {
          ruby.classList.remove('flash');
        }
      }
    }

    // Render Analogue Faceplate and Needle
    if (el.analogueMeterCanvas) {
      const ctx = el.analogueMeterCanvas.getContext('2d');
      const w = el.analogueMeterCanvas.width;
      const h = el.analogueMeterCanvas.height;
      drawAnalogueMeterFace(ctx, w, h);
      drawNeedle(ctx, w, h, meterAngle);
    }

    // 2. Frequency spectrum visualizer (CRT Phosphor Vector Scope)
    if (el.spectrumCanvas) {
      const freqData = new Uint8Array(state.analyserNode.frequencyBinCount);
      state.analyserNode.getByteFrequencyData(freqData);

      const ctx = el.spectrumCanvas.getContext('2d');
      const w = el.spectrumCanvas.width;
      const h = el.spectrumCanvas.height;
      ctx.clearRect(0, 0, w, h);

      if (!state.audioMuted) {
        const numBars = 14;
        const barW = Math.max(2, (w / numBars) - 1.5);
        let x = 0;

        for (let b = 0; b < numBars; b++) {
          const binIndex = Math.floor((b / numBars) * 22);
          const val = freqData[binIndex] || 0;
          const barHeight = Math.min(h, (val / 255) * h * 1.5);

          const grad = ctx.createLinearGradient(0, h, 0, 0);
          grad.addColorStop(0, '#15803d');
          grad.addColorStop(0.7, '#22c55e');
          grad.addColorStop(1, '#4ade80');
          ctx.fillStyle = grad;
          ctx.fillRect(x, h - barHeight, barW, barHeight);
          x += barW + 1.5;
        }
      }
    }

    requestAnimationFrame(renderAudioMeters);
  }

  el.btnToggleMic.addEventListener('click', async () => {
    ensureAudioContextResumed();
    if (!state.audioStream) {
      await initAudio(el.audioSelect?.value);
      return;
    }
    state.audioMuted = !state.audioMuted;
    state.audioStream.getAudioTracks().forEach(t => t.enabled = !state.audioMuted);
    el.btnToggleMic.classList.toggle('muted', state.audioMuted);
  });

  // ── Tactile D-Pad & Controls ───────────────────────────────────────

  let dpadInterval = null;

  el.dpadButtons.forEach(btn => {
    const pan = parseInt(btn.getAttribute('data-pan'), 10) || 0;
    const tilt = parseInt(btn.getAttribute('data-tilt'), 10) || 0;

    // Press & hold continuous movement with clean single-step on click
    const startMove = (e) => {
      e.preventDefault();
      btn.classList.add('active');
      sendPanTilt(pan, tilt);
      clearInterval(dpadInterval);
      dpadInterval = setInterval(() => {
        sendPanTilt(pan, tilt);
      }, 180);
    };

    const stopMove = () => {
      btn.classList.remove('active');
      clearInterval(dpadInterval);
      dpadInterval = null;
    };

    btn.addEventListener('mousedown', startMove);
    btn.addEventListener('mouseup', stopMove);
    btn.addEventListener('mouseleave', stopMove);
    btn.addEventListener('touchstart', startMove, { passive: false });
    btn.addEventListener('touchend', stopMove);
  });

  el.btnCenter.addEventListener('click', sendReset);
  el.btnRecalibrate.addEventListener('click', sendReset);

  // Mode switching (D-Pad vs Joystick)
  el.tabDpad.addEventListener('click', () => {
    state.activeMode = 'dpad';
    el.tabDpad.classList.add('active');
    el.tabJoystick.classList.remove('active');
    el.dpadView.style.display = 'flex';
    el.joystickView.style.display = 'none';
  });

  el.tabJoystick.addEventListener('click', () => {
    state.activeMode = 'joystick';
    el.tabJoystick.classList.add('active');
    el.tabDpad.classList.remove('active');
    el.dpadView.style.display = 'none';
    el.joystickView.style.display = 'flex';
  });

  // ── Virtual Analog Joystick ───────────────────────────────────────

  let joystickInterval = null;
  let joyVector = { x: 0, y: 0 };

  function setupJoystick() {
    const boundary = el.joystickBoundary;
    const thumb = el.joystickThumb;
    if (!boundary || !thumb) return;

    const onStart = (e) => {
      state.joystickActive = true;
      const rect = boundary.getBoundingClientRect();
      state.joystickCenter = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      onMove(e);

      clearInterval(joystickInterval);
      joystickInterval = setInterval(() => {
        if (state.joystickActive && (Math.abs(joyVector.x) > 0.15 || Math.abs(joyVector.y) > 0.15)) {
          const pan = Math.sign(joyVector.x) * (Math.abs(joyVector.x) > 0.5 ? 2 : 1);
          const tilt = Math.sign(-joyVector.y) * (Math.abs(joyVector.y) > 0.5 ? 2 : 1);
          sendPanTilt(pan, tilt);
        }
      }, 150);
    };

    const onMove = (e) => {
      if (!state.joystickActive) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      let dx = clientX - state.joystickCenter.x;
      let dy = clientY - state.joystickCenter.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > state.joystickMaxRadius) {
        dx = (dx / dist) * state.joystickMaxRadius;
        dy = (dy / dist) * state.joystickMaxRadius;
      }

      thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      joyVector = {
        x: dx / state.joystickMaxRadius,
        y: dy / state.joystickMaxRadius
      };
    };

    const onEnd = () => {
      state.joystickActive = false;
      joyVector = { x: 0, y: 0 };
      thumb.style.transform = `translate(-50%, -50%)`;
      clearInterval(joystickInterval);
    };

    boundary.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);

    boundary.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
  }

  setupJoystick();

  // ── Speed Slider ───────────────────────────────────────────────────

  el.stepSlider.addEventListener('input', (e) => {
    state.stepSpeed = parseInt(e.target.value, 10) || 3;
    let label = 'NORMAL (5°)';
    if (state.stepSpeed === 1) label = 'FINE (2°)';
    else if (state.stepSpeed === 2) label = 'GENTLE (3°)';
    else if (state.stepSpeed === 3) label = 'NORMAL (5°)';
    else if (state.stepSpeed === 4) label = 'MEDIUM (8°)';
    else if (state.stepSpeed === 5) label = 'BRISK (12°)';
    else if (state.stepSpeed === 6) label = 'SWIFT (16°)';
    else if (state.stepSpeed === 7) label = 'FAST (20°)';
    else if (state.stepSpeed === 8) label = 'RAPID (25°)';
    el.speedDisplay.textContent = `${state.stepSpeed}x ${label}`;
  });

  // ── Position Presets ───────────────────────────────────────────────

  el.presetButtons.forEach(btn => {
    if (btn.id === 'btn-custom-1') return;
    btn.addEventListener('click', async () => {
      const pan = parseInt(btn.getAttribute('data-pan'), 10) || 0;
      const tilt = parseInt(btn.getAttribute('data-tilt'), 10) || 0;
      if (pan === 0 && tilt === 0) {
        await sendReset();
      } else {
        await sendPanTilt(pan, tilt, true);
        const tag = btn.querySelector('.preset-tag')?.textContent || 'PRESET';
        flashStatus(`Preset: ${tag}`);
      }
    });
  });

  // Custom Preset (Long-press to save, Click to recall)
  let customPressTimer = null;
  el.btnCustom1.addEventListener('mousedown', () => {
    customPressTimer = setTimeout(() => {
      state.customPreset = { pan: state.pan, tilt: state.tilt };
      localStorage.setItem('orbitcam_preset_1', JSON.stringify(state.customPreset));
      flashStatus('Saved Preset P1');
    }, 800);
  });

  el.btnCustom1.addEventListener('mouseup', async () => {
    if (customPressTimer) {
      clearTimeout(customPressTimer);
      customPressTimer = null;
    }
    const saved = state.customPreset || JSON.parse(localStorage.getItem('orbitcam_preset_1') || 'null');
    if (saved) {
      const diffPan = saved.pan - state.pan;
      const diffTilt = saved.tilt - state.tilt;
      await sendPanTilt(diffPan, diffTilt, true);
      flashStatus('Recalled P1');
    } else {
      flashStatus('Hold to Save P1');
    }
  });

  // ── AI Face Auto-Tracking (Pico Real-Time Vision & Motor Control) ──

  let offCanvas = null;
  let offCtx = null;
  let smoothBox = null;
  let lastFaceSeen = 0;

  async function initFaceDetector() {
    if ('FaceDetector' in window) {
      try {
        state.faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
      } catch (err) {
        state.faceDetector = null;
      }
    }

    try {
      const resp = await fetch('/models/facefinder');
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        const bytes = new Int8Array(buf);
        if (window.pico && typeof window.pico.unpack_cascade === 'function') {
          state.picoClassifier = window.pico.unpack_cascade(bytes);
          state.picoMemory = window.pico.instantiate_detection_memory(5);
          state.picoLoaded = true;
          console.log('Pico AI face detector cascade loaded successfully');
        }
      }
    } catch (err) {
      console.warn('Fetch /models/facefinder failed:', err);
    }
  }

  function detectFacePico(video) {
    if (!state.picoClassifier) return null;

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    if (!vw || !vh) return null;

    // High-performance 640x480 working frame for sub-20ms pixel intensity analysis
    const targetW = 640;
    const targetH = 480;

    if (!offCanvas) {
      offCanvas = document.createElement('canvas');
      offCanvas.width = targetW;
      offCanvas.height = targetH;
      offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    }

    offCtx.drawImage(video, 0, 0, targetW, targetH);
    const imgData = offCtx.getImageData(0, 0, targetW, targetH);
    const rgba = imgData.data;

    // Convert to grayscale intensity buffer for Pico
    const gray = new Uint8Array(targetW * targetH);
    let minLum = 255;
    let maxLum = 0;

    for (let i = 0; i < gray.length; i++) {
      const idx = i * 4;
      const lum = (rgba[idx] * 299 + rgba[idx + 1] * 587 + rgba[idx + 2] * 114) / 1000;
      gray[i] = lum;
      if (i % 8 === 0) {
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }
    }

    // Dynamic contrast normalization (boosts facial contours against ambient room lighting)
    const lumRange = maxLum - minLum;
    if (lumRange > 25 && lumRange < 235) {
      const stretch = 255 / lumRange;
      for (let i = 0; i < gray.length; i++) {
        gray[i] = Math.max(0, Math.min(255, ((gray[i] - minLum) * stretch) | 0));
      }
    }

    const image = {
      pixels: gray,
      nrows: targetH,
      ncols: targetW,
      ldim: targetW
    };

    // Fine-tuned multi-scale detection parameters
    const params = {
      shiftfactor: 0.08,
      minsize: 50,
      maxsize: 400,
      scalefactor: 1.10
    };

    let dets = window.pico.run_cascade(image, state.picoClassifier, params);
    if (state.picoMemory) {
      dets = state.picoMemory(dets);
    }
    dets = window.pico.cluster_detections(dets, 0.2);
    // Hysteresis threshold: accept confident face candidates without dropping frames
    dets = dets.filter(d => d[3] > 0.22);

    if (dets.length === 0) {
      // Grace period: keep previous target position for 350ms to survive blinks/motor vibration
      if (smoothBox && (Date.now() - lastFaceSeen < 350)) {
        return smoothBox;
      }
      return null;
    }

    // Highest-scoring candidate
    const best = dets[0];
    const r = best[0]; // Row (center Y)
    const c = best[1]; // Col (center X)
    const s = best[2]; // Diameter size
    const score = best[3];

    // Scale from 640x480 coordinate space to video's natural dimensions
    const scaleX = vw / targetW;
    const scaleY = vh / targetH;

    const boxW = s * 0.95 * scaleX;
    const boxH = s * 1.18 * scaleY;
    const boxX = (c * scaleX) - (boxW / 2);
    const boxY = (r * scaleY) - (boxH / 2);

    const rawBox = {
      x: Math.max(0, Math.min(vw - boxW, boxX)),
      y: Math.max(0, Math.min(vh - boxH, boxY)),
      width: boxW,
      height: boxH,
      score: score
    };

    // Exponential moving average filter for silky smooth reticle
    if (!smoothBox) {
      smoothBox = rawBox;
    } else {
      const alpha = 0.35;
      smoothBox = {
        x: smoothBox.x * (1 - alpha) + rawBox.x * alpha,
        y: smoothBox.y * (1 - alpha) + rawBox.y * alpha,
        width: smoothBox.width * (1 - alpha) + rawBox.width * alpha,
        height: smoothBox.height * (1 - alpha) + rawBox.height * alpha,
        score: rawBox.score
      };
    }

    lastFaceSeen = Date.now();
    return smoothBox;
  }

  async function setupFaceTracking() {
    el.toggleFacetrack.addEventListener('change', (e) => {
      state.faceTracking = e.target.checked;
      el.facetrackParams.style.display = state.faceTracking ? 'flex' : 'none';
      if (state.faceTracking) {
        el.trackingPill.classList.add('active');
        el.trackingText.textContent = 'ESPER RESOLVER: ACTIVE';
        requestAnimationFrame(runFaceTrackingLoop);
      } else {
        el.trackingPill.classList.remove('active');
        el.trackingPill.classList.remove('locked');
        el.trackingText.textContent = 'ESPER TRACKING: OFF';
        smoothBox = null;
        if (el.canvas) {
          const ctx = el.canvas.getContext('2d');
          ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
        }
      }
    });

    el.trackDeadzone.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.trackingDeadzone = val / 100;
      el.valDeadzone.textContent = `${val}%`;
    });

    el.trackInterval.addEventListener('input', (e) => {
      state.trackingCadence = parseInt(e.target.value, 10);
      el.valCadence.textContent = `${state.trackingCadence}ms`;
    });
  }

  async function runFaceTrackingLoop() {
    if (!state.faceTracking) return;

    const now = Date.now();
    const vid = el.video;

    if (vid.readyState >= 2 && (now - state.lastTrackTime > state.trackingCadence)) {
      state.lastTrackTime = now;
      let detectedBox = null;

      // 1. Try native FaceDetector (if available in browser)
      if (state.faceDetector) {
        try {
          const faces = await state.faceDetector.detect(vid);
          if (faces && faces.length > 0) {
            detectedBox = faces[0].boundingBox;
          }
        } catch (err) {}
      }

      // 2. High-performance Pico detector
      if (!detectedBox && state.picoLoaded && vid.videoWidth > 0) {
        detectedBox = detectFacePico(vid);
      }

      // Check if face was lost recently
      if (!detectedBox && (now - lastFaceSeen > 900)) {
        smoothBox = null;
      }

      // Render HUD with lock state
      const isCentered = renderTrackingHUD(detectedBox || smoothBox);

      if (detectedBox && !isSendingMotion) {
        const frameW = vid.videoWidth || vid.clientWidth || 640;
        const frameH = vid.videoHeight || vid.clientHeight || 480;

        const faceCenterX = detectedBox.x + detectedBox.width / 2;
        const faceCenterY = detectedBox.y + detectedBox.height / 2;

        // Normalized offset: -1.0 (left/top) to +1.0 (right/bottom)
        const normX = (faceCenterX - (frameW / 2)) / (frameW / 2);
        const normY = (faceCenterY - (frameH / 2)) / (frameH / 2);

        let panStep = 0;
        let tiltStep = 0;

        if (Math.abs(normX) > state.trackingDeadzone) {
          // If face is to the right (normX > 0), camera pans right (+1)
          const mag = Math.abs(normX) > 0.42 ? 2 : 1;
          panStep = normX > 0 ? mag : -mag;
        }

        if (Math.abs(normY) > state.trackingDeadzone) {
          // If face is above center (normY < 0), camera tilts up (+1)
          // If face is below center (normY > 0), camera tilts down (-1)
          const mag = Math.abs(normY) > 0.42 ? 2 : 1;
          tiltStep = normY < 0 ? mag : -mag;
        }

        if (panStep !== 0 || tiltStep !== 0) {
          const dirPan = panStep !== 0 ? (panStep > 0 ? '▶' : '◀') : '';
          const dirTilt = tiltStep !== 0 ? (tiltStep > 0 ? '▲' : '▼') : '';
          el.trackingText.textContent = `ESPER SLEW ${dirPan}${dirTilt}`;
          sendPanTilt(panStep, tiltStep);
        } else {
          el.trackingText.textContent = 'ESPER LOCK // CENTERED';
          playEsperChirp();
        }
      } else if (!detectedBox) {
        el.trackingText.textContent = 'SCANNING SECTOR 09...';
      }
    }

    if (state.faceTracking) {
      requestAnimationFrame(runFaceTrackingLoop);
    }
  }

  // ── Blade Runner ESPER Optical Reticle Renderer ───────────────────

  function renderTrackingHUD(box) {
    if (!el.canvas) return false;
    const ctx = el.canvas.getContext('2d');
    const w = el.canvas.width;
    const h = el.canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!box || !state.faceTracking) {
      if (el.trackingPill) el.trackingPill.classList.remove('locked');
      return false;
    }

    const vidW = el.video.videoWidth || w;
    const vidH = el.video.videoHeight || h;
    const scaleX = w / vidW;
    const scaleY = h / vidH;

    const screenX = box.x * scaleX;
    const screenY = box.y * scaleY;
    const screenW = box.width * scaleX;
    const screenH = box.height * scaleY;

    // Check if face is centered within deadzone
    const faceCenterX = box.x + box.width / 2;
    const faceCenterY = box.y + box.height / 2;
    const normX = (faceCenterX - (vidW / 2)) / (vidW / 2);
    const normY = (faceCenterY - (vidH / 2)) / (vidH / 2);
    const isCentered = Math.abs(normX) <= state.trackingDeadzone && Math.abs(normY) <= state.trackingDeadzone;

    // Color palette: Phosphor green when locked, JVC broadcast teal when tracking
    const mainColor   = isCentered ? '#22c55e' : '#0d9488';
    const accentColor = isCentered ? '#4ade80' : '#2dd4bf';
    const glowColor   = isCentered ? 'rgba(34, 197, 94, 0.45)' : 'rgba(13, 148, 136, 0.4)';

    if (el.trackingPill) {
      if (isCentered) el.trackingPill.classList.add('locked');
      else el.trackingPill.classList.remove('locked');
    }

    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 6;

    // Outer Target Bounding Box (dashed with retro aesthetic)
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(screenX, screenY, screenW, screenH);
    ctx.setLineDash([]);

    // Blade Runner ESPER Corner Crop Brackets with millimeter hash ticks
    const cornerLen = Math.min(22, screenW * 0.24);
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2.5;

    // Helper to draw bracket with ticks
    function drawCorner(startX, startY, hDir, vDir) {
      ctx.beginPath();
      ctx.moveTo(startX + hDir * cornerLen, startY);
      ctx.lineTo(startX, startY);
      ctx.lineTo(startX, startY + vDir * cornerLen);
      ctx.stroke();

      // Tick marks on bracket arms
      ctx.lineWidth = 1;
      for (let t = 6; t < cornerLen; t += 6) {
        ctx.beginPath();
        ctx.moveTo(startX + hDir * t, startY - vDir * 2);
        ctx.lineTo(startX + hDir * t, startY + vDir * 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(startX - hDir * 2, startY + vDir * t);
        ctx.lineTo(startX + hDir * 2, startY + vDir * t);
        ctx.stroke();
      }
      ctx.lineWidth = 2.5;
    }

    drawCorner(screenX, screenY, 1, 1);                         // Top-Left
    drawCorner(screenX + screenW, screenY, -1, 1);              // Top-Right
    drawCorner(screenX, screenY + screenH, 1, -1);              // Bottom-Left
    drawCorner(screenX + screenW, screenY + screenH, -1, -1);   // Bottom-Right

    // Center Crosshairs with precision concentric ring
    const cx = screenX + screenW / 2;
    const cy = screenY + screenH / 2;

    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.2;

    // Center ring
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.stroke();

    // Cross lines
    ctx.beginPath();
    ctx.moveTo(cx - 14, cy); ctx.lineTo(cx - 7, cy);
    ctx.moveTo(cx + 7, cy);  ctx.lineTo(cx + 14, cy);
    ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy - 7);
    ctx.moveTo(cx, cy + 7);  ctx.lineTo(cx, cy + 14);
    ctx.stroke();

    // Center point
    ctx.fillStyle = accentColor;
    ctx.fillRect(cx - 1, cy - 1, 2, 2);

    // ESPER Technical Quadrant Telemetry Readout
    ctx.font = '10px "Share Tech Mono", "JetBrains Mono", monospace';
    ctx.fillStyle = mainColor;
    
    // Top tag
    const topText = isCentered 
      ? '● ESPER RESOLVE // LOCKED [SEC: 09-AF]' 
      : '▲ ESPER AUTO-SLEW // ACQUIRING';
    ctx.fillText(topText, screenX + 4, screenY - 8);

    // Bottom coordinates
    const deltaX = Math.round(normX * 100);
    const deltaY = Math.round(normY * 100);
    const bottomText = `ΔX:${deltaX >= 0 ? '+' : ''}${deltaX}% ΔY:${deltaY >= 0 ? '+' : ''}${deltaY}% | AZM:${state.pan}° ELEV:${state.tilt}°`;
    ctx.fillText(bottomText, screenX + 4, screenY + screenH + 14);

    // Quadrant label on top right
    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.fillStyle = accentColor;
    ctx.fillText('[Q-1]', screenX + screenW - 24, screenY - 8);

    ctx.restore();
    return isCentered;
  }

  setupFaceTracking();

  // ── Keyboard Shortcuts ─────────────────────────────────────────────

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    switch (e.key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        e.preventDefault();
        sendPanTilt(0, 1);
        break;
      case 'ArrowDown':
      case 's':
      case 'S':
        e.preventDefault();
        sendPanTilt(0, -1);
        break;
      case 'ArrowLeft':
      case 'a':
      case 'A':
        e.preventDefault();
        sendPanTilt(-1, 0);
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        e.preventDefault();
        sendPanTilt(1, 0);
        break;
      case 'h':
      case 'H':
      case ' ':
        e.preventDefault();
        sendReset();
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        el.btnToggleMic.click();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        el.btnFullscreen.click();
        break;
      default:
        if (e.key >= '1' && e.key <= '8') {
          el.stepSlider.value = e.key;
          el.stepSlider.dispatchEvent(new Event('input'));
        }
        break;
    }
  });

  // ── Settings Drawer & Image Adjustments ─────────────────────────────

  function setupSettingsDrawer() {
    el.btnToggleSettings.addEventListener('click', () => {
      el.settingsDrawer.classList.toggle('open');
      el.settingsBackdrop.classList.toggle('open');
      loadCameraSettings();
    });

    el.btnCloseDrawer.addEventListener('click', () => {
      el.settingsDrawer.classList.remove('open');
      el.settingsBackdrop.classList.remove('open');
    });

    el.settingsBackdrop.addEventListener('click', () => {
      el.settingsDrawer.classList.remove('open');
      el.settingsBackdrop.classList.remove('open');
    });

    const settingInputs = el.settingsDrawer.querySelectorAll('input[type="range"]');
    settingInputs.forEach(input => {
      const parent = input.closest('.setting-item');
      const name = parent.getAttribute('data-setting');
      const valLabel = parent.querySelector('.setting-value');

      input.addEventListener('input', (e) => {
        valLabel.textContent = e.target.value;
      });

      input.addEventListener('change', async (e) => {
        await apiPost('/api/setting', { name, value: parseInt(e.target.value, 10) });
      });
    });

    el.btnResetSettings.addEventListener('click', async () => {
      await apiPost('/api/settings/reset');
      flashStatus('Settings Reset');
      loadCameraSettings();
    });

    el.ledSelect.addEventListener('change', async (e) => {
      await apiPost('/api/led', { mode: e.target.value });
      flashStatus(`LED: ${e.target.value.toUpperCase()}`);
    });
  }

  async function loadCameraSettings() {
    const data = await apiGet('/api/settings');
    if (!data) return;

    for (const [name, info] of Object.entries(data)) {
      const item = el.settingsDrawer.querySelector(`.setting-item[data-setting="${name}"]`);
      if (item) {
        const slider = item.querySelector('input[type="range"]');
        const valSpan = item.querySelector('.setting-value');
        if (slider && info.value !== -1) {
          slider.min = info.min;
          slider.max = info.max;
          slider.value = info.value;
          if (valSpan) valSpan.textContent = info.value;
        }
      }
    }
  }

  setupSettingsDrawer();

  // ── Fullscreen Support ─────────────────────────────────────────────

  el.btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      el.viewportContainer.requestFullscreen().catch(err => {
        console.warn('Fullscreen error:', err);
      });
    } else {
      document.exitFullscreen();
    }
  });

  // ── Format / Camera Selectors ──────────────────────────────────────

  el.cameraSelect.addEventListener('change', (e) => {
    if (e.target.value) startStream(e.target.value);
  });

  el.resolutionSelect.addEventListener('change', () => {
    startStream(el.cameraSelect.value);
  });

  // ── Initialization Entrypoint ──────────────────────────────────────

  async function init() {
    await checkDeviceStatus();
    setInterval(checkDeviceStatus, 3000);
    await initCamera();
    await initAudio();
    await initFaceDetector();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
