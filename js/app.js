(function () {
  var STORAGE_KEY = "struna.v1";
  var FRET_LIMIT = 10;
  var PRESETS = [
    { id: "standard", name: "Стандарт", notes: [64, 59, 55, 50, 45, 40], builtin: true },
    { id: "drop-d", name: "Drop D", notes: [64, 59, 55, 50, 45, 38], builtin: true },
    { id: "down-1", name: "На лад ниже", notes: [63, 58, 54, 49, 44, 39], builtin: true },
    { id: "open-g", name: "Open G", notes: [62, 59, 55, 50, 43, 38], builtin: true },
    { id: "open-d", name: "Open D", notes: [62, 57, 54, 50, 45, 38], builtin: true },
    { id: "dadgad", name: "DADGAD", notes: [62, 57, 55, 50, 45, 38], builtin: true },
  ];

  var state = loadState();
  var draft = null;
  var ctx = null;
  var master = null;
  var bufferCache = new Map();
  var playing = [];
  var micOn = false;
  var micStarting = false;
  var micBlocked = false;
  var audioPrimed = false;
  var micStream = null;
  var micSource = null;
  var analyser = null;
  var micSink = null;
  var micTimer = 0;
  var audioWorker = null;
  var workerBusy = false;
  var workerSentAt = 0;
  var live = null;
  var hist = [];
  var lastString = null;
  var inTuneHold = false;
  var silenceSince = 0;
  var pluckedMidi = null;
  var pluckUntil = 0;
  var pluckTimer = 0;
  var toastTimer = 0;
  var dragging = false;
  var lastIndex = -1;
  var lastScrolled = null;

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return String(Date.now()) + Math.random().toString(16).slice(2);
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function noteHtml(midi) {
    var name = Music.midiToName(midi);
    var letter = name.replace(/\d+$/, "");
    return esc(letter) + "<sub>" + name.slice(letter.length) + "</sub>";
  }

  function clonePreset(preset) {
    return {
      id: preset.id,
      name: preset.name,
      notes: preset.notes.slice(),
      builtin: !!preset.builtin,
      description: preset.description || "",
    };
  }

  function defaultState() {
    return {
      tunings: PRESETS.map(clonePreset),
      activeId: "standard",
      showHz: false,
      referenceId: "standard",
    };
  }

  function sanitize(entry) {
    if (!entry || typeof entry.name !== "string" || !Array.isArray(entry.notes) || entry.notes.length !== 6) {
      return null;
    }
    var notes = entry.notes.map(Number);
    var i;
    for (i = 0; i < notes.length; i++) {
      if (!Number.isInteger(notes[i]) || notes[i] < 0 || notes[i] > 127) return null;
    }
    var name = entry.name.trim().slice(0, 40);
    if (!name) return null;
    var description = typeof entry.description === "string" ? entry.description.trim().slice(0, 200) : "";
    return { id: String(entry.id || uid()), name: name, notes: notes, builtin: !!entry.builtin, description: description };
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var data = JSON.parse(raw);
      var tunings = Array.isArray(data.tunings) ? data.tunings.map(sanitize).filter(Boolean) : [];
      if (!tunings.length) return { tunings: [], activeId: null, showHz: !!data.showHz, referenceId: null };
      var activeId = tunings.some(function (t) { return t.id === data.activeId; }) ? data.activeId : tunings[0].id;
      var referenceId = tunings.some(function (t) { return t.id === data.referenceId; }) ? data.referenceId : "standard";
      return { tunings: tunings, activeId: activeId, showHz: !!data.showHz, referenceId: referenceId };
    } catch (error) {
      return defaultState();
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tunings: state.tunings,
        activeId: state.activeId,
        showHz: state.showHz,
        referenceId: state.referenceId,
      }));
    } catch (error) {}
  }

  function active() {
    var i;
    for (i = 0; i < state.tunings.length; i++) {
      if (state.tunings[i].id === state.activeId) return state.tunings[i];
    }
    return null;
  }

  function referenceNotes() {
    var i;
    for (i = 0; i < state.tunings.length; i++) {
      if (state.tunings[i].id === state.referenceId) return state.tunings[i].notes;
    }
    return Music.STANDARD;
  }

  function offsetAt(midi, index) {
    return midi - referenceNotes()[index];
  }

  function holdSession() {
    var session = navigator.audioSession;
    if (!session) return;
    try { session.type = "play-and-record"; } catch (error) {}
  }

  function resetDetection() {
    hist = [];
    lastString = null;
    inTuneHold = false;
    live = null;
    silenceSince = 0;
  }

  function ensureCtx() {
    holdSession();
    if (!ctx) {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      try {
        ctx = new AudioCtx({ latencyHint: "interactive" });
      } catch (error) {
        ctx = new AudioCtx();
      }
      master = ctx.createGain();
      var highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 30;
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 18;
      comp.ratio.value = 2.5;
      comp.attack.value = 0.005;
      comp.release.value = 0.18;
      master.connect(highpass);
      highpass.connect(comp);
      comp.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function getBuffer(midi, frequency) {
    var audio = ensureCtx();
    var key = midi + "@" + audio.sampleRate;
    if (!bufferCache.has(key)) {
      var samples = renderPluckSamples(frequency, audio.sampleRate);
      var buffer = audio.createBuffer(1, samples.length, audio.sampleRate);
      buffer.getChannelData(0).set(samples);
      bufferCache.set(key, buffer);
      if (bufferCache.size > 40) bufferCache.delete(bufferCache.keys().next().value);
    }
    return bufferCache.get(key);
  }

  function releaseVoice(voice, seconds) {
    if (!voice || voice.ending || !ctx) return;
    voice.ending = true;
    var time = ctx.currentTime;
    var gain = voice.gain.gain;
    gain.cancelScheduledValues(time);
    var current = gain.value > 0.001 ? gain.value : 0.001;
    gain.setValueAtTime(current, time);
    gain.exponentialRampToValueAtTime(0.001, time + seconds);
    voice.source.stop(time + seconds + 0.02);
  }

  function pluck(index) {
    var tuning = active();
    if (!tuning || index < 0 || index > 5) return;
    var midi = tuning.notes[index];
    var audio = ensureCtx();
    var i;
    for (i = 0; i < playing.length; i++) {
      if (playing[i].midi === midi) releaseVoice(playing[i], 0.16);
    }
    var source = audio.createBufferSource();
    source.buffer = getBuffer(midi, Music.frequency(midi));
    var gain = audio.createGain();
    gain.gain.value = 0.72;
    source.connect(gain);
    gain.connect(master);
    source.start();
    var voice = { midi: midi, source: source, gain: gain, ending: false };
    playing.push(voice);
    source.onended = function () {
      var at = playing.indexOf(voice);
      if (at >= 0) playing.splice(at, 1);
    };
    var alive = playing.filter(function (item) { return !item.ending; });
    if (alive.length > 8) releaseVoice(alive[0], 0.09);

    pluckedMidi = midi;
    pluckUntil = performance.now() + 5600;
    clearTimeout(pluckTimer);
    pluckTimer = setTimeout(function () {
      if (!live) paintLive();
    }, 5650);
    flashString(index);
    if (!live) paintLive();
    else paintNoteHighlight();
    if (navigator.vibrate) navigator.vibrate(10);
  }

  function flashString(index) {
    var wrap = document.querySelector('.string-col[data-index="' + index + '"] .s-line-wrap');
    if (!wrap) return;
    wrap.classList.remove("ring");
    void wrap.offsetWidth;
    wrap.classList.add("ring");
  }

  function haltMic(silent) {
    micOn = false;
    clearInterval(micTimer);
    micTimer = 0;
    if (micSource) {
      try { micSource.disconnect(); } catch (error) {}
    }
    if (micStream) micStream.getTracks().forEach(function (track) { track.stop(); });
    micSource = null;
    micStream = null;
    if (analyser) {
      try { analyser.disconnect(); } catch (error) {}
    }
    analyser = null;
    if (!silent) onFrequency(null);
  }

  function startMic() {
    if (micOn || micStarting || micBlocked) return;
    holdSession();
    ensureCtx();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      micBlocked = true;
      toast("Этот браузер не отдаёт микрофон");
      return;
    }
    if (!window.isSecureContext) {
      micBlocked = true;
      toast("Микрофон доступен только по https");
      return;
    }
    micStarting = true;
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    }).then(function (stream) {
      micStarting = false;
      audioPrimed = true;
      if (document.hidden) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return;
      }
      micStream = stream;
      micSource = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0;
      micSource.connect(analyser);
      if (!micSink) {
        micSink = ctx.createGain();
        micSink.gain.value = 0.00001;
        micSink.connect(ctx.destination);
      }
      analyser.connect(micSink);
      micOn = true;
      paintLive();
      var buf = new Float32Array(analyser.fftSize);
      if (!audioWorker) {
        try {
          audioWorker = new Worker("js/pitch-worker.js");
          audioWorker.onmessage = function (event) {
            workerBusy = false;
            if (micOn) onFrequency(event.data ? event.data.freq : null);
          };
          audioWorker.onerror = function () {
            audioWorker = null;
            workerBusy = false;
          };
        } catch (error) {
          audioWorker = null;
        }
      }
      micTimer = setInterval(function () {
        if (!micOn || !analyser) return;
        analyser.getFloatTimeDomainData(buf);
        if (audioWorker) {
          if (workerBusy && performance.now() - workerSentAt > 500) workerBusy = false;
          if (workerBusy) return;
          var copy = new Float32Array(buf);
          workerBusy = true;
          workerSentAt = performance.now();
          try {
            audioWorker.postMessage({ samples: copy, sampleRate: ctx.sampleRate }, [copy.buffer]);
          } catch (error) {
            workerBusy = false;
            onFrequency(detectPitch(buf, ctx.sampleRate));
          }
        } else {
          onFrequency(detectPitch(buf, ctx.sampleRate));
        }
      }, 90);
    }).catch(function (error) {
      micStarting = false;
      var name = error && error.name;
      if ((name === "NotAllowedError" || name === "PermissionDeniedError") && !audioPrimed) return;
      micBlocked = true;
      toast(name === "NotFoundError" ? "Микрофон не найден" : "Разрешите микрофон в настройках браузера");
    });
  }

  function primeAudio() {
    ensureCtx();
    if (!audioPrimed) {
      audioPrimed = true;
      try {
        var silence = ctx.createBuffer(1, 1, ctx.sampleRate);
        var blip = ctx.createBufferSource();
        blip.buffer = silence;
        blip.connect(master);
        blip.start();
      } catch (error) {}
    }
    if (ctx.state === "suspended") ctx.resume();
    startMic();
  }

  function applyStable(freq) {
    var tuning = active();
    if (!tuning) return;
    var index = Music.closestString(freq, tuning.notes, lastString);
    lastString = index;
    var target = tuning.notes[index];
    var cents = Music.centsBetween(freq, Music.frequency(target));
    var absCents = Math.abs(cents);
    inTuneHold = inTuneHold ? absCents < 9 : absCents < 6;
    var direction = inTuneHold ? "ok" : cents > 0 ? "down" : "up";
    live = {
      freq: freq,
      index: index,
      cents: cents,
      target: target,
      heard: Music.nearestMidi(freq),
      direction: direction,
    };
    paintLive();
  }

  function onFrequency(freq) {
    var now = performance.now();
    if (freq == null) {
      if (!silenceSince) silenceSince = now;
      if (now - silenceSince > 320) {
        live = null;
        hist = [];
        lastString = null;
        inTuneHold = false;
        silenceSince = 0;
        paintLive();
      }
      return;
    }
    silenceSince = 0;
    hist.push(freq);
    if (hist.length > 3) hist.shift();
    var sorted = hist.slice().sort(function (a, b) { return a - b; });
    applyStable(sorted[sorted.length >> 1]);
  }

  function currentHighlight() {
    if (live) return live.heard;
    if (performance.now() < pluckUntil) return pluckedMidi;
    return null;
  }

  function soundingFrequency() {
    if (live) return live.freq;
    if (performance.now() < pluckUntil && pluckedMidi != null) return Music.frequency(pluckedMidi);
    return null;
  }

  function formatHz(freq) {
    return freq.toFixed(1).replace(".", ",") + " Hz";
  }

  function paintReadout() {
    var note = document.getElementById("readout-note");
    var dir = document.getElementById("readout-dir");
    var hz = document.getElementById("readout-hz");
    var needle = document.getElementById("needle");
    var sounding = pluckedMidi != null && performance.now() < pluckUntil;
    if (!live && !sounding) {
      note.textContent = "";
      note.className = "readout-note";
      dir.textContent = "";
      dir.className = "";
      needle.hidden = true;
      hz.hidden = !state.showHz;
      hz.textContent = state.showHz ? "нет звука" : "";
      return;
    }
    if (!live) {
      note.innerHTML = noteHtml(pluckedMidi);
      note.className = "readout-note";
      dir.textContent = "";
      dir.className = "";
      delete dir.dataset.key;
      needle.hidden = true;
      hz.hidden = !state.showHz;
      hz.textContent = state.showHz ? formatHz(Music.frequency(pluckedMidi)) : "";
      return;
    }
    note.innerHTML = noteHtml(live.target);
    note.className = "readout-note dir-" + live.direction;
    var phrase = live.direction === "ok" ? "В строе" : live.direction === "up" ? "Поднять" : "Опустить";
    var key = live.index + ":" + live.direction;
    if (dir.dataset.key !== key) {
      dir.dataset.key = key;
      dir.textContent = phrase;
      document.getElementById("live-region").textContent = Music.midiToName(live.target) + ". " + phrase;
    }
    dir.className = "dir-" + live.direction;
    needle.hidden = false;
    var clamped = Math.max(-50, Math.min(50, live.cents));
    needle.style.left = (50 + clamped) + "%";
    needle.className = "needle dir-" + live.direction;
    hz.hidden = !state.showHz;
    hz.textContent = state.showHz ? formatHz(live.freq) : "";
  }

  function paintNoteTags() {
    var tuning = active();
    var used = new Set(tuning ? tuning.notes : []);
    document.querySelectorAll(".note-row").forEach(function (row) {
      row.querySelector(".ntag").textContent = used.has(Number(row.dataset.midi)) ? "в строе" : "";
    });
  }

  function paintNoteHighlight() {
    var layer = document.getElementById("notes-layer");
    if (layer.hidden) return;
    var midi = currentHighlight();
    var current = null;
    document.querySelectorAll(".note-row").forEach(function (row) {
      var on = midi != null && Number(row.dataset.midi) === midi;
      row.classList.toggle("on", on);
      if (on) current = row;
    });
    var freq = soundingFrequency();
    document.querySelectorAll(".nhz").forEach(function (el) { el.textContent = ""; });
    if (!current) {
      lastScrolled = null;
      return;
    }
    if (state.showHz && freq && current.querySelector(".nhz")) {
      current.querySelector(".nhz").textContent = formatHz(freq);
    }
    if (String(midi) === lastScrolled) return;
    var list = document.getElementById("note-list");
    var listRect = list.getBoundingClientRect();
    var rowRect = current.getBoundingClientRect();
    if (rowRect.top < listRect.top || rowRect.bottom > listRect.bottom) {
      var top = current.offsetTop - list.clientHeight / 2 + current.clientHeight / 2;
      list.scrollTo({ top: top, behavior: "smooth" });
    }
    lastScrolled = String(midi);
  }

  function paintLive() {
    document.querySelectorAll(".string-col").forEach(function (col) {
      var index = Number(col.dataset.index);
      var sounding = !!(live && live.index === index);
      col.classList.toggle("sounding", sounding);
      col.classList.toggle("intune", sounding && live.direction === "ok");
    });
    paintReadout();
    paintNoteHighlight();
  }

  function renderBoard() {
    var tuning = active();
    var root = document.getElementById("strings");
    if (!tuning) {
      root.innerHTML = "";
      return;
    }
    root.innerHTML = tuning.notes.map(function (midi, index) {
      var delta = offsetAt(midi, index);
      var cls = delta > 0 ? "plus" : delta < 0 ? "minus" : "zero";
      return '<div class="string-col" data-index="' + index + '">' +
        '<div class="s-meta">' +
        '<span class="s-note">' + noteHtml(midi) + "</span>" +
        '<span class="s-off ' + cls + '">' + Music.formatOffset(delta) + "</span></div>" +
        '<div class="s-line-wrap"><div class="s-hit"></div><div class="s-line"></div></div></div>';
    }).join("");
  }

  function stringLabel(index) {
    return ["Первая струна", "Вторая струна", "Третья струна", "Четвёртая струна", "Пятая струна", "Шестая струна"][index];
  }

  function withinStandard(midi, index) {
    var base = Music.STANDARD[index];
    return midi >= base - FRET_LIMIT && midi <= base + FRET_LIMIT;
  }

  function canShift(step) {
    var tuning = active();
    if (!tuning) return false;
    return tuning.notes.every(function (midi, index) {
      return withinStandard(midi + step, index);
    });
  }

  function syncTuner() {
    var tuning = active();
    document.getElementById("tuning-name").textContent = tuning ? "Строй: " + tuning.name : "Строй: нет";
    document.getElementById("empty-state").hidden = !!tuning;
    document.getElementById("board").hidden = !tuning;
    document.getElementById("fret-down").disabled = !canShift(-1);
    document.getElementById("fret-up").disabled = !canShift(1);
    if (tuning) renderBoard();
    paintNoteTags();
    paintLive();
  }

  function transpose(step) {
    var tuning = active();
    if (!tuning || !canShift(step)) return;
    tuning.notes = tuning.notes.map(function (midi) { return midi + step; });
    persist();
    bufferCache.clear();
    var stable = hist.length ? hist.slice().sort(function (a, b) { return a - b; })[hist.length >> 1] : null;
    lastString = null;
    inTuneHold = false;
    syncTuner();
    if (stable) applyStable(stable);
    toast(step > 0 ? "Строй поднят на лад" : "Строй опущен на лад");
  }

  function toast(message) {
    var el = document.getElementById("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 1600);
  }

  function renderLibrary() {
    var root = document.getElementById("library-list");
    if (!state.tunings.length) {
      root.innerHTML = '<div class="empty"><p>Пока нет строёв</p><p class="hint">Создайте строй, чтобы настроить гитару или услышать его.</p></div>';
      return;
    }
    root.innerHTML = state.tunings.map(function (tuning) {
      var notes = tuning.notes.map(noteHtml).join("  ");
      var offsets = tuning.notes.map(function (midi, index) {
        return Music.formatOffset(offsetAt(midi, index));
      }).join("  ");
      var selected = tuning.id === state.activeId ? " selected" : "";
      return '<article class="tune-card' + selected + '">' +
        '<button type="button" class="tune-open" data-open="' + esc(tuning.id) + '" aria-label="Открыть строй ' + esc(tuning.name) + '">' +
        '<span class="tune-name">' + esc(tuning.name) + "</span>" +
        (tuning.description ? '<span class="tune-desc">' + esc(tuning.description) + "</span>" : "") +
        '<span class="tune-notes">' + notes + "</span>" +
        '<span class="tune-offs">' + offsets + "</span></button>" +
        '<div class="tune-actions">' +
        '<button type="button" data-edit="' + esc(tuning.id) + '">Изменить</button>' +
        '<button type="button" class="danger" data-del="' + esc(tuning.id) + '">Удалить</button>' +
        "</div></article>";
    }).join("");
  }

  function scaleHtml(index) {
    var base = Music.STANDARD[index];
    var html = "";
    var midi;
    for (midi = base - FRET_LIMIT; midi <= base + FRET_LIMIT; midi++) {
      html += '<button type="button" class="key" data-midi="' + midi + '">' + noteHtml(midi) + "</button>";
    }
    return '<div class="scale"><div class="scale-row">' + html + "</div></div>";
  }

  function refreshString(index) {
    var card = document.getElementById("string-card-" + index);
    var midi = draft.notes[index];
    var delta = offsetAt(midi, index);
    card.querySelector(".big-note").innerHTML = noteHtml(midi);
    var off = card.querySelector(".off");
    off.textContent = Music.formatOffset(delta);
    off.className = "off " + (delta > 0 ? "plus" : delta < 0 ? "minus" : "zero");
    var selected = null;
    card.querySelectorAll(".key").forEach(function (button) {
      var on = Number(button.dataset.midi) === midi;
      button.classList.toggle("selected", on);
      if (on) selected = button;
    });
    centerScale(card.querySelector(".scale"));
  }

  function centerScale(scale) {
    if (!scale || !scale.clientWidth) return;
    var selected = scale.querySelector(".key.selected");
    if (!selected) return;
    var scaleRect = scale.getBoundingClientRect();
    var keyRect = selected.getBoundingClientRect();
    var delta = keyRect.left + keyRect.width / 2 - (scaleRect.left + scaleRect.width / 2);
    if (Math.abs(delta) > 1) scale.scrollLeft += delta;
  }

  function centerScales() {
    document.querySelectorAll("#editor-body .scale").forEach(centerScale);
  }

  function paintEditorTitle() {
    var name = document.getElementById("editor-name").value.trim();
    document.getElementById("editor-title").textContent = name || "Новый строй";
  }

  function renderEditor() {
    document.getElementById("editor-name").value = draft.name;
    document.getElementById("editor-name").classList.remove("invalid");
    document.getElementById("editor-desc").value = draft.description || "";
    paintEditorTitle();
    document.getElementById("editor-body").innerHTML = draft.notes.map(function (midi, index) {
      return '<article class="string-card" id="string-card-' + index + '" data-index="' + index + '">' +
        '<header><span class="label">' + stringLabel(index) + '</span>' +
        '<strong class="big-note"></strong><span class="off"></span></header>' +
        scaleHtml(index) + "</article>";
    }).join("");
    draft.notes.forEach(function (_, index) { refreshString(index); });
    if (!draft.name) {
      setTimeout(function () { document.getElementById("editor-name").focus(); }, 40);
    }
  }

  function saveDraft() {
    var input = document.getElementById("editor-name");
    var name = input.value.trim();
    var description = document.getElementById("editor-desc").value.trim().slice(0, 200);
    if (!name) {
      input.classList.add("invalid");
      input.focus();
      return;
    }
    var notes = draft.notes.slice();
    var id = draft.id;
    if (!id) {
      id = uid();
      state.tunings = state.tunings.concat([{ id: id, name: name, notes: notes, builtin: false, description: description }]);
    } else {
      state.tunings = state.tunings.map(function (tuning) {
        if (tuning.id !== id) return tuning;
        return { id: id, name: name, notes: notes, builtin: false, description: description };
      });
    }
    state.activeId = id;
    persist();
    resetDetection();
    bufferCache.clear();
    location.hash = "tuner";
  }

  function askDelete(id) {
    var tuning = state.tunings.find(function (item) { return item.id === id; });
    if (!tuning) return;
    document.getElementById("dialog-body").textContent = "«" + tuning.name + "» исчезнет из списка.";
    document.getElementById("dialog").hidden = false;
    document.getElementById("dialog-ok").onclick = function () {
      state.tunings = state.tunings.filter(function (item) { return item.id !== id; });
      if (state.activeId === id) state.activeId = state.tunings.length ? state.tunings[0].id : null;
      if (state.referenceId === id) state.referenceId = state.tunings.some(function (item) { return item.id === "standard"; }) ? "standard" : null;
      persist();
      document.getElementById("dialog").hidden = true;
      renderLibrary();
    };
  }

  function showView(name) {
    document.getElementById("view-tuner").hidden = name !== "tuner";
    document.getElementById("view-library").hidden = name !== "library";
    document.getElementById("view-editor").hidden = name !== "editor";
    document.getElementById("view-settings").hidden = name !== "settings";
    document.querySelector(".app").classList.toggle("editing", name === "editor");
    document.querySelectorAll("#tabs button").forEach(function (button) {
      var on = button.dataset.tab === name;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function parseRoute() {
    var hash = location.hash.replace(/^#/, "");
    if (hash.indexOf("edit/") === 0) return { name: "edit", id: decodeURIComponent(hash.slice(5)) };
    if (hash === "library") return { name: "library" };
    if (hash === "settings") return { name: "settings" };
    return { name: "tuner" };
  }

  function openEditor(id) {
    if (id === "new") {
      var base = active();
      draft = {
        id: null,
        name: "",
        description: "",
        notes: base ? base.notes.slice() : Music.STANDARD.slice(),
      };
    } else {
      var tuning = state.tunings.find(function (item) { return item.id === id; });
      if (!tuning) {
        location.hash = "library";
        return;
      }
      draft = { id: tuning.id, name: tuning.name, description: tuning.description || "", notes: tuning.notes.slice() };
    }
    renderEditor();
    showView("editor");
    requestAnimationFrame(function () { requestAnimationFrame(centerScales); });
  }

  function closeNotes() {
    document.getElementById("notes-layer").hidden = true;
    lastScrolled = null;
  }

  function openNotes() {
    paintNoteTags();
    document.getElementById("notes-layer").hidden = false;
    lastScrolled = null;
    paintNoteHighlight();
  }

  function renderSettings() {
    var toggle = document.getElementById("hz-toggle");
    toggle.classList.toggle("on", state.showHz);
    toggle.setAttribute("aria-pressed", state.showHz ? "true" : "false");
    document.getElementById("fret-down").disabled = !canShift(-1);
    document.getElementById("fret-up").disabled = !canShift(1);
    var select = document.getElementById("reference-select");
    select.innerHTML = state.tunings.map(function (tuning) {
      return '<option value="' + esc(tuning.id) + '">' + esc(tuning.name) + "</option>";
    }).join("");
    if (state.referenceId) select.value = state.referenceId;
  }

  function renderRoute() {
    closeNotes();
    var route = parseRoute();
    if (route.name === "library") {
      renderLibrary();
      showView("library");
    } else if (route.name === "settings") {
      renderSettings();
      showView("settings");
    } else if (route.name === "edit") {
      openEditor(route.id);
    } else {
      showView("tuner");
      syncTuner();
    }
  }

  function stringIndexAt(clientX, clientY) {
    var cols = document.querySelectorAll("#strings .string-col");
    var i;
    for (i = 0; i < cols.length; i++) {
      var hit = cols[i].querySelector(".s-hit");
      if (!hit) continue;
      var rect = hit.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      if (clientX < rect.left || clientX > rect.right) continue;
      return i;
    }
    return -1;
  }

  function pluckAt(clientX, clientY) {
    var index = stringIndexAt(clientX, clientY);
    if (index < 0) {
      lastIndex = -1;
      return;
    }
    if (index === lastIndex) return;
    lastIndex = index;
    pluck(index);
  }

  function buildNoteList() {
    document.getElementById("note-list").innerHTML = Music.catalog().map(function (midi) {
      var cls = Music.pitchClass(midi) === 0 ? "note-row octave-start" : "note-row";
      return '<div class="' + cls + '" data-midi="' + midi + '" role="listitem">' +
        '<span class="nn">' + noteHtml(midi) + '</span><span class="note-meta"><span class="ntag"></span><span class="nhz"></span></span></div>';
    }).join("");
  }

  function init() {
    buildNoteList();
    document.getElementById("tuning-name").addEventListener("click", function () { location.hash = "library"; });
    document.getElementById("readout").addEventListener("click", openNotes);
    document.getElementById("tabs").addEventListener("click", function (event) {
      var button = event.target.closest("[data-tab]");
      if (!button) return;
      location.hash = button.dataset.tab;
    });
    document.getElementById("hz-toggle").addEventListener("click", function () {
      state.showHz = !state.showHz;
      persist();
      renderSettings();
      paintReadout();
      paintNoteHighlight();
    });
    document.getElementById("reference-select").addEventListener("change", function (event) {
      state.referenceId = event.target.value || null;
      persist();
      if (active()) renderBoard();
      paintLive();
    });
    document.getElementById("notes-close").addEventListener("click", closeNotes);
    document.getElementById("notes-layer").addEventListener("click", function (event) {
      if (event.target.id === "notes-layer") closeNotes();
    });
    document.getElementById("fret-down").addEventListener("click", function () { transpose(-1); });
    document.getElementById("fret-up").addEventListener("click", function () { transpose(1); });
    document.getElementById("empty-create").addEventListener("click", function () { location.hash = "edit/new"; });
    document.getElementById("new-tuning").addEventListener("click", function () { location.hash = "edit/new"; });
    document.getElementById("editor-back").addEventListener("click", function () { location.hash = "library"; });
    document.getElementById("save-tuning").addEventListener("click", saveDraft);
    document.getElementById("dialog-cancel").addEventListener("click", function () {
      document.getElementById("dialog").hidden = true;
    });
    document.getElementById("dialog").addEventListener("click", function (event) {
      if (event.target.id === "dialog") document.getElementById("dialog").hidden = true;
    });
    document.getElementById("editor-name").addEventListener("input", function (event) {
      event.target.classList.remove("invalid");
      paintEditorTitle();
    });
    var editorBody = document.getElementById("editor-body");
    var scaleGesture = null;
    editorBody.addEventListener("touchstart", function (event) {
      var scale = event.target.closest(".scale");
      if (!scale) {
        scaleGesture = null;
        return;
      }
      var touch = event.changedTouches[0];
      scaleGesture = { scale: scale, x: touch.clientX, y: touch.clientY, left: scale.scrollLeft, axis: null };
    }, { passive: true });
    editorBody.addEventListener("touchmove", function (event) {
      if (!scaleGesture) return;
      var touch = event.touches[0];
      var dx = touch.clientX - scaleGesture.x;
      var dy = touch.clientY - scaleGesture.y;
      if (!scaleGesture.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        scaleGesture.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      }
      if (scaleGesture.axis !== "x") return;
      scaleGesture.scale.scrollLeft = scaleGesture.left - dx;
      if (event.cancelable) event.preventDefault();
    }, { passive: false });
    editorBody.addEventListener("touchend", function () { scaleGesture = null; });
    editorBody.addEventListener("touchcancel", function () { scaleGesture = null; });
    editorBody.addEventListener("wheel", function (event) {
      var scale = event.target.closest(".scale");
      if (!scale) return;
      var delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      var max = scale.scrollWidth - scale.clientWidth;
      if (max <= 0) return;
      var next = Math.max(0, Math.min(max, scale.scrollLeft + delta));
      if (next === scale.scrollLeft) return;
      scale.scrollLeft = next;
      event.preventDefault();
    }, { passive: false });
    editorBody.addEventListener("click", function (event) {
      var card = event.target.closest(".string-card");
      var key = event.target.closest("[data-midi]");
      if (!card || !key || !draft) return;
      var index = Number(card.dataset.index);
      var next = Number(key.dataset.midi);
      if (!withinStandard(next, index)) return;
      draft.notes[index] = next;
      refreshString(index);
    });
    document.getElementById("library-list").addEventListener("click", function (event) {
      var edit = event.target.closest("[data-edit]");
      if (edit) {
        location.hash = "edit/" + encodeURIComponent(edit.dataset.edit);
        return;
      }
      var del = event.target.closest("[data-del]");
      if (del) {
        askDelete(del.dataset.del);
        return;
      }
      var open = event.target.closest("[data-open]");
      if (!open) return;
      state.activeId = open.dataset.open;
      persist();
      resetDetection();
      location.hash = "tuner";
    });

    var board = document.getElementById("board");
    function beginDrag(clientX, clientY) {
      if (board.hidden || !active()) return false;
      dragging = true;
      lastIndex = -1;
      pluckAt(clientX, clientY);
      return true;
    }
    function endDrag() { dragging = false; lastIndex = -1; }
    board.addEventListener("touchstart", function (event) {
      var touch = event.changedTouches[0];
      if (!beginDrag(touch.clientX, touch.clientY)) return;
      if (event.cancelable) event.preventDefault();
    }, { passive: false });
    board.addEventListener("touchmove", function (event) {
      if (!dragging) return;
      var touch = event.touches[0];
      pluckAt(touch.clientX, touch.clientY);
      if (event.cancelable) event.preventDefault();
    }, { passive: false });
    board.addEventListener("touchend", endDrag);
    board.addEventListener("touchcancel", endDrag);
    board.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "touch") return;
      if (!beginDrag(event.clientX, event.clientY)) return;
      if (board.setPointerCapture) {
        try { board.setPointerCapture(event.pointerId); } catch (error) {}
      }
    });
    board.addEventListener("pointermove", function (event) {
      if (event.pointerType === "touch" || !dragging) return;
      pluckAt(event.clientX, event.clientY);
    });
    board.addEventListener("pointerup", function (event) {
      if (event.pointerType === "touch") return;
      endDrag();
    });
    board.addEventListener("pointercancel", endDrag);

    var tap = null;
    var swallowClickUntil = 0;
    document.addEventListener("touchstart", function (event) {
      var touch = event.changedTouches[0];
      tap = { x: touch.clientX, y: touch.clientY };
      primeAudio();
    }, { capture: true, passive: true });
    document.addEventListener("touchend", function (event) {
      var button = event.target.closest("button");
      if (!button || button.disabled || !tap) return;
      var touch = event.changedTouches[0];
      if (Math.abs(touch.clientX - tap.x) > 12 || Math.abs(touch.clientY - tap.y) > 12) return;
      if (event.cancelable) event.preventDefault();
      swallowClickUntil = performance.now() + 700;
      button.click();
    }, { capture: true, passive: false });
    document.addEventListener("click", function (event) {
      if (event.isTrusted && performance.now() < swallowClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    document.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "touch") return;
      primeAudio();
    }, true);
    ["gesturestart", "gesturechange", "gestureend"].forEach(function (type) {
      document.addEventListener(type, function (event) { event.preventDefault(); }, { passive: false });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (!document.getElementById("dialog").hidden) {
          document.getElementById("dialog").hidden = true;
          return;
        }
        if (!document.getElementById("notes-layer").hidden) closeNotes();
        return;
      }
      if (event.repeat) return;
      if (event.target && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA")) return;
      if (parseRoute().name !== "tuner") return;
      if (event.key >= "1" && event.key <= "6") pluck(Number(event.key) - 1);
    });

    document.addEventListener("visibilitychange", function () {
      if (ctx && master) {
        var time = ctx.currentTime;
        if (document.hidden) master.gain.setTargetAtTime(0.0001, time, 0.05);
        else master.gain.setTargetAtTime(1, time, 0.08);
      }
      if (document.hidden) {
        if (micOn) haltMic(true);
      } else if (!micBlocked && audioPrimed) {
        startMic();
      }
    });

    window.addEventListener("hashchange", renderRoute);
    renderRoute();
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!ios) startMic();
  }

  init();
})();
