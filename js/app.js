// app.js — UI controller for Anong Balita?.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    mode: "host",
    net: null,
    mic: null,
    inChannel: false,
    transmitting: false,
    members: [],
    code: "",
    groupName: "",
    wakeLock: null,
    vu: 0,
    talking: new Set()
  };

  // ---------------------------------------------------------------- helpers
  function show(el, on) {
    if (!el) return;
    el.classList.toggle("hidden", !on);
  }

  function setStatus(text, cls) {
    var el = $("home-status");
    if (!el) return;
    el.textContent = text;
    el.className = "status-line" + (cls ? " " + cls : "");
  }

  function flash(el) {
    if (!el) return;
    el.classList.remove("blip");
    void el.offsetWidth;
    el.classList.add("blip");
  }

  // ------------------------------------------------------------ mode switch
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".mode-switch button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-mode") === mode);
    });
    show($("form-host"), mode === "host");
    show($("form-join"), mode === "join");
    setStatus(mode === "host" ? "SET A FREQUENCY TO BROADCAST..." : "ENTER A CODE TO TUNE IN...");
  }

  // --------------------------------------------------------------- channel
  function enterChannel() {
    state.inChannel = true;
    show($("screen-home"), false);
    show($("screen-channel"), true);
    show($("btn-leave"), true);
    $("chan-group").textContent = state.groupName || "----";
    $("chan-code").textContent = state.code || "-----";
    requestWakeLock();
    setMediaSession();
    window.RadioAudio.resumeCtx();
  }

  function renderMembers(members) {
    state.members = members || [];
    var count = state.members.length;
    $("chan-count").textContent = count;
    var roster = $("roster");
    roster.innerHTML = "";
    state.members.forEach(function (m) {
      var li = document.createElement("li");
      li.className = "member" + (m.isHost ? " host" : "") +
        (state.talking.has(m.peerId) ? " talking" : "");
      var dot = document.createElement("span");
      dot.className = "member-dot";
      var name = document.createElement("span");
      name.className = "member-name";
      name.textContent = (m.name || "???").toUpperCase();
      var tag = document.createElement("span");
      tag.className = "member-tag";
      tag.textContent = m.isHost ? "BASE" : "UNIT";
      li.appendChild(dot);
      li.appendChild(name);
      li.appendChild(tag);
      roster.appendChild(li);
    });
  }

  function setTalking(peerId, active, name) {
    if (active) state.talking.add(peerId);
    else state.talking.delete(peerId);
    if (active) {
      $("led-rx").classList.add("on");
    }
    renderMembers(state.members);
  }

  // ------------------------------------------------------------------ host
  async function doHost() {
    var groupName = ($("input-group-name").value || "").trim();
    var name = ($("input-host-name").value || "").trim() || "BASE";
    if (!groupName) {
      setStatus("!! ENTER A BALITA GROUP NAME !!", "err");
      $("input-group-name").focus();
      return;
    }
    await boot(function () {
      state.groupName = groupName;
      var net = new window.RadioNet.Radio({
        onMembers: renderMembers,
        onStatus: onNetStatus,
        onTalking: function (t) { setTalking(t.peerId, t.active, t.name); },
        onSelf: function (s) { state.groupName = s.groupName || state.groupName; },
        onError: onError
      });
      var code = net.startHost({ code: window.RadioNet.makeCode(5), groupName: groupName, name: name, mic: state.mic });
      state.net = net;
      state.code = code;
      enterChannel();
      window.RadioQR.renderCode($("qr"), code, function () {});
      $("qr-wrap").classList.remove("hidden");
    });
  }

  // ------------------------------------------------------------------ join
  async function doJoin() {
    var code = window.RadioNet.cleanCode($("input-join-code").value);
    var name = ($("input-join-name").value || "").trim() || "UNIT";
    if (code.length < 5) {
      setStatus("!! CODE MUST BE 5 CHARACTERS !!", "err");
      $("input-join-code").focus();
      return;
    }
    await boot(function () {
      var net = new window.RadioNet.Radio({
        onMembers: renderMembers,
        onStatus: onNetStatus,
        onTalking: function (t) { setTalking(t.peerId, t.active, t.name); },
        onSelf: function (s) {
          state.groupName = s.groupName || "";
          $("chan-group").textContent = state.groupName || "----";
        },
        onError: onError
      });
      state.net = net;
      state.code = code;
      state.groupName = "";
      enterChannel();
      $("qr-wrap").classList.add("hidden");
      net.startJoin({ code: code, name: name, mic: state.mic });
    });
  }

  // ------------------------------------------------ shared boot: mic + beeps
  async function boot(run) {
    setStatus("POWERING UP MIC...");
    window.RadioAudio.resumeCtx();
    try {
      state.mic = await window.RadioAudio.getMic();
    } catch (e) {
      setStatus("!! MIC ACCESS DENIED — CHECK PERMISSIONS !!", "err");
      throw e;
    }
    state.mic.getAudioTracks().forEach(function (t) { t.enabled = false; });
    window.RadioAudio.bootBeep();
    run();
  }

  function onNetStatus(status) {
    var led = $("led-link");
    if (!led) return;
    if (status === "online") led.classList.add("on");
    if (status === "disconnected" || status === "reconnecting") led.classList.remove("on");
  }

  function onError(err) {
    var msg = (err && err.type) ? err.type : "ERROR";
    if (msg === "peer-unavailable") {
      setStatus("!! NO STATION ON THAT FREQUENCY !!", "err");
      teardown();
    } else if (msg === "unavailable-id") {
      setStatus("!! FREQUENCY IN USE — TRY AGAIN !!", "err");
      teardown();
    } else if (msg !== "network") {
      setStatus("!! " + String(msg).toUpperCase() + " !!", "err");
    }
  }

  // ------------------------------------------------------------------- PTT
  function pttDown(e) {
    if (!state.inChannel || state.transmitting) return;
    if (e) e.preventDefault();
    state.transmitting = true;
    $("ptt").classList.add("active");
    $("led-tx").classList.add("on");
    window.RadioAudio.squelchOpen();
    if (state.net) state.net.setTransmitting(true);
  }

  function pttUp(e) {
    if (!state.transmitting) return;
    if (e) e.preventDefault();
    state.transmitting = false;
    $("ptt").classList.remove("active");
    $("led-tx").classList.remove("on");
    if (state.net) state.net.setTransmitting(false);
    window.RadioAudio.rogerBeep();
  }

  // --------------------------------------------------------------- teardown
  function teardown() {
    if (state.net) { state.net.destroy(); state.net = null; }
    if (state.mic) {
      state.mic.getTracks().forEach(function (t) { t.stop(); });
      state.mic = null;
    }
    state.inChannel = false;
    state.transmitting = false;
    state.talking.clear();
    show($("screen-channel"), false);
    show($("screen-home"), true);
    show($("btn-leave"), false);
    document.querySelector(".unit").classList.remove("in-channel");
    setStatus("CHANNEL CLOSED.", "");
  }

  // -------------------------------------------------- background keep-alive
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        state.wakeLock = await navigator.wakeLock.request("screen");
        state.wakeLock.addEventListener("release", function () { state.wakeLock = null; });
      }
    } catch (e) {}
  }

  function setMediaSession() {
    if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: "ANONG BALITA?",
        artist: state.groupName || "BALITA GROUP",
        album: "FREQ " + (state.code || "")
      });
      navigator.mediaSession.playbackState = "playing";
    } catch (e) {}
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      window.RadioAudio.resumeCtx();
      window.RadioAudio.replayAll();
      if (state.inChannel) requestWakeLock();
    }
  });

  // ------------------------------------------------------------------ clock
  function tickClock() {
    var d = new Date();
    var hh = ("0" + d.getHours()).slice(-2);
    var mm = ("0" + d.getMinutes()).slice(-2);
    var el = $("clock");
    if (el) el.textContent = hh + ":" + mm;
  }

  // ---------------------------------------------------------------- VU loop
  function buildVu() {
    var wrap = $("vu-bars");
    if (!wrap || wrap.childElementCount) return;
    for (var i = 0; i < 14; i++) {
      var b = document.createElement("span");
      b.className = "vu-bar";
      wrap.appendChild(b);
    }
  }

  function vuLoop() {
    var level = 0;
    if (state.net) {
      var self = state.net.selfMeter();
      var mic = self ? self.getLevel() : 0;
      var inc = state.net.incomingLevel();
      level = Math.max(mic, inc);
      var rx = inc > 0.06 && !state.transmitting;
      $("led-rx").classList.toggle("on", rx);
    }
    state.vu = state.vu * 0.7 + level * 0.3;
    var bars = $("vu-bars").children;
    var lit = Math.round(state.vu * bars.length);
    for (var i = 0; i < bars.length; i++) {
      bars[i].classList.toggle("lit", i < lit);
    }
  }

  // ------------------------------------------------------------------- init
  function init() {
    buildVu();
    setMode("host");

    document.querySelectorAll(".mode-switch button").forEach(function (b) {
      b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); });
    });

    $("input-join-code").addEventListener("input", function (e) {
      e.target.value = window.RadioNet.cleanCode(e.target.value);
    });

    $("btn-create").addEventListener("click", doHost);
    $("btn-join").addEventListener("click", doJoin);
    $("btn-leave").addEventListener("click", function () {
      window.RadioAudio.rogerBeep();
      teardown();
    });

    var ptt = $("ptt");
    ptt.addEventListener("pointerdown", pttDown);
    ptt.addEventListener("pointerup", pttUp);
    ptt.addEventListener("pointercancel", pttUp);
    ptt.addEventListener("pointerleave", function (e) { if (state.transmitting) pttUp(e); });
    ptt.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    document.addEventListener("keydown", function (e) {
      if (e.code === "Space" && !e.repeat && document.activeElement.tagName !== "INPUT") {
        pttDown(e);
      }
    });
    document.addEventListener("keyup", function (e) {
      if (e.code === "Space") pttUp(e);
    });

    // auto-join from a scanned QR (#join=CODE)
    var m = /join=([A-Za-z0-9]+)/.exec(location.hash || "");
    if (m) {
      setMode("join");
      $("input-join-code").value = window.RadioNet.cleanCode(m[1]);
      setStatus("CODE DETECTED — ADD A HANDLE AND TUNE IN.", "ok");
    }

    tickClock();
    setInterval(tickClock, 15000);
    setInterval(vuLoop, 60);

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
