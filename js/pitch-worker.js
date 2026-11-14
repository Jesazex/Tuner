importScripts("pitch-core.js?v=17");

function rmsOf(samples) {
  var energy = 0;
  var i;
  for (i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
  return Math.sqrt(energy / samples.length);
}

self.onmessage = function (event) {
  var data = event.data || {};
  var samples = data.samples;
  var rms = samples ? rmsOf(samples) : 0;
  var freq = samples ? detectPitch(samples, data.sampleRate) : null;
  self.postMessage({ freq: freq, rms: rms });
};
