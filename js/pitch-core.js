(function (root) {
  function detectPitch(samples, sampleRate) {
    var n = samples.length;
    if (n < 512 || !(sampleRate > 0)) return null;

    var peak = 0;
    var i;
    for (i = 0; i < n; i++) {
      var abs = samples[i] < 0 ? -samples[i] : samples[i];
      if (abs > peak) peak = abs;
    }
    if (peak < 0.0002) return null;
    if (peak < 0.3) {
      var boost = 0.3 / peak;
      if (boost > 24) boost = 24;
      for (i = 0; i < n; i++) samples[i] *= boost;
    }

    var energy = 0;
    for (i = 0; i < n; i++) energy += samples[i] * samples[i];
    var rms = Math.sqrt(energy / n);
    if (rms < 0.002) return null;

    var minFreq = 50;
    var maxFreq = 1000;
    var tauMax = Math.floor(sampleRate / minFreq);
    var half = Math.floor(n / 2) - 1;
    if (tauMax > half) tauMax = half;
    var tauMin = Math.floor(sampleRate / maxFreq);
    if (tauMin < 2) tauMin = 2;
    if (tauMax <= tauMin + 2) return null;

    var window = n - tauMax;
    if (window < 256) return null;

    var diff = new Float64Array(tauMax + 1);
    var tau;
    for (tau = 1; tau <= tauMax; tau++) {
      var sum = 0;
      var j;
      for (j = 0; j < window; j++) {
        var d = samples[j] - samples[j + tau];
        sum += d * d;
      }
      diff[tau] = sum;
    }

    var cmnd = new Float64Array(tauMax + 1);
    cmnd[0] = 1;
    var running = 0;
    for (tau = 1; tau <= tauMax; tau++) {
      running += diff[tau];
      cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
    }

    var threshold = 0.28;
    tau = tauMin;
    while (tau < tauMax) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        break;
      }
      tau++;
    }
    if (tau >= tauMax || cmnd[tau] >= threshold) return null;

    var x0 = tau > 0 ? cmnd[tau - 1] : cmnd[tau];
    var x1 = cmnd[tau];
    var x2 = tau + 1 < cmnd.length ? cmnd[tau + 1] : cmnd[tau];
    var denom = 2 * (x0 - 2 * x1 + x2);
    var better = tau;
    if (denom !== 0) better = tau + (x0 - x2) / denom;
    if (!(better > 0)) return null;

    var freq = sampleRate / better;
    if (freq < minFreq || freq > maxFreq) return null;
    return freq;
  }

  root.detectPitch = detectPitch;
})(typeof globalThis !== "undefined" ? globalThis : this);
