(function (root) {
  function wrap(pos, size) {
    var x = pos % size;
    if (x < 0) x += size;
    return x;
  }

  // Karplus–Strong plucked string. The buffer already contains the whole
  // decay, so playback simply runs to the end and does not get cut off.
  function renderPluckSamples(frequency, sampleRate) {
    if (!Number.isFinite(frequency) || frequency < 20 || !(sampleRate > 0)) {
      return new Float32Array(1);
    }

    var duration = Math.min(3.6, Math.max(1.8, 3.6 - frequency / 220));
    var length = Math.floor(sampleRate * duration);
    var out = new Float32Array(length);

    // The loop filter delays the wave by about one sample and would make
    // the note flat. Shorten the delay so the heard pitch stays put.
    var period = Math.max(2, sampleRate / frequency - 1);
    var size = Math.ceil(period) + 2;
    var buf = new Float32Array(size);
    var noise = new Float32Array(size);
    var prev = 0;
    var i;
    for (i = 0; i < size; i++) {
      var white = Math.random() * 2 - 1;
      prev = prev * 0.5 + white * 0.5;
      noise[i] = prev;
    }
    var pick = Math.round((sampleRate / frequency) * 0.12);
    if (pick < 1) pick = 1;
    if (pick > size - 2) pick = size - 2;
    for (i = 0; i < size; i++) {
      var delayedNoise = noise[(i - pick + size) % size];
      buf[i] = (noise[i] - delayedNoise) * 0.5;
    }

    var sum = 0;
    for (i = 0; i < size; i++) sum += buf[i] * buf[i];
    var rms = Math.sqrt(sum / size) || 1e-4;
    var scale = 0.55 / rms;
    for (i = 0; i < size; i++) buf[i] *= scale;

    // Gain is applied once per trip around the delay, not once per sample.
    var loopGain = Math.pow(0.004, period / (sampleRate * duration));
    var write = 0;
    var last = 0;
    var attackSamples = Math.max(8, Math.round(sampleRate * 0.002));
    var n;
    for (n = 0; n < length; n++) {
      var read = wrap(write - period, size);
      var i0 = Math.floor(read);
      var frac = read - i0;
      var i1 = i0 + 1;
      if (i1 >= size) i1 = 0;
      var delayed = buf[i0] * (1 - frac) + buf[i1] * frac;
      var filtered = 0.5 * (delayed + last);
      last = filtered;
      buf[write] = filtered * loopGain;
      write++;
      if (write >= size) write = 0;
      var attack = n < attackSamples ? n / attackSamples : 1;
      out[n] = delayed * attack;
    }

    var measureFrom = attackSamples;
    var measureTo = Math.min(length, measureFrom + Math.floor(sampleRate * 0.08));
    var acc = 0;
    for (i = measureFrom; i < measureTo; i++) acc += out[i] * out[i];
    var level = Math.sqrt(acc / Math.max(1, measureTo - measureFrom)) || 1e-4;
    var makeup = 0.2 / level;
    if (makeup > 2.6) makeup = 2.6;
    if (makeup < 0.6) makeup = 0.6;
    for (i = 0; i < length; i++) out[i] *= makeup;

    var fade = Math.max(1, Math.round(sampleRate * 0.02));
    for (i = 0; i < fade && i < length; i++) {
      out[length - 1 - i] *= i / fade;
    }
    return out;
  }

  root.renderPluckSamples = renderPluckSamples;
})(typeof globalThis !== "undefined" ? globalThis : this);
