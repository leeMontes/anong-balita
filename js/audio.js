// audio.js — mic capture, Web Audio graph, PTT gating, VU metering,
// roger beep, squelch static, and background keep-alive helpers.
(function () {
  "use strict";

  var ctx = null;
  var sink = null;

  function getSink() {
    if (!sink) {
      sink = document.getElementById("audio-sink");
      if (!sink) {
        sink = document.createElement("div");
        sink.id = "audio-sink";
        sink.style.display = "none";
        document.body.appendChild(sink);
      }
    }
    return sink;
  }

  function getCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    return ctx;
  }

  function resumeCtx() {
    var c = getCtx();
    if (c.state === "suspended") return c.resume();
    return Promise.resolve();
  }

  async function getMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
  }

  // Attach a remote MediaStream to a hidden <audio> element.
  function attachAudio(key, stream) {
    var root = getSink();
    var el = root.querySelector('[data-key="' + key + '"]');
    if (!el) {
      el = document.createElement("audio");
      el.setAttribute("data-key", key);
      el.setAttribute("playsinline", "");
      el.setAttribute("webkit-playsinline", "");
      el.autoplay = true;
      el.controls = false;
      root.appendChild(el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    var p = el.play();
    if (p && p.catch) p.catch(function () {});
    return el;
  }

  function detachAudio(key) {
    var root = getSink();
    var el = root.querySelector('[data-key="' + key + '"]');
    if (el) {
      try {
        el.pause();
        el.srcObject = null;
      } catch (e) {}
      el.remove();
    }
  }

  function replayAll() {
    var root = getSink();
    root.querySelectorAll("audio").forEach(function (el) {
      if (el.srcObject) {
        var p = el.play();
        if (p && p.catch) p.catch(function () {});
      }
    });
  }

  // ---- Level metering -----------------------------------------------------
  function makeLevelMeter(stream, ctxRef) {
    var c = ctxRef || getCtx();
    var src = c.createMediaStreamSource(stream);
    var analyser = c.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    var data = new Uint8Array(analyser.frequencyBinCount);
    return {
      getLevel: function () {
        analyser.getByteFrequencyData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i];
        return Math.min(1, sum / data.length / 90);
      }
    };
  }

  // ---- Retro sounds -------------------------------------------------------
  function tone(freq, start, dur, gain, type) {
    var c = getCtx();
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = type || "square";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // Roger beep: short chirp played on release-to-listen.
  function rogerBeep() {
    resumeCtx();
    var t = getCtx().currentTime;
    tone(1180, t, 0.09, 0.14, "square");
    tone(1560, t + 0.075, 0.09, 0.12, "square");
  }

  // Open-channel squelch click when a transmission begins.
  function squelchOpen() {
    resumeCtx();
    var c = getCtx();
    var t = c.currentTime;
    var buf = c.createBuffer(1, c.sampleRate * 0.12, c.sampleRate);
    var ch = buf.getChannelData(0);
    for (var i = 0; i < ch.length; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 2);
    }
    var src = c.createBufferSource();
    var g = c.createGain();
    g.gain.value = 0.12;
    var filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1400;
    src.buffer = buf;
    src.connect(filter).connect(g).connect(c.destination);
    src.start(t);
  }

  function bootBeep() {
    resumeCtx();
    var t = getCtx().currentTime;
    tone(660, t, 0.07, 0.1, "square");
    tone(880, t + 0.09, 0.07, 0.1, "square");
    tone(1320, t + 0.18, 0.12, 0.1, "square");
  }

  window.RadioAudio = {
    getCtx: getCtx,
    resumeCtx: resumeCtx,
    getMic: getMic,
    attachAudio: attachAudio,
    detachAudio: detachAudio,
    replayAll: replayAll,
    makeLevelMeter: makeLevelMeter,
    rogerBeep: rogerBeep,
    squelchOpen: squelchOpen,
    bootBeep: bootBeep
  };
})();
