const STORAGE_KEY = "kitchen-timer-state";
const CIRCUMFERENCE = 2 * Math.PI * 88; // ~553

// Polyfill for roundRect (not available in all browsers)
if (typeof CanvasRenderingContext2D !== "undefined" && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, radii) {
    let r;
    if (typeof radii === "number") {
      r = { tl: radii, tr: radii, br: radii, bl: radii };
    } else if (Array.isArray(radii)) {
      if (radii.length === 4) r = { tl: radii[0], tr: radii[1], br: radii[2], bl: radii[3] };
      else r = { tl: radii[0] || 0, tr: radii[0] || 0, br: radii[0] || 0, bl: radii[0] || 0 };
    } else {
      r = { tl: 0, tr: 0, br: 0, bl: 0 };
    }
    this.moveTo(x + r.tl, y);
    this.lineTo(x + w - r.tr, y);
    this.quadraticCurveTo(x + w, y, x + w, y + r.tr);
    this.lineTo(x + w, y + h - r.br);
    this.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
    this.lineTo(x + r.bl, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r.bl);
    this.lineTo(x, y + r.tl);
    this.quadraticCurveTo(x, y, x + r.tl, y);
    this.closePath();
    return this;
  };
}

// DOM elements
const timeDisplay = document.getElementById("timeDisplay");
const minutesInput = document.getElementById("minutesInput");
const startButton = document.getElementById("startButton");
const pauseButton = document.getElementById("pauseButton");
const resetButton = document.getElementById("resetButton");
const notifyToggle = document.getElementById("notifyToggle");
const presetButtons = document.querySelectorAll(".preset");
const ringFill = document.getElementById("ringFill");
const ringHandle = document.getElementById("ringHandle");
const ringContainer = document.getElementById("ringContainer");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const activityInput = document.getElementById("activityInput");
const illustrationContainer = document.getElementById("illustrationContainer");
const illustrationCanvas = document.getElementById("illustrationCanvas");
const activityPresetBtns = document.querySelectorAll(".activity-preset");
const soundThemeBtns = document.querySelectorAll(".sound-theme");
const themeBtns = document.querySelectorAll(".theme-btn");

const missing = [];
if (!timeDisplay) missing.push("timeDisplay");
if (!minutesInput) missing.push("minutesInput");
if (!startButton) missing.push("startButton");
if (!pauseButton) missing.push("pauseButton");
if (!resetButton) missing.push("resetButton");
if (!notifyToggle) missing.push("notifyToggle");
if (missing.length) {
  alert("Missing HTML elements: " + missing.join(", "));
  throw new Error("Missing HTML elements: " + missing.join(", "));
}

let audioContext;
let tickInterval;
let illustrationAnimFrame;

const defaultState = {
  mode: "idle",
  status: "stopped",
  remainingSeconds: 0,
  totalSeconds: 0,
  stopwatchElapsedSeconds: 0,
  countdownEndTimestamp: null,
  stopwatchStartTimestamp: null,
  notify: false,
  soundTheme: "chime",
  visualTheme: "dark",
  activity: "",
};

const state = Object.assign({}, defaultState);

// ─── Helper: resolve CSS variable to actual color ────────
const getAccentColor = () => {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#6ee7b7";
};

const getBgColor = () => {
  return getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0a0a0f";
};

// ─── Formatting ──────────────────────────────────────────
const formatTime = (totalSeconds) => {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);
  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

// ─── State persistence ───────────────────────────────────
const saveState = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

const loadState = () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    // Only copy known keys to avoid stale/corrupt data
    for (const key of Object.keys(defaultState)) {
      if (key in parsed) {
        state[key] = parsed[key];
      }
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
};

// ─── Display updates ─────────────────────────────────────
const updateDisplay = (seconds) => {
  timeDisplay.textContent = formatTime(seconds);
};

const updateButtons = () => {
  startButton.disabled = state.status === "running";
  pauseButton.textContent = state.status === "paused" ? "Resume" : "Pause";
};

const updateRing = (progress) => {
  const offset = CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, progress)));
  ringFill.setAttribute("stroke-dashoffset", offset);

  const angle = progress * 2 * Math.PI;
  const hx = 100 + 88 * Math.cos(angle - Math.PI / 2);
  const hy = 100 + 88 * Math.sin(angle - Math.PI / 2);
  ringHandle.setAttribute("cx", hx);
  ringHandle.setAttribute("cy", hy);
};

// ─── Color-changing background ───────────────────────────
const updateBackgroundColor = (progress) => {
  if (state.mode !== "countdown" || state.status !== "running") return;
  if (state.visualTheme !== "dark") return;

  const r = Math.round(10 + (1 - progress) * 60);
  const g = Math.round(10 + progress * 20 - (1 - progress) * 10);
  const b = Math.round(15 + progress * 30);
  document.body.style.background = `rgb(${r}, ${Math.max(0, g)}, ${b})`;
};

const resetBackground = () => {
  document.body.style.background = "";
};

// ─── Pulse animation ─────────────────────────────────────
const updatePulse = (remaining) => {
  if (state.mode === "countdown" && state.status === "running" && remaining <= 10 && remaining > 0) {
    timeDisplay.classList.add("pulse");
  } else {
    timeDisplay.classList.remove("pulse");
  }
};

// ─── Time calculations ───────────────────────────────────
const calculateRemainingSeconds = () => {
  if (!state.countdownEndTimestamp) return state.remainingSeconds;
  const diff = state.countdownEndTimestamp - Date.now();
  return Math.max(0, Math.floor((diff + 999) / 1000));
};

const calculateStopwatchElapsed = () => {
  if (!state.stopwatchStartTimestamp) return state.stopwatchElapsedSeconds;
  const diff = Date.now() - state.stopwatchStartTimestamp;
  return Math.max(0, Math.floor(diff / 1000));
};

// ─── Audio ───────────────────────────────────────────────
const warmAudio = () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") audioContext.resume();
};

const playSound = (theme) => {
  if (!audioContext) warmAudio();
  if (!audioContext) return;

  const t = audioContext.currentTime;

  if (theme === "chime") {
    [880, 1320].forEach((freq, i) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.3 - i * 0.1, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(t + i * 0.15);
      osc.stop(t + 1.5);
    });
  } else if (theme === "bell") {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 2);
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
    osc.connect(gain).connect(audioContext.destination);
    osc.start(t);
    osc.stop(t + 2.5);
  } else if (theme === "gong") {
    [130, 260, 390].forEach((freq, i) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = i === 0 ? "sine" : "triangle";
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.35 / (i + 1), t + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 3);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(t);
      osc.stop(t + 3);
    });
  } else if (theme === "arcade") {
    const notes = [523, 659, 784, 1047];
    notes.forEach((freq, i) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, t + i * 0.12);
      gain.gain.setValueAtTime(0.001, t + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.15, t + i * 0.12 + 0.01);
      gain.gain.linearRampToValueAtTime(0.0001, t + i * 0.12 + 0.2);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(t + i * 0.12);
      osc.stop(t + i * 0.12 + 0.25);
    });
  }
};

// ─── Confetti ────────────────────────────────────────────
const launchConfetti = () => {
  const container = document.createElement("div");
  container.className = "confetti-container";
  document.body.appendChild(container);

  const colors = ["#ff6b6b", "#ffd93d", "#6ee7b7", "#74b9ff", "#a29bfe", "#fd79a8", "#fdcb6e", "#00cec9"];

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "%";
    piece.style.animationDelay = Math.random() * 0.8 + "s";
    piece.style.animationDuration = (2 + Math.random() * 2) + "s";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
    piece.style.width = (6 + Math.random() * 8) + "px";
    piece.style.height = (6 + Math.random() * 8) + "px";
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 4000);
};

const showTimesUp = () => {
  const banner = document.createElement("div");
  banner.className = "times-up";
  const activity = state.activity.trim();
  banner.textContent = activity ? `${activity} done!` : "Time's up!";
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 2500);
};

// ─── Alert ───────────────────────────────────────────────
const triggerAlert = () => {
  playSound(state.soundTheme);
  launchConfetti();
  showTimesUp();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);

  if (state.notify && "Notification" in window) {
    const activity = state.activity.trim();
    const body = activity ? `${activity} is done! Stopwatch started.` : "Countdown finished. Stopwatch started.";
    if (Notification.permission === "granted") {
      new Notification("Timer done", { body });
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") {
          new Notification("Timer done", { body });
        }
      });
    }
  }
};

// ─── Timer transitions ──────────────────────────────────
const transitionToStopwatch = () => {
  triggerAlert();
  const now = Date.now();
  const elapsed = state.countdownEndTimestamp ? Math.max(0, Math.floor((now - state.countdownEndTimestamp) / 1000)) : 0;

  state.mode = "stopwatch";
  state.status = "running";
  state.stopwatchElapsedSeconds = elapsed;
  state.stopwatchStartTimestamp = now - elapsed * 1000;
  state.countdownEndTimestamp = null;

  updateDisplay(state.stopwatchElapsedSeconds);
  updateButtons();
  updateRing(0);
  resetBackground();
  timeDisplay.classList.remove("pulse");
  saveState();
};

const startCountdown = (minutes) => {
  state.mode = "countdown";
  state.status = "running";
  state.remainingSeconds = minutes * 60;
  state.totalSeconds = minutes * 60;
  state.countdownEndTimestamp = Date.now() + state.remainingSeconds * 1000;
  state.stopwatchElapsedSeconds = 0;
  state.stopwatchStartTimestamp = null;

  updateDisplay(state.remainingSeconds);
  updateRing(1);
  ringHandle.style.display = "none";
  updateButtons();
  saveState();
};

const startStopwatch = () => {
  state.mode = "stopwatch";
  state.status = "running";
  state.stopwatchStartTimestamp = Date.now() - state.stopwatchElapsedSeconds * 1000;
  updateButtons();
  saveState();
};

// ─── Handlers ────────────────────────────────────────────
const handleStart = () => {
  warmAudio();
  if (state.status === "running") return;

  if (state.mode === "stopwatch") return startStopwatch();

  const minutes = Number.parseInt(minutesInput.value, 10);
  if (Number.isNaN(minutes) || minutes <= 0) return;

  startCountdown(minutes);
};

const handlePauseResume = () => {
  if (state.status === "stopped") return;

  if (state.status === "running") {
    if (state.mode === "countdown") {
      state.remainingSeconds = calculateRemainingSeconds();
      state.countdownEndTimestamp = null;
    } else {
      state.stopwatchElapsedSeconds = calculateStopwatchElapsed();
      state.stopwatchStartTimestamp = null;
    }
    state.status = "paused";
  } else {
    state.status = "running";
    if (state.mode === "countdown") {
      state.countdownEndTimestamp = Date.now() + state.remainingSeconds * 1000;
    } else {
      state.stopwatchStartTimestamp = Date.now() - state.stopwatchElapsedSeconds * 1000;
    }
  }

  updateButtons();
  saveState();
};

const handleReset = () => {
  state.mode = "idle";
  state.status = "stopped";
  state.remainingSeconds = 0;
  state.totalSeconds = 0;
  state.stopwatchElapsedSeconds = 0;
  state.countdownEndTimestamp = null;
  state.stopwatchStartTimestamp = null;

  updateDisplay(0);
  updateButtons();
  updateRing(0);
  resetBackground();
  timeDisplay.classList.remove("pulse");
  ringHandle.style.display = "none";
  saveState();
};

const handleTick = () => {
  if (state.status !== "running") return;

  if (state.mode === "countdown") {
    const remaining = calculateRemainingSeconds();
    state.remainingSeconds = remaining;
    updateDisplay(remaining);

    const progress = state.totalSeconds > 0 ? remaining / state.totalSeconds : 0;
    updateRing(progress);
    updateBackgroundColor(progress);
    updatePulse(remaining);

    if (remaining <= 0) return transitionToStopwatch();
  } else if (state.mode === "stopwatch") {
    const elapsed = calculateStopwatchElapsed();
    state.stopwatchElapsedSeconds = elapsed;
    updateDisplay(elapsed);
  }

  saveState();
};

const applyPreset = (minutes) => {
  minutesInput.value = minutes;
  state.remainingSeconds = minutes * 60;
  state.totalSeconds = minutes * 60;
  state.mode = "countdown";
  state.status = "stopped";
  state.countdownEndTimestamp = null;

  updateDisplay(state.remainingSeconds);
  updateRing(1);
  ringHandle.style.display = "none";
  updateButtons();
  saveState();
};

// ─── Event listeners (registered early so they always work) ──
startButton.addEventListener("click", handleStart);
pauseButton.addEventListener("click", handlePauseResume);
resetButton.addEventListener("click", handleReset);

notifyToggle.addEventListener("change", () => {
  state.notify = notifyToggle.checked;
  if (state.notify && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  saveState();
});

presetButtons.forEach((button) => {
  button.addEventListener("click", () => applyPreset(Number(button.dataset.minutes)));
});

// ─── Drag-to-set on ring ─────────────────────────────────
let isDragging = false;
const MAX_DRAG_MINUTES = 60;

const getAngleFromEvent = (e) => {
  const rect = ringContainer.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  let angle = Math.atan2(clientY - cy, clientX - cx) + Math.PI / 2;
  if (angle < 0) angle += 2 * Math.PI;
  return angle;
};

const setTimeFromAngle = (angle) => {
  const fraction = angle / (2 * Math.PI);
  const minutes = Math.max(1, Math.round(fraction * MAX_DRAG_MINUTES));
  minutesInput.value = minutes;
  state.remainingSeconds = minutes * 60;
  state.totalSeconds = minutes * 60;
  state.mode = "countdown";
  state.status = "stopped";
  state.countdownEndTimestamp = null;

  updateDisplay(state.remainingSeconds);
  updateRing(1);

  const hx = 100 + 88 * Math.cos(angle - Math.PI / 2);
  const hy = 100 + 88 * Math.sin(angle - Math.PI / 2);
  ringHandle.setAttribute("cx", hx);
  ringHandle.setAttribute("cy", hy);
  ringHandle.style.display = "";

  updateButtons();
};

const onDragStart = (e) => {
  if (state.status === "running") return;
  isDragging = true;
  ringHandle.style.display = "";
  const angle = getAngleFromEvent(e);
  setTimeFromAngle(angle);
  e.preventDefault();
};

const onDragMove = (e) => {
  if (!isDragging) return;
  const angle = getAngleFromEvent(e);
  setTimeFromAngle(angle);
  e.preventDefault();
};

const onDragEnd = () => {
  if (!isDragging) return;
  isDragging = false;
  saveState();
};

ringContainer.addEventListener("mousedown", onDragStart);
ringContainer.addEventListener("touchstart", onDragStart, { passive: false });
document.addEventListener("mousemove", onDragMove);
document.addEventListener("touchmove", onDragMove, { passive: false });
document.addEventListener("mouseup", onDragEnd);
document.addEventListener("touchend", onDragEnd);

// ─── Keyboard shortcuts ──────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

  if (e.code === "Space") {
    e.preventDefault();
    if (state.status === "running" || state.status === "paused") {
      handlePauseResume();
    } else {
      handleStart();
    }
  } else if (e.code === "KeyR" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    handleReset();
  } else if (e.code === "KeyF" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.metaKey) {
    const presetMap = { "1": 1, "2": 5, "3": 10, "4": 15, "5": 20, "6": 30 };
    const minutes = presetMap[e.key];
    if (minutes && state.status !== "running") {
      e.preventDefault();
      applyPreset(minutes);
    }
  }
});

// ─── Fullscreen ──────────────────────────────────────────
const toggleFullscreen = () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
};

fullscreenBtn.addEventListener("click", toggleFullscreen);

// ─── Sound themes ────────────────────────────────────────
soundThemeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    soundThemeBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.soundTheme = btn.dataset.sound;
    warmAudio();
    playSound(state.soundTheme);
    saveState();
  });
});

// ─── Visual themes ───────────────────────────────────────
const applyTheme = (theme) => {
  document.body.className = "";
  if (theme !== "dark") {
    document.body.classList.add("theme-" + theme);
  }
  resetBackground();
};

themeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    themeBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.visualTheme = btn.dataset.theme;
    applyTheme(state.visualTheme);
    saveState();
  });
});

// ─── Activity & Illustrations ────────────────────────────
const ctx = illustrationCanvas ? illustrationCanvas.getContext("2d") : null;

const knownActivities = {
  pizza: true,
  laundry: true,
  eggs: true,
  tea: true,
  workout: true,
  nap: true,
};

const detectActivity = (text) => {
  const lower = text.toLowerCase().trim();
  for (const key of Object.keys(knownActivities)) {
    if (lower.includes(key)) return key;
  }
  if (lower.includes("cook") || lower.includes("bak") || lower.includes("oven") || lower.includes("roast")) return "pizza";
  if (lower.includes("wash") || lower.includes("cloth") || lower.includes("dryer") || lower.includes("spin")) return "laundry";
  if (lower.includes("boil") || lower.includes("egg")) return "eggs";
  if (lower.includes("coffee") || lower.includes("brew") || lower.includes("steep")) return "tea";
  if (lower.includes("exercise") || lower.includes("run") || lower.includes("plank") || lower.includes("gym")) return "workout";
  if (lower.includes("sleep") || lower.includes("rest") || lower.includes("break")) return "nap";
  return null;
};

const updateActivity = () => {
  const text = activityInput.value.trim();
  state.activity = text;
  const detected = detectActivity(text);

  if (detected && illustrationContainer) {
    illustrationContainer.style.display = "";
    startIllustration(detected);
  } else if (illustrationContainer) {
    illustrationContainer.style.display = "none";
    stopIllustration();
  }
  saveState();
};

activityInput.addEventListener("input", updateActivity);

activityPresetBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const activity = btn.dataset.activity;
    activityInput.value = activity.charAt(0).toUpperCase() + activity.slice(1);
    updateActivity();
  });
});

// ─── Canvas Illustrations ────────────────────────────────
let currentIllustration = null;
let illustrationStartTime = 0;

const stopIllustration = () => {
  currentIllustration = null;
  if (illustrationAnimFrame) {
    cancelAnimationFrame(illustrationAnimFrame);
    illustrationAnimFrame = null;
  }
};

const startIllustration = (type) => {
  currentIllustration = type;
  illustrationStartTime = Date.now();
  if (!illustrationAnimFrame) {
    drawIllustration();
  }
};

const getTimerProgress = () => {
  if (state.mode === "countdown" && state.totalSeconds > 0) {
    return 1 - (state.remainingSeconds / state.totalSeconds);
  }
  return 0;
};

const drawIllustration = () => {
  if (!ctx || !currentIllustration) return;

  try {
    const W = 180, H = 180;
    ctx.clearRect(0, 0, W, H);

    const progress = getTimerProgress();
    const t = (Date.now() - illustrationStartTime) / 1000;

    switch (currentIllustration) {
      case "pizza": drawPizza(progress, t); break;
      case "laundry": drawLaundry(progress, t); break;
      case "eggs": drawEggs(progress, t); break;
      case "tea": drawTea(progress, t); break;
      case "workout": drawWorkout(progress, t); break;
      case "nap": drawNap(progress, t); break;
    }
  } catch (e) {
    // Don't let illustration errors break the app
  }

  illustrationAnimFrame = requestAnimationFrame(drawIllustration);
};

// --- Pizza illustration ---
const drawPizza = (progress, t) => {
  const cx = 90, cy = 100;
  const r = 55;

  // Oven background
  ctx.fillStyle = "#3d2b1f";
  ctx.beginPath();
  ctx.roundRect(15, 10, 150, 160, 12);
  ctx.fill();

  // Inner oven
  ctx.fillStyle = "#1a0f0a";
  ctx.beginPath();
  ctx.roundRect(25, 20, 130, 120, 8);
  ctx.fill();

  // Oven glow based on progress
  const glowIntensity = 0.15 + progress * 0.35;
  ctx.fillStyle = `rgba(255, ${Math.round(120 - progress * 60)}, 0, ${glowIntensity})`;
  ctx.beginPath();
  ctx.roundRect(25, 20, 130, 120, 8);
  ctx.fill();

  // Pizza base
  const baseR = 200 + Math.floor(progress * 40);
  const baseG = 180 - Math.floor(progress * 80);
  const baseB = 100 - Math.floor(progress * 60);
  ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Sauce
  ctx.fillStyle = `rgb(${180 + Math.floor(progress * 40)}, ${40 + Math.floor(progress * 15)}, 20)`;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 8, 0, Math.PI * 2);
  ctx.fill();

  // Cheese
  const cheeseAlpha = 0.6 + progress * 0.4;
  ctx.fillStyle = `rgba(${255 - Math.floor(progress * 30)}, ${200 - Math.floor(progress * 30)}, ${60 + Math.floor(progress * 20)}, ${cheeseAlpha})`;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 12, 0, Math.PI * 2);
  ctx.fill();

  // Cheese bubbles
  const bubbleCount = Math.floor(progress * 8);
  for (let i = 0; i < bubbleCount; i++) {
    const angle = (i / 8) * Math.PI * 2 + t * 0.3;
    const dist = 15 + (i % 3) * 10;
    const bx = cx + Math.cos(angle) * dist;
    const by = cy + Math.sin(angle) * dist;
    const br = 3 + Math.sin(t * 2 + i) * 1.5;
    ctx.fillStyle = `rgba(255, 180, 0, ${0.4 + Math.sin(t * 3 + i) * 0.2})`;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pepperoni
  const pepPositions = [[-18, -15], [15, -10], [0, 18], [-12, 12], [18, 12]];
  pepPositions.forEach(([ox, oy]) => {
    const pepR = Math.min(150 + progress * 60, 200);
    const pepG = Math.min(30 + progress * 20, 60);
    ctx.fillStyle = `rgb(${pepR}, ${pepG}, 20)`;
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, 6, 0, Math.PI * 2);
    ctx.fill();

    if (progress > 0.6) {
      ctx.strokeStyle = `rgba(80, 20, 0, ${(progress - 0.6) * 2})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });

  // Steam
  if (progress > 0.2) {
    const steamAlpha = (progress - 0.2) * 0.5;
    for (let i = 0; i < 3; i++) {
      const sx = cx - 15 + i * 15;
      const sway = Math.sin(t * 2 + i * 1.5) * 5;
      ctx.strokeStyle = `rgba(255, 255, 255, ${steamAlpha * (0.5 + Math.sin(t + i) * 0.3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, cy - r - 2);
      ctx.quadraticCurveTo(sx + sway, cy - r - 18, sx - sway * 0.5, cy - r - 32);
      ctx.stroke();
    }
  }

  // Oven door handle
  ctx.fillStyle = "#8b7355";
  ctx.beginPath();
  ctx.roundRect(55, 145, 70, 12, 4);
  ctx.fill();
  ctx.fillStyle = "#a08060";
  ctx.beginPath();
  ctx.roundRect(60, 147, 60, 8, 3);
  ctx.fill();
};

// --- Laundry illustration ---
const drawLaundry = (progress, t) => {
  const cx = 90, cy = 90;

  // Washing machine body
  ctx.fillStyle = "#e8e8e8";
  ctx.beginPath();
  ctx.roundRect(20, 15, 140, 150, 14);
  ctx.fill();

  // Top panel
  ctx.fillStyle = "#d0d0d0";
  ctx.fillRect(20, 15, 140, 30);

  // Control knobs
  ctx.fillStyle = "#888";
  ctx.beginPath();
  ctx.arc(50, 30, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#999";
  ctx.beginPath();
  ctx.arc(50, 30, 5, 0, Math.PI * 2);
  ctx.fill();

  // Power light
  const lightColor = state.status === "running" ? "#4ade80" : "#666";
  ctx.fillStyle = lightColor;
  ctx.beginPath();
  ctx.arc(130, 30, 4, 0, Math.PI * 2);
  ctx.fill();

  // Window circle (door)
  ctx.fillStyle = "#1a3a5c";
  ctx.beginPath();
  ctx.arc(cx, cy + 15, 45, 0, Math.PI * 2);
  ctx.fill();

  // Glass effect
  const grad = ctx.createRadialGradient(cx - 10, cy + 5, 5, cx, cy + 15, 45);
  grad.addColorStop(0, "rgba(100, 180, 255, 0.15)");
  grad.addColorStop(1, "rgba(20, 50, 80, 0.3)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy + 15, 44, 0, Math.PI * 2);
  ctx.fill();

  // Water level
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy + 15, 42, 0, Math.PI * 2);
  ctx.clip();

  const waterLevel = cy + 15 + 20 - progress * 10;
  ctx.fillStyle = "rgba(100, 180, 255, 0.3)";
  ctx.beginPath();
  ctx.moveTo(cx - 45, waterLevel);
  for (let x = cx - 45; x <= cx + 45; x++) {
    const wave = Math.sin((x - cx) * 0.1 + t * 4) * 3;
    ctx.lineTo(x, waterLevel + wave);
  }
  ctx.lineTo(cx + 45, cy + 65);
  ctx.lineTo(cx - 45, cy + 65);
  ctx.closePath();
  ctx.fill();

  // Spinning clothes
  const spinSpeed = state.status === "running" ? 3 + progress * 4 : 0;
  const clothColors = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6"];
  clothColors.forEach((color, i) => {
    const angle = (i / clothColors.length) * Math.PI * 2 + t * spinSpeed;
    const dist = 22 + Math.sin(t * 2 + i) * 5;
    const clothX = cx + Math.cos(angle) * dist;
    const clothY = (cy + 15) + Math.sin(angle) * dist;
    ctx.fillStyle = color;
    ctx.beginPath();
    const size = 8 + Math.sin(t * 3 + i * 2) * 2;
    ctx.ellipse(clothX, clothY, size, size * 0.7, angle, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.restore();

  // Window rim
  ctx.strokeStyle = "#bbb";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy + 15, 46, 0, Math.PI * 2);
  ctx.stroke();

  // Glass shine
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx - 12, cy + 5, 20, -0.8, 0.3);
  ctx.stroke();

  // Suds/bubbles
  if (progress > 0.1 && progress < 0.9) {
    for (let i = 0; i < 5; i++) {
      const bx = cx - 20 + i * 10 + Math.sin(t + i) * 3;
      const by = waterLevel - 5 + Math.cos(t * 1.5 + i) * 4;
      const br = 3 + Math.sin(t * 2 + i) * 1;
      ctx.fillStyle = `rgba(255, 255, 255, ${0.3 + Math.sin(t + i) * 0.15})`;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

// --- Eggs illustration ---
const drawEggs = (progress, t) => {
  const cx = 90, cy = 100;

  // Pot
  ctx.fillStyle = "#777";
  ctx.beginPath();
  ctx.roundRect(30, 60, 120, 90, [0, 0, 12, 12]);
  ctx.fill();

  // Pot inner
  ctx.fillStyle = "#555";
  ctx.beginPath();
  ctx.ellipse(cx, 65, 58, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  // Water
  ctx.fillStyle = "rgba(120, 200, 255, 0.5)";
  ctx.beginPath();
  ctx.ellipse(cx, 68, 55, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(120, 200, 255, 0.4)";
  ctx.fillRect(35, 68, 110, 70);

  // Bubbles
  const bubbleCount = Math.floor(2 + progress * 12);
  for (let i = 0; i < bubbleCount; i++) {
    const bx = 50 + (i * 37) % 80;
    const by = 90 + Math.sin(t * 3 + i * 1.7) * 15 - (t * 20 + i * 30) % 50;
    const br = 2 + Math.sin(t + i) * 1.5;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.2 + Math.sin(t * 2 + i) * 0.15})`;
    ctx.beginPath();
    ctx.arc(bx, Math.max(by, 70), br, 0, Math.PI * 2);
    ctx.fill();
  }

  // Eggs
  const eggPositions = [[-20, 5], [0, 8], [20, 3]];
  eggPositions.forEach(([ox, oy]) => {
    const eggR = 255 - Math.floor(progress * 20);
    const eggG = 250 - Math.floor(progress * 25);
    const eggB = 240 - Math.floor(progress * 30);
    ctx.fillStyle = `rgb(${eggR}, ${eggG}, ${eggB})`;
    ctx.beginPath();
    ctx.ellipse(cx + ox, cy + oy + 15, 12, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.1)";
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Steam
  if (progress > 0.15) {
    const steamAlpha = Math.min((progress - 0.15) * 0.6, 0.4);
    for (let i = 0; i < 4; i++) {
      const sx = cx - 25 + i * 18;
      const sway = Math.sin(t * 2.5 + i * 1.2) * 6;
      ctx.strokeStyle = `rgba(255, 255, 255, ${steamAlpha * (0.4 + Math.sin(t * 1.5 + i) * 0.3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, 58);
      ctx.quadraticCurveTo(sx + sway, 38, sx - sway * 0.5, 18);
      ctx.stroke();
    }
  }

  // Pot handles
  ctx.fillStyle = "#444";
  ctx.beginPath();
  ctx.roundRect(15, 85, 18, 10, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(147, 85, 18, 10, 4);
  ctx.fill();

  // Stove top indicator
  const stoveColor = progress > 0 ? `rgba(255, ${Math.round(100 - progress * 80)}, 0, ${0.4 + progress * 0.4})` : "rgba(100,100,100,0.3)";
  ctx.strokeStyle = stoveColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, 165, 20, 0, Math.PI * 2);
  ctx.stroke();
};

// --- Tea illustration ---
const drawTea = (progress, t) => {
  const cx = 90, cy = 105;

  // Saucer
  ctx.fillStyle = "#e8e0d0";
  ctx.beginPath();
  ctx.ellipse(cx, cy + 40, 50, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  // Cup body
  ctx.fillStyle = "#f5f0e8";
  ctx.beginPath();
  ctx.moveTo(cx - 35, cy - 20);
  ctx.lineTo(cx - 30, cy + 35);
  ctx.quadraticCurveTo(cx, cy + 42, cx + 30, cy + 35);
  ctx.lineTo(cx + 35, cy - 20);
  ctx.closePath();
  ctx.fill();

  // Cup handle
  ctx.strokeStyle = "#f5f0e8";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx + 42, cy + 8, 14, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();

  // Tea liquid
  const teaR = 200 - Math.floor(progress * 80);
  const teaG = 160 - Math.floor(progress * 70);
  const teaB = 80 - Math.floor(progress * 40);
  ctx.fillStyle = `rgb(${teaR}, ${teaG}, ${Math.max(20, teaB)})`;
  ctx.beginPath();
  ctx.moveTo(cx - 33, cy - 15);
  ctx.lineTo(cx - 30, cy + 33);
  ctx.quadraticCurveTo(cx, cy + 40, cx + 30, cy + 33);
  ctx.lineTo(cx + 33, cy - 15);
  ctx.closePath();
  ctx.fill();

  // Tea bag string
  ctx.strokeStyle = "#b8a080";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 5, cy - 20);
  ctx.quadraticCurveTo(cx - 10, cy - 30, cx - 20, cy - 28);
  ctx.stroke();

  // Tea bag tag
  ctx.fillStyle = "#d4c4a8";
  ctx.fillRect(cx - 26, cy - 33, 12, 10);

  // Tea bag in water
  const bobY = Math.sin(t * 1.5) * 2;
  ctx.fillStyle = "#b8a080";
  ctx.beginPath();
  ctx.roundRect(cx - 12, cy + bobY, 14, 20, 3);
  ctx.fill();

  // Steeping color diffusion
  if (progress > 0 && progress < 0.8) {
    const diffAlpha = 0.15 + progress * 0.15;
    const diffGrad = ctx.createRadialGradient(cx - 5, cy + bobY + 10, 2, cx - 5, cy + bobY + 10, 30 + progress * 20);
    diffGrad.addColorStop(0, `rgba(${Math.round(150 - progress * 50)}, ${Math.round(100 - progress * 40)}, 30, ${diffAlpha})`);
    diffGrad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = diffGrad;
    ctx.fillRect(cx - 33, cy - 15, 66, 50);
  }

  // Steam
  const steamAlpha = 0.2 + progress * 0.2;
  for (let i = 0; i < 3; i++) {
    const sx = cx - 12 + i * 12;
    const sway = Math.sin(t * 2 + i * 1.3) * 5;
    ctx.strokeStyle = `rgba(200, 200, 200, ${steamAlpha * (0.4 + Math.sin(t + i) * 0.3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, cy - 22);
    ctx.quadraticCurveTo(sx + sway, cy - 40, sx - sway * 0.5, cy - 55);
    ctx.stroke();
  }
};

// --- Workout illustration ---
const drawWorkout = (progress, t) => {
  const cx = 90, cy = 90;
  const accent = getAccentColor();

  // Floor
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(10, 145, 160, 3);

  const bounce = Math.sin(t * 4) * 5;

  // Head
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  const headY = cy - 30 + bounce * 0.3;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, headY, 12, 0, Math.PI * 2);
  ctx.stroke();

  // Body
  const bodyTop = headY + 12;
  const bodyBottom = bodyTop + 40;
  ctx.beginPath();
  ctx.moveTo(cx, bodyTop);
  ctx.lineTo(cx, bodyBottom);
  ctx.stroke();

  // Arms
  ctx.beginPath();
  ctx.moveTo(cx, bodyTop + 10);
  ctx.lineTo(cx - 25, bodyTop + 10 + Math.sin(t * 3) * 20);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, bodyTop + 10);
  ctx.lineTo(cx + 25, bodyTop + 10 + Math.sin(t * 3 + Math.PI) * 20);
  ctx.stroke();

  // Dumbbells
  if (progress > 0) {
    const ly = bodyTop + 10 + Math.sin(t * 3) * 20;
    const ry = bodyTop + 10 + Math.sin(t * 3 + Math.PI) * 20;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx - 25 - 8, ly);
    ctx.lineTo(cx - 25 + 8, ly);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 25 - 8, ry);
    ctx.lineTo(cx + 25 + 8, ry);
    ctx.stroke();
    ctx.lineWidth = 3;
  }

  // Legs
  ctx.beginPath();
  ctx.moveTo(cx, bodyBottom);
  ctx.lineTo(cx - 15, 145);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, bodyBottom);
  ctx.lineTo(cx + 15, 145);
  ctx.stroke();

  // Sweat drops
  const sweatCount = Math.floor(progress * 6);
  for (let i = 0; i < sweatCount; i++) {
    const sx = cx + (i % 2 === 0 ? -1 : 1) * (18 + i * 3);
    const sy = headY - 5 - ((t * 30 + i * 15) % 30);
    const alpha = 1 - ((t * 30 + i * 15) % 30) / 30;
    ctx.fillStyle = `rgba(100, 180, 255, ${alpha * 0.6})`;
    ctx.beginPath();
    ctx.arc(sx, sy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Progress bar
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath();
  ctx.roundRect(30, 158, 120, 8, 4);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(30, 158, Math.max(0, 120 * progress), 8, 4);
  ctx.fill();
};

// --- Nap illustration ---
const drawNap = (progress, t) => {
  const cx = 90, cy = 100;
  const accent = getAccentColor();
  const bg = getBgColor();

  // Pillow
  ctx.fillStyle = "#e8e0d0";
  ctx.beginPath();
  ctx.ellipse(cx, cy + 15, 55, 18, 0, 0, Math.PI * 2);
  ctx.fill();

  // Blanket
  const blanketGrad = ctx.createLinearGradient(cx - 50, cy + 5, cx + 50, cy + 50);
  blanketGrad.addColorStop(0, "#6e8cc0");
  blanketGrad.addColorStop(1, "#4a6fa5");
  ctx.fillStyle = blanketGrad;
  ctx.beginPath();
  ctx.moveTo(cx - 50, cy + 5);
  for (let x = cx - 50; x <= cx + 50; x += 2) {
    ctx.lineTo(x, cy + 5 + Math.sin((x - cx) * 0.08) * 3);
  }
  ctx.lineTo(cx + 50, cy + 40);
  ctx.quadraticCurveTo(cx, cy + 48, cx - 50, cy + 40);
  ctx.closePath();
  ctx.fill();

  // Face/head
  ctx.fillStyle = "#f5d0b0";
  ctx.beginPath();
  ctx.arc(cx, cy - 5, 20, 0, Math.PI * 2);
  ctx.fill();

  // Closed eyes
  ctx.strokeStyle = "#8b6b50";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx - 7, cy - 7, 4, 0, Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + 7, cy - 7, 4, 0, Math.PI);
  ctx.stroke();

  // Smile
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0.2, Math.PI - 0.2);
  ctx.stroke();

  // Breathing
  const breathe = Math.sin(t * 1.5) * 2;
  ctx.fillStyle = "#6e8cc0";
  ctx.beginPath();
  ctx.ellipse(cx, cy + 20 + breathe, 30, 8 + breathe, 0, 0, Math.PI * 2);
  ctx.fill();

  // Z's floating up
  ctx.font = "bold 16px system-ui";
  ctx.fillStyle = accent;
  for (let i = 0; i < 3; i++) {
    const zx = cx + 30 + i * 8 + Math.sin(t + i) * 3;
    const zy = cy - 20 - i * 18 - ((t * 15) % 20);
    const alpha = 0.7 - i * 0.2;
    ctx.globalAlpha = alpha;
    ctx.fillText("z", zx, zy);
  }
  ctx.globalAlpha = 1;

  // Moon
  ctx.fillStyle = "#ffd700";
  ctx.beginPath();
  ctx.arc(140, 25, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(145, 22, 10, 0, Math.PI * 2);
  ctx.fill();

  // Stars
  const stars = [[30, 20], [60, 12], [120, 35], [45, 40], [100, 15]];
  stars.forEach(([sx, sy], i) => {
    const twinkle = 0.4 + Math.sin(t * 2 + i * 1.5) * 0.4;
    ctx.fillStyle = `rgba(255, 255, 200, ${twinkle})`;
    ctx.beginPath();
    ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
    ctx.fill();
  });
};

// ─── Initialize ──────────────────────────────────────────
loadState();

notifyToggle.checked = Boolean(state.notify);

if (state.activity) {
  activityInput.value = state.activity;
  updateActivity();
}

if (state.soundTheme) {
  soundThemeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sound === state.soundTheme);
  });
}

if (state.visualTheme) {
  applyTheme(state.visualTheme);
  themeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === state.visualTheme);
  });
}

if (state.mode === "countdown") {
  updateDisplay(state.remainingSeconds);
  if (state.totalSeconds > 0) {
    updateRing(state.remainingSeconds / state.totalSeconds);
  }
} else if (state.mode === "stopwatch") {
  updateDisplay(state.stopwatchElapsedSeconds);
  updateRing(0);
} else {
  updateDisplay(0);
  updateRing(0);
}

updateButtons();

tickInterval = setInterval(handleTick, 250);
handleTick();

window.addEventListener("beforeunload", saveState);

window._timerInitialized = true;
