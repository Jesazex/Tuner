const fs = require("fs");
const path = require("path");

function load(file) {
  eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
}

load("js/music.js");
load("js/pitch-core.js");
load("js/synth-core.js");

function assert(cond, message) {
  if (!cond) {
    console.error("FAIL", message);
    process.exitCode = 1;
    throw new Error(message);
  }
}

function cents(a, b) {
  return (1200 * Math.log(a / b)) / Math.LN2;
}

function sine(freq, sampleRate, length, amp) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp;
  }
  return out;
}

assert(Music.midiToName(64) === "E4", "E4");
assert(Music.midiToName(40) === "E2", "E2");
assert(Music.midiToName(59) === "B3", "B3");
assert(Music.midiToName(63) === "D#4", "D#4");
assert(Music.formatOffset(-4) === "\u22124", "offset -4");
assert(Music.formatOffset(2) === "+2", "offset +2");
assert(Music.formatOffset(0) === "0", "offset 0");

const standard = [64, 59, 55, 50, 45, 40];
assert(Music.closestString(Music.frequency(40), standard, null) === 5, "low E string");
assert(Music.closestString(Music.frequency(64), standard, null) === 0, "high E string");
assert(Music.closestString(115, standard, null) === 4, "near A");
assert(Music.closestString(140, standard, null) === 3, "near D");
const flat = Music.centsBetween(Music.frequency(45) * Math.pow(2, -10 / 1200), Music.frequency(45));
assert(flat < -9 && flat > -11, "flat cents " + flat);

const names = Music.catalog().map(Music.midiToName);
assert(names[0] === "A1", "catalog start");
assert(names[names.length - 1] === "C7", "catalog end");
for (let i = 1; i < names.length; i++) {
  assert(Music.catalog()[i] === Music.catalog()[i - 1] + 1, "catalog order");
}

const sampleRate = 48000;
for (const freq of [82.41, 110, 196, 329.63]) {
  const detected = detectPitch(sine(freq, sampleRate, 4096, 0.35), sampleRate);
  const error = cents(detected, freq);
  console.log("sine", freq, "->", detected && detected.toFixed(2), "cents", error.toFixed(2));
  assert(detected && Math.abs(error) < 8, "sine " + freq);
}

const quiet = detectPitch(sine(110, sampleRate, 4096, 0.001), sampleRate);
assert(quiet && Math.abs(cents(quiet, 110)) < 8, "quiet sine " + quiet);
assert(detectPitch(sine(110, sampleRate, 4096, 0.00005), sampleRate) == null, "below gate");

function mix(parts, amp) {
  const out = new Float32Array(4096);
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (const part of parts) s += part.a * Math.sin((2 * Math.PI * part.f * i) / sampleRate);
    out[i] = s * amp;
  }
  return out;
}
const bright = detectPitch(mix([{ f: 82.41, a: 0.45 }, { f: 164.81, a: 1 }, { f: 247.2, a: 0.7 }], 0.2), sampleRate);
assert(bright && Math.abs(cents(bright, 82.41)) < 8, "harmonic stays on fundamental " + bright);

for (const freq of [82.41, 110, 196, 246.94, 329.63]) {
  const rendered = renderPluckSamples(freq, sampleRate);
  const start = Math.floor(sampleRate * 0.12);
  const slice = rendered.slice(start, start + 4096);
  const detected = detectPitch(slice, sampleRate);
  const error = detected ? cents(detected, freq) : NaN;
  let early = 0;
  let late = 0;
  const earlyN = Math.floor(sampleRate * 0.1);
  for (let i = start; i < start + earlyN; i++) early += rendered[i] * rendered[i];
  const lateStart = rendered.length - Math.floor(sampleRate * 0.12);
  for (let i = lateStart; i < rendered.length - 10; i++) late += rendered[i] * rendered[i];
  early = Math.sqrt(early / earlyN);
  late = Math.sqrt(late / (rendered.length - 10 - lateStart));
  console.log(
    "pluck",
    freq,
    "->",
    detected && detected.toFixed(2),
    "cents",
    error.toFixed(2),
    "early",
    early.toFixed(3),
    "late",
    late.toFixed(4),
  );
  assert(detected && Math.abs(error) < 12, "pluck pitch " + freq + " cents " + error);
  assert(late < early * 0.2, "pluck decay " + freq);
}

if (!process.exitCode) console.log("ok");
