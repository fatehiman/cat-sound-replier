'use strict';
// Cat Sound Replier. Everything runs in the browser.
// Detection: YAMNet (TensorFlow.js), run on a sliding ~1 sec window every 150 ms,
// so a reply is scheduled as soon as the cat class wins, not when the sound ends.

const $ = id => document.getElementById(id);
const CLASS_SPEECH = 0, CLASS_CAT = 76, CLASS_MEOW = 78, CLASS_CATERWAUL = 80;
const YAMNET_SAMPLES = 15600;          // 0.975 sec at 16 kHz
const INFER_EVERY_MS = 150;
const RING_SECONDS = 12;
const MAX_REPEAT_SECONDS = 6;
const MAX_SILENCE_WAIT_MS = 20000;

const el = {
  listen: $('listen'), status: $('status'), level: $('level'), debug: $('debug'),
  detect: $('detect'), minDb: $('minDb'), sensVal: $('sensVal'), dbVal: $('dbVal'),
  rowSens: $('rowSens'), rowDb: $('rowDb'), detectHint: $('detectHint'),
  delay: $('delay'), silentOn: $('silentOn'), silentSec: $('silentSec'),
  mode: $('mode'), sound: $('sound'), preview: $('preview'), sens: $('sens'), vol: $('vol'),
};

// ---------- settings ----------
for (let i = 1; i <= 10; i++) el.silentSec.add(new Option(i, i));
const FIELDS = ['detect', 'minDb', 'delay', 'silentOn', 'silentSec', 'mode', 'sound', 'sens', 'vol'];
function saveSettings() {
  try {
    const o = {};
    FIELDS.forEach(k => o[k] = el[k].type === 'checkbox' ? el[k].checked : el[k].value);
    localStorage.setItem('catReplier', JSON.stringify(o));
  } catch (e) { /* storage may be blocked */ }
}
function loadSettings() {
  try {
    const o = JSON.parse(localStorage.getItem('catReplier') || '{}');
    FIELDS.forEach(k => {
      if (!(k in o)) return;
      if (el[k].type === 'checkbox') el[k].checked = !!o[k]; else el[k].value = o[k];
    });
  } catch (e) { /* ignore */ }
}
function applyUi() {
  const cat = el.detect.value === 'cat';
  el.rowSens.hidden = !cat;
  el.rowDb.hidden = cat;
  el.sensVal.textContent = el.sens.value + ' / 9';
  el.dbVal.textContent = el.minDb.value + ' dB';
  el.detectHint.textContent = cat
    ? 'Replies only when it hears a cat. Move the slider right if it does not react.'
    : 'Replies to any sound louder than the minimum volume. Move the slider left to hear quieter sounds.';
  el.sound.hidden = el.preview.hidden = el.mode.value !== 'specific';
  el.silentSec.disabled = !el.silentOn.checked;
  el.delay.disabled = el.silentOn.checked;
}
FIELDS.forEach(k => el[k].addEventListener('change', () => { applyUi(); saveSettings(); }));
el.delay.addEventListener('input', saveSettings);
['sens', 'minDb'].forEach(k => el[k].addEventListener('input', () => { applyUi(); saveSettings(); }));

// ---------- state ----------
let ctx = null, stream = null, srcNode = null, workletNode = null, model = null;
let sr = 48000, ring = null, total = 0;       // ring buffer of mic samples (native rate)
let listening = false, inferTimer = null, inferBusy = false;
let state = 'idle';                           // idle | pending | playing
let ignoreBefore = 0;                         // samples older than this are zeroed for detection
let noiseFloor = 0.01, calib = [], lastLoudAt = 0, lastRms = 0;
const soundBuffers = new Map();
let soundList = [];

// ---------- sound list ----------
async function loadSounds() {
  try {
    soundList = await (await fetch('sounds/sounds.json')).json();
  } catch (e) { soundList = []; }
  soundList.forEach(s => el.sound.add(new Option(s.name, s.file)));
}

async function getSoundBuffer(file) {
  if (soundBuffers.has(file)) return soundBuffers.get(file);
  const data = await (await fetch('sounds/' + file)).arrayBuffer();
  const buf = await ctx.decodeAudioData(data);
  soundBuffers.set(file, buf);
  return buf;
}

// ---------- microphone ----------
const WORKLET_SRC = `
class Cap extends AudioWorkletProcessor {
  constructor(){ super(); this.b = new Float32Array(1024); this.n = 0; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.b[this.n++] = ch[i];
      if (this.n === 1024) { this.port.postMessage(this.b.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('cap', Cap);`;

function onChunk(chunk) {
  const n = chunk.length, size = ring.length;
  let w = total % size;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    ring[w] = chunk[i]; sum += chunk[i] * chunk[i];
    if (++w === size) w = 0;
  }
  total += n;
  lastRms = Math.sqrt(sum / n);
  const now = performance.now();
  if (calib) {                                 // learn the room noise for the first second
    calib.push(lastRms);
    if (calib.length * n / sr >= 1) {
      calib.sort((a, b) => a - b);
      noiseFloor = Math.max(0.006, calib[Math.floor(calib.length / 2)]);
      calib = null;
    }
  } else if (lastRms > noiseFloor * 2.5) {
    lastLoudAt = now;
  }
  el.level.style.width = Math.min(100, lastRms * 600) + '%';
  const db = 20 * Math.log10(Math.max(lastRms, 1e-6));
  if (listening && !calib && state === 'idle') {
    if (el.detect.value === 'any') {
      const min = Number(el.minDb.value);
      el.debug.textContent = `volume ${db.toFixed(0)} dB (need ${min} dB)`;
      if (db >= min && total > ignoreBefore + n) {
        const count = Math.round(sr * 0.5);
        onCat(total, readRing(total, count), 1, true);
      }
    }
  }
}

// last `count` samples that end at `end` (absolute sample index), as a new array
function readRing(end, count) {
  const out = new Float32Array(count), size = ring.length;
  const start = end - count;
  for (let i = 0; i < count; i++) {
    const a = start + i;
    out[i] = a >= 0 && a >= total - size ? ring[a % size] : 0;
  }
  return out;
}

function resampleTo16k(x) {
  const out = new Float32Array(YAMNET_SAMPLES), ratio = x.length / YAMNET_SAMPLES;
  for (let i = 0; i < YAMNET_SAMPLES; i++) {
    const p = i * ratio, j = Math.floor(p), f = p - j;
    out[i] = x[j] * (1 - f) + (x[Math.min(j + 1, x.length - 1)]) * f;
  }
  return out;
}

// ---------- detection ----------
async function infer() {
  if (!listening || inferBusy || state !== 'idle' || !model || calib || el.detect.value !== 'cat') return;
  inferBusy = true;
  try {
    const end = total;
    const count = Math.round(sr * YAMNET_SAMPLES / 16000);
    if (end < count) return;
    const win = readRing(end, count);
    const skip = Math.max(0, ignoreBefore - (end - count));   // hide our own earlier sound
    if (skip > 0) win.fill(0, 0, Math.min(skip, count));
    const wave = resampleTo16k(win);
    const out = tf.tidy(() => {
      const r = model.predict(tf.tensor1d(wave));
      return Array.isArray(r) ? r[0] : r;
    });
    const scores = await out.data();
    out.dispose();
    if (!listening || state !== 'idle') return;
    const sig = v => 1 / (1 + Math.exp(-v));                  // model gives logits
    const cat = sig(Math.max(scores[CLASS_CAT], scores[CLASS_MEOW], scores[CLASS_CATERWAUL]));
    const speech = sig(scores[CLASS_SPEECH]);
    const thr = 0.55 - 0.055 * Number(el.sens.value);         // 1 -> 0.50 ... 9 -> 0.05
    el.debug.textContent = `cat ${cat.toFixed(2)} (need ${thr.toFixed(2)}) · speech ${speech.toFixed(2)} · ${(20 * Math.log10(Math.max(lastRms, 1e-6))).toFixed(0)} dB`;
    // the newest 0.3 sec must be louder than the room, so an old meow in the window does not count
    const recent = readRing(end, Math.round(sr * 0.3));
    let s = 0; for (const v of recent) s += v * v;
    const recentRms = Math.sqrt(s / recent.length);
    if (cat >= thr && cat > speech * 0.8 && recentRms > noiseFloor * 1.2) onCat(end, win, cat);
  } catch (e) {
    console.error(e);
    el.debug.textContent = 'Detector error: ' + (e && e.message || e);
  } finally {
    inferBusy = false;
  }
}

function onCat(end, win, cat, any) {
  state = 'pending';
  el.status.textContent = any ? '🔔 Sound heard!' : `🐱 Cat heard! (${Math.round(cat * 100)}%)`;
  el.status.classList.add('hit');
  // guess where the sound began: first 20 ms block clearly louder than the room
  const blk = Math.round(sr * 0.02);
  let onset = 0;
  for (let i = 0; i + blk <= win.length; i += blk) {
    let s = 0; for (let j = 0; j < blk; j++) s += win[i + j] * win[i + j];
    if (Math.sqrt(s / blk) > noiseFloor * 2.5) { onset = Math.max(0, i - blk * 3); break; }
  }
  const onsetSample = end - win.length + onset;
  const t0 = performance.now();
  const go = () => playReply(onsetSample);
  if (el.silentOn.checked) {
    const need = Number(el.silentSec.value) * 1000;
    const poll = setInterval(() => {
      if (!listening) return clearInterval(poll);
      const now = performance.now();
      if (now - lastLoudAt >= need || now - t0 > MAX_SILENCE_WAIT_MS) { clearInterval(poll); go(); }
    }, 50);
  } else {
    setTimeout(() => { if (listening) go(); }, Math.max(0, Number(el.delay.value) || 0) * 1000);
  }
}

// ---------- playback ----------
function trimTail(x) {
  let e = x.length;
  const blk = Math.round(sr * 0.02);
  while (e - blk > 0) {
    let s = 0; for (let j = e - blk; j < e; j++) s += x[j] * x[j];
    if (Math.sqrt(s / blk) > noiseFloor * 2) break;
    e -= blk;
  }
  return x.subarray(0, e);
}

async function playReply(onsetSample) {
  state = 'playing';
  try {
    let buf;
    if (el.mode.value === 'repeat') {
      const max = Math.round(sr * MAX_REPEAT_SECONDS);
      const from = Math.max(onsetSample, total - max);
      const seg = trimTail(readRing(total, total - from));
      if (seg.length < sr * 0.1) { await finish(); return; }
      buf = ctx.createBuffer(1, seg.length, sr);
      buf.copyToChannel(seg, 0);
    } else {
      buf = await getSoundBuffer(el.sound.value);
    }
    el.status.textContent = '🔊 Replying…';
    await playBuffer(buf);
  } catch (e) {
    console.error(e);
  }
  await finish();
}

function playBuffer(buf) {
  return new Promise(resolve => {
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = Number(el.vol.value);
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    src.onended = resolve;
    src.start();
  });
}

async function finish() {
  ignoreBefore = total;                // do not hear our own reply
  await new Promise(r => setTimeout(r, 400));
  ignoreBefore = total;
  lastLoudAt = performance.now();
  state = 'idle';
  if (listening) {
    el.status.classList.remove('hit');
    el.status.textContent = '👂 Listening for cats…';
  }
}

// ---------- start / stop ----------
async function start() {
  el.listen.disabled = true;
  try {
    el.status.textContent = 'Asking for the microphone…';
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    sr = ctx.sampleRate;
    ring = new Float32Array(sr * RING_SECONDS);
    total = 0; ignoreBefore = 0; calib = []; lastLoudAt = performance.now();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    el.status.textContent = 'Loading the cat ear (one time, ~16 MB)…';
    if (!model) model = await tf.loadGraphModel('model/model.json');
    if (!model.warm) {                                  // first run is slow; do it now
      tf.tidy(() => model.predict(tf.zeros([YAMNET_SAMPLES])));
      model.warm = true;
    }
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    srcNode = ctx.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(ctx, 'cap');
    workletNode.port.onmessage = e => onChunk(e.data);
    srcNode.connect(workletNode);
    state = 'idle';
    listening = true;
    inferTimer = setInterval(infer, INFER_EVERY_MS);
    el.listen.textContent = '⏹ Stop';
    el.listen.classList.add('on');
    el.status.textContent = '👂 Listening for cats…';
    if (el.mode.value === 'specific') getSoundBuffer(el.sound.value).catch(() => {});
  } catch (e) {
    console.error(e);
    stop();
    el.status.textContent = e && e.name === 'NotAllowedError'
      ? 'Microphone is blocked. Allow it in the browser and try again.'
      : 'Error: ' + (e && e.message || e);
  } finally {
    el.listen.disabled = false;
  }
}

function stop() {
  listening = false;
  clearInterval(inferTimer);
  if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
  if (srcNode) { srcNode.disconnect(); srcNode = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  state = 'idle';
  el.listen.textContent = '🎤 Listen';
  el.listen.classList.remove('on');
  el.status.classList.remove('hit');
  el.status.textContent = 'Not listening.';
  el.level.style.width = '0';
  el.debug.textContent = '';
}

el.listen.addEventListener('click', () => listening ? stop() : start());
el.preview.addEventListener('click', async () => {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    await playBuffer(await getSoundBuffer(el.sound.value));
  } catch (e) { console.error(e); }
});

loadSettings();
loadSounds().then(() => { loadSettings(); applyUi(); });
applyUi();
