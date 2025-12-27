const STORAGE_KEY = "kitchen-timer-state";

const timeDisplay = document.getElementById("timeDisplay");
const minutesInput = document.getElementById("minutesInput");
const startButton = document.getElementById("startButton");
const pauseButton = document.getElementById("pauseButton");
const resetButton = document.getElementById("resetButton");
const notifyToggle = document.getElementById("notifyToggle");
const presetButtons = document.querySelectorAll(".preset");

// If any of these are missing, stop immediately with a clear message.
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

const state = {
  mode: "idle", // idle | countdown | stopwatch
  status: "stopped", // stopped | running | paused
  remainingSeconds: 0,
  stopwatchElapsedSeconds: 0,
  countdownEndTimestamp: null,
  stopwatchStartTimestamp: null,
  notify: false,
};

const formatTime = (totalSeconds) => {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const saveState = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

const loadState = () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;
  try {
    Object.assign(state, JSON.parse(saved));
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
};

const updateDisplay = (seconds) => {
  timeDisplay.textContent = formatTime(seconds);
};

const updateButtons = () => {
  startButton.disabled = state.status === "running";
  pauseButton.textContent = state.status === "paused" ? "Resume" : "Pause";
};

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

const warmAudio = () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") audioContext.resume();
};

const playAlertSound = () => {
  if (!audioContext) warmAudio();
  if (!audioContext) return;

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, audioContext.currentTime);

  gainNode.gain.setValueAtTime(0.001, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.4, audioContext.currentTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 1.2);

  oscillator.connect(gainNode).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 1.2);
};

const triggerAlert = () => {
  playAlertSound();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);

  if (state.notify && "Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification("Timer done", { body: "Countdown finished. Stopwatch started." });
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then((permission) => {
        if (permission === "granted") {
          new Notification("Timer done", { body: "Countdown finished. Stopwatch started." });
        }
      });
    }
  }
};

const transitionToStopwatch = () => {
  triggerAlert();
  const now = Date.now();
  const elapsed = Math.max(0, Math.floor((now - state.countdownEndTimestamp) / 1000));

  state.mode = "stopwatch";
  state.status = "running";
  state.stopwatchElapsedSeconds = elapsed;
  state.stopwatchStartTimestamp = now - elapsed * 1000;
  state.countdownEndTimestamp = null;

  updateDisplay(state.stopwatchElapsedSeconds);
  updateButtons();
  saveState();
};

const startCountdown = (minutes) => {
  state.mode = "countdown";
  state.status = "running";
  state.remainingSeconds = minutes * 60;
  state.countdownEndTimestamp = Date.now() + state.remainingSeconds * 1000;

  state.stopwatchElapsedSeconds = 0;
  state.stopwatchStartTimestamp = null;

  updateDisplay(state.remainingSeconds);
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
  state.stopwatchElapsedSeconds = 0;
  state.countdownEndTimestamp = null;
  state.stopwatchStartTimestamp = null;

  updateDisplay(0);
  updateButtons();
  saveState();
};

const handleTick = () => {
  if (state.status !== "running") return;

  if (state.mode === "countdown") {
    const remaining = calculateRemainingSeconds();
    state.remainingSeconds = remaining;
    updateDisplay(remaining);

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
  state.mode = "countdown";
  state.status = "stopped";
  state.countdownEndTimestamp = null;

  updateDisplay(state.remainingSeconds);
  updateButtons();
  saveState();
};

loadState();
notifyToggle.checked = Boolean(state.notify);

if (state.mode === "countdown") updateDisplay(state.remainingSeconds);
else if (state.mode === "stopwatch") updateDisplay(state.stopwatchElapsedSeconds);
else updateDisplay(0);
updateButtons();

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

tickInterval = setInterval(handleTick, 250);
handleTick();

window.addEventListener("beforeunload", saveState);
