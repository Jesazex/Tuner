(function (root) {
  var NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var STANDARD = [64, 59, 55, 50, 45, 40];
  var MIN_MIDI = 26;
  var MAX_MIDI = 88;

  function frequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function pitchClass(midi) {
    return ((midi % 12) + 12) % 12;
  }

  function octaveOf(midi) {
    return Math.floor(midi / 12) - 1;
  }

  function midiFrom(pc, octave) {
    return (octave + 1) * 12 + pc;
  }

  function midiToName(midi) {
    return NAMES[pitchClass(midi)] + octaveOf(midi);
  }

  function centsBetween(freq, ref) {
    return (1200 * Math.log(freq / ref)) / Math.LN2;
  }

  function nearestMidi(freq) {
    if (!(freq > 0)) return null;
    var midi = Math.round(69 + (12 * Math.log(freq / 440)) / Math.LN2);
    if (midi < 0) return 0;
    if (midi > 127) return 127;
    return midi;
  }

  function closestString(freq, targets, previous) {
    var best = 0;
    var bestAbs = Infinity;
    var cents = [];
    var i;
    for (i = 0; i < targets.length; i++) {
      var c = Math.abs(centsBetween(freq, frequency(targets[i])));
      cents.push(c);
      if (c < bestAbs) {
        bestAbs = c;
        best = i;
      }
    }
    if (previous != null && previous !== best && cents[previous] - bestAbs < 12) {
      return previous;
    }
    return best;
  }

  function formatOffset(delta) {
    if (delta > 0) return "+" + delta;
    if (delta < 0) return "\u2212" + (-delta);
    return "0";
  }

  function catalog() {
    var list = [];
    var m;
    for (m = 33; m <= 96; m++) list.push(m);
    return list;
  }

  root.Music = {
    NAMES: NAMES,
    STANDARD: STANDARD,
    MIN_MIDI: MIN_MIDI,
    MAX_MIDI: MAX_MIDI,
    frequency: frequency,
    pitchClass: pitchClass,
    octaveOf: octaveOf,
    midiFrom: midiFrom,
    midiToName: midiToName,
    centsBetween: centsBetween,
    nearestMidi: nearestMidi,
    closestString: closestString,
    formatOffset: formatOffset,
    catalog: catalog,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
