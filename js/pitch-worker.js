importScripts("pitch-core.js");

self.onmessage = function (event) {
  var data = event.data || {};
  var freq = detectPitch(data.samples, data.sampleRate);
  self.postMessage({ freq: freq });
};
