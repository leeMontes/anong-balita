// app.js — UI controller for Anong Balita? (iPhone 4 edition).
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var MIN_HANDLE = 3;

  var state = {
    mode: "host",
    role: "host",
    view: "radio",
    net: null,
    mic: null,
    inChannel: false,
    transmitting: false,
    members: [],
    handle: "",
    groupName: "",
    wakeLock: null,
    vu: 0,
    talking: new Set(),
    hostRetries: 0
  };

  var SESSION_KEY = "anongbalita.session.v2";

  function saveSession(role, handle, name, groupName) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        role: role, handle: handle || "", name: name || "",
        groupName: groupName || "", ts: Date.now()
      }));
    } catch (e) {}
  }
  function loadSession() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!s || (s.role !== "host" && s.role !== "join")) return null;
      return s;
    } catch (e) { return null; }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function showSavedChip(handle) {
    var chip = $("saved-chip");
    if (!chip) return;
    if (handle) {
      chip.textContent = "\u21BB REUSE CHANNEL  " + handle;
      chip.setAttribute("data-handle", handle);
      chip.classList.remove("hidden");
    } else {
      chip.classList.add("hidden");
    }
  }

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

  // ------------------------------------------------------------------ tabs
  function switchView(name) {
    state.view = name;
    show($("view-radio"), name === "radio");
    show($("view-chat"), name === "chat");
    document.querySelectorAll(".tabbar [data-tab]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
  }

  // ------------------------------------------------------------ mode switch
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".mode-switch button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-mode") === mode);
    });
    show($("form-host"), mode === "host");
    show($("form-join"), mode === "join");
    setStatus(mode === "host" ? "SET A CHANNEL TO BROADCAST..." : "ENTER A HANDLE TO TUNE IN...");
  }

  // --------------------------------------------------------------- channel
  function enterChannel() {
    state.inChannel = true;
    state.hostRetries = 0;
    show($("screen-home"), false);
    show($("screen-channel"), true);
    show($("btn-leave"), true);
    $("chan-group").textContent = state.groupName || "----";
    $("chan-handle").textContent = state.handle || "-----";
    switchView("radio");
    setChatEnabled(true);
    addSystem("TUNED IN TO " + String(state.handle).toUpperCase());
    requestWakeLock();
    setMediaSession();
    window.RadioAudio.resumeCtx();
  }

  function renderMembers(members) {
    state.members = members || [];
    $("chan-count").textContent = state.members.length;
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
      li.appendChild(dot); li.appendChild(name); li.appendChild(tag);
      roster.appendChild(li);
    });
  }

  function setTalking(peerId, active) {
    if (active) state.talking.add(peerId);
    else state.talking.delete(peerId);
    renderMembers(state.members);
  }

  // ------------------------------------------------------------------ chat
  function addSystem(text) {
    var log = $("chat-log");
    if (!log) return;
    var li = document.createElement("li");
    li.className = "chat-system";
    li.textContent = "\u2014 " + text + " \u2014";
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
  }

  function addChat(msg) {
    if (!msg) return;
    var log = $("chat-log");
    if (!log) return;
    var out = !!msg.self;
    var li = document.createElement("li");
    li.className = "bubble " + (out ? "out" : "in");
    var meta = document.createElement("div");
    meta.className = "bubble-meta";
    meta.textContent = (out ? "YOU" : (msg.name || "???").toUpperCase()) + " \u00b7 " + timeOf(msg.ts);
    var body = document.createElement("div");
    body.className = "bubble-text";
    body.textContent = msg.text;
    li.appendChild(meta);
    li.appendChild(body);
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
    window.RadioAudio.squelchOpen();
  }

  function clearChat() {
    var log = $("chat-log");
    if (log) log.innerHTML = "";
  }

  function setChatEnabled(on) {
    var input = $("chat-input");
    var send = $("chat-send");
    if (input) { input.disabled = !on; input.placeholder = on ? "Message" : "Tune in to chat"; }
    if (send) send.disabled = !on;
    var empty = $("chat-empty");
    if (empty) empty.classList.toggle("hidden", on);
  }

  function sendChat() {
    var input = $("chat-input");
    if (!input || !state.inChannel) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    if (state.net) state.net.sendChat(text);
  }

  function timeOf(ts) {
    var d = ts ? new Date(ts) : new Date();
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  // ------------------------------------------------------------------ host
  async function doHost(forceHandle) {
    if (forceHandle && typeof forceHandle !== "string") forceHandle = null;
    var groupName = ($("input-group-name").value || "").trim();
    var handle = window.RadioNet.cleanHandle(forceHandle || $("input-handle").value);
    var name = ($("input-host-name").value || "").trim() || "BASE";
    if (!groupName) {
      setStatus("!! NAME YOUR BALITA GROUP !!", "err");
      $("input-group-name").focus();
      return;
    }
    if (handle.length < MIN_HANDLE) {
      handle = window.RadioNet.makeHandle(8);
      $("input-handle").value = handle;
    }
    state.role = "host";
    saveSession("host", handle, name, groupName);
    await boot(function () {
      state.groupName = groupName;
      state.handle = handle;
      var net = new window.RadioNet.Radio({
        onMembers: renderMembers,
        onStatus: onNetStatus,
        onTalking: function (t) { setTalking(t.peerId, t.active); },
        onChat: addChat,
        onSelf: function (s) { state.groupName = s.groupName || state.groupName; },
        onError: onError
      });
      net.startHost({ handle: handle, groupName: groupName, name: name, mic: state.mic });
      state.net = net;
      enterChannel();
      window.RadioQR.renderHandle($("qr"), handle, function () {});
      $("qr-wrap").classList.remove("hidden");
    });
  }

  // ------------------------------------------------------------------ join
  async function doJoin() {
    var handle = window.RadioNet.cleanHandle($("input-join-handle").value);
    var name = ($("input-join-name").value || "").trim() || "UNIT";
    if (handle.length < MIN_HANDLE) {
      setStatus("!! HANDLE MUST BE " + MIN_HANDLE + "+ CHARACTERS !!", "err");
      $("input-join-handle").focus();
      return;
    }
    state.role = "join";
    saveSession("join", handle, name, "");
    await boot(function () {
      var net = new window.RadioNet.Radio({
        onMembers: renderMembers,
        onStatus: onNetStatus,
        onTalking: function (t) { setTalking(t.peerId, t.active); },
        onChat: addChat,
        onSelf: function (s) {
          state.groupName = s.groupName || "";
          $("chan-group").textContent = state.groupName || "----";
          saveSession("join", handle, name, state.groupName);
        },
        onError: onError
      });
      state.net = net;
      state.handle = handle;
      state.groupName = "";
      enterChannel();
      $("qr-wrap").classList.add("hidden");
      net.startJoin({ handle: handle, name: name, mic: state.mic });
    });
  }

  // ------------------------------------------------ shared boot: mic + beeps
  async function boot(run) {
    setStatus("POWERING UP MIC...");
    window.RadioAudio.resumeCtx();
    try {
      state.mic = await window.RadioAudio.getMic();
    } catch (e) {
      setStatus("!! MIC BLOCKED — TAP TO ALLOW & RESUME !!", "err");
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
    if (msg === "unavailable-id") {
      if (state.mode === "host" && state.hostRetries < 3 && state.handle) {
        state.hostRetries++;
        setStatus("HANDLE BUSY — RECLAIMING " + state.handle + "...", "ok");
        dropNet();
        setTimeout(function () { doHost(state.handle); }, 1500);
        return;
      }
      setStatus("!! HANDLE IN USE — TRY ANOTHER !!", "err");
      teardown(false);
    } else if (msg === "peer-unavailable") {
      setStatus("!! NO STATION ON THAT HANDLE !!", "err");
      teardown(false);
    } else if (msg !== "network") {
      setStatus("!! " + String(msg).toUpperCase() + " !!", "err");
    }
  }

  // ------------------------------------------------------------------- PTT
  function setWtLed(on) {
    var led = $("wt-led");
    if (led) led.classList.toggle("on", !!on);
  }

  function pttDown(e) {
    if (!state.inChannel || state.transmitting) return;
    if (e) e.preventDefault();
    state.transmitting = true;
    $("ptt").classList.add("active");
    $("led-tx").classList.add("on");
    setWtLed(true);
    window.RadioAudio.squelchOpen();
    if (state.net) state.net.setTransmitting(true);
  }
  function pttUp(e) {
    if (!state.transmitting) return;
    if (e) e.preventDefault();
    state.transmitting = false;
    $("ptt").classList.remove("active");
    $("led-tx").classList.remove("on");
    setWtLed(false);
    if (state.net) state.net.setTransmitting(false);
    window.RadioAudio.rogerBeep();
  }

  // --------------------------------------------------------------- teardown
  function dropNet() {
    if (state.net) { state.net.destroy(); state.net = null; }
    if (state.mic) {
      state.mic.getTracks().forEach(function (t) { t.stop(); });
      state.mic = null;
    }
    state.transmitting = false;
    state.talking.clear();
  }

  function teardown(clearSaved) {
    dropNet();
    state.inChannel = false;
    show($("screen-channel"), false);
    show($("screen-home"), true);
    show($("btn-leave"), false);
    setChatEnabled(false);
    clearChat();
    if (clearSaved) {
      clearSession();
      setStatus("CHANNEL CLOSED.", "");
    }
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
        title: "Anong Balita?",
        artist: state.groupName || "BALITA GROUP",
        album: "CH " + (state.handle || "")
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
    var el = $("status-clock");
    if (el) el.textContent = hh + ":" + mm;
  }

  // ---------------------------------------------------------------- VU loop
  function buildVu() {
    var wrap = $("vu-bars");
    if (!wrap || wrap.childElementCount) return;
    for (var i = 0; i < 12; i++) {
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
      $("led-rx").classList.toggle("on", inc > 0.06 && !state.transmitting);
    }
    state.vu = state.vu * 0.7 + level * 0.3;
    var bars = $("vu-bars").children;
    var lit = Math.round(state.vu * bars.length);
    for (var i = 0; i < bars.length; i++) bars[i].classList.toggle("lit", i < lit);
  }

  // ------------------------------------------------------------------- init
  function init() {
    buildVu();
    setMode("host");
    setChatEnabled(false);

    document.querySelectorAll(".mode-switch button").forEach(function (b) {
      b.addEventListener("click", function () { setMode(b.getAttribute("data-mode")); });
    });
    document.querySelectorAll(".tabbar [data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { switchView(b.getAttribute("data-tab")); });
    });

    $("input-join-handle").addEventListener("input", function (e) {
      e.target.value = window.RadioNet.cleanHandle(e.target.value);
    });
    $("input-handle").addEventListener("input", function (e) {
      e.target.value = window.RadioNet.cleanHandle(e.target.value);
    });

    $("btn-random").addEventListener("click", function () {
      $("input-handle").value = window.RadioNet.makeHandle(8);
    });
    $("saved-chip").addEventListener("click", function () {
      var h = this.getAttribute("data-handle") || "";
      if (!h) return;
      $("input-handle").value = h;
      $("input-join-handle").value = h;
      setStatus("CHANNEL READY \u2014 TAP BROADCAST OR TUNE IN.", "ok");
    });
    $("btn-create").addEventListener("click", function () { doHost(); });
    $("btn-join").addEventListener("click", function () { doJoin(); });
    $("btn-leave").addEventListener("click", function () {
      window.RadioAudio.rogerBeep();
      teardown(true);
    });

    $("chat-send").addEventListener("click", sendChat);
    $("chat-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); sendChat(); }
    });

    var ptt = $("ptt");
    ptt.addEventListener("pointerdown", pttDown);
    ptt.addEventListener("pointerup", pttUp);
    ptt.addEventListener("pointercancel", pttUp);
    ptt.addEventListener("pointerleave", function (e) { if (state.transmitting) pttUp(e); });
    ptt.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    document.addEventListener("keydown", function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (e.code === "Space" && !e.repeat && tag !== "INPUT" && tag !== "TEXTAREA") pttDown(e);
    });
    document.addEventListener("keyup", function (e) {
      if (e.code === "Space") pttUp(e);
    });

    // Restore last channel; a scanned QR (#join=) wins over the saved one.
    var saved = loadSession();
    showSavedChip(saved && saved.handle ? saved.handle : "");
    var joinMatch = /join=([^&]+)/.exec(location.hash || "");
    if (joinMatch) {
      setMode("join");
      $("input-join-handle").value = window.RadioNet.cleanHandle(decodeURIComponent(joinMatch[1]));
      if (saved && saved.name) $("input-join-name").value = saved.name;
      switchView("radio");
      setStatus("CODE DETECTED — ADD A NAME AND TUNE IN.", "ok");
    } else if (/#chat/.test(location.hash || "")) {
      switchView("chat");
    } else if (saved) {
      setMode(saved.role === "join" ? "join" : "host");
      if (saved.groupName) $("input-group-name").value = saved.groupName;
      if (saved.name) {
        $("input-host-name").value = saved.name;
        $("input-join-name").value = saved.name;
      }
      if (saved.handle) {
        $("input-handle").value = saved.handle;
        $("input-join-handle").value = saved.handle;
      }
      setStatus("RESUMING " + String(saved.handle || "LAST CHANNEL").toUpperCase() + "...", "ok");
      setTimeout(function () {
        if (saved.role === "join") doJoin();
        else doHost(saved.handle);
      }, 500);
    }

    tickClock();
    setInterval(tickClock, 15000);
    setInterval(vuLoop, 60);

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
          .then(function (reg) { if (reg.update) reg.update(); })
          .catch(function () {});
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
