// radio.js — PeerJS "Balita Group" networking.
// Topology: host relay bridge. The creator is the base station: every member
// sends mic audio to the host, the host mixes all members + its own mic into a
// single broadcast stream and sends that back to everyone. Member count lives
// on the host and is broadcast to the whole channel on every change.
(function () {
  "use strict";

  var HOST_PREFIX = "anongbalita-h-";
  var NODE_PREFIX = "anongbalita-n-";

  function hostPeerId(code) {
    return HOST_PREFIX + String(code).toLowerCase();
  }
  function newNodeId() {
    return NODE_PREFIX + Math.random().toString(36).slice(2, 11);
  }

  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I O 0 1
  function makeCode(len) {
    var out = "";
    for (var i = 0; i < (len || 5); i++) {
      out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out;
  }
  function cleanCode(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  }

  function Radio(opts) {
    opts = opts || {};
    this.onMembers = opts.onMembers || function () {};
    this.onStatus = opts.onStatus || function () {};
    this.onTalking = opts.onTalking || function () {};
    this.onSelf = opts.onSelf || function () {};
    this.onError = opts.onError || function () {};

    this.peer = null;
    this.isHost = false;
    this.code = null;
    this.groupName = "";
    this.myName = "";

    this.mic = null;
    this.ctx = null;
    this.broadcastDest = null;
    this.micGain = null;

    this.members = [];
    this.nodes = new Map(); // host: peerId -> {conn, name, stream, call, talking}
    this.hostConn = null; // joiner
    this.hostCall = null; // joiner
    this.hostTalking = false;
    this.meters = new Map();
  }

  Radio.prototype._hostStart = function (code, groupName, name, mic) {
    var self = this;
    this.isHost = true;
    this.code = code;
    this.groupName = groupName;
    this.myName = name;
    this.mic = mic;

    this.ctx = window.RadioAudio.getCtx();
    this.broadcastDest = this.ctx.createMediaStreamDestination();
    var src = this.ctx.createMediaStreamSource(mic);
    this.micGain = this.ctx.createGain();
    this.micGain.gain.value = 0; // PTT off
    src.connect(this.micGain).connect(this.broadcastDest);

    this.members = [{ peerId: "host", name: name, isHost: true, talking: false }];

    this.peer = new Peer(hostPeerId(code));
    this.peer.on("open", function () {
      self.onStatus("online");
    });
    this.peer.on("connection", function (conn) {
      self._onHostConn(conn);
    });
    this.peer.on("call", function (call) {
      self._onHostCall(call);
    });
    this.peer.on("error", function (err) {
      self.onError(err);
    });
    this.peer.on("disconnected", function () {
      self.onStatus("reconnecting");
      try { self.peer.reconnect(); } catch (e) {}
    });
  };

  Radio.prototype._onHostConn = function (conn) {
    var self = this;
    conn.on("data", function (data) {
      if (!data || !data.type) return;
      var rec = self.nodes.get(conn.peer);
      if (data.type === "join") {
        if (!rec) {
          rec = { conn: conn, name: data.name || "UNKNOWN", stream: null, talking: false };
          self.nodes.set(conn.peer, rec);
        } else {
          rec.name = data.name || rec.name;
        }
        conn.send({
          type: "welcome",
          code: self.code,
          groupName: self.groupName,
          hostName: self.myName,
          members: self.members
        });
        self._rebuildMembers();
        self._broadcastMembers();
      } else if (data.type === "ptt") {
        if (rec) {
          rec.talking = !!data.active;
          self._rebuildMembers();
          self._broadcast({
            type: "ptt",
            peerId: conn.peer,
            name: rec.name,
            active: !!data.active
          });
        }
      }
    });
    conn.on("close", function () {
      self.nodes.delete(conn.peer);
      window.RadioAudio.detachAudio(conn.peer);
      self.meters.delete(conn.peer);
      self._rebuildMembers();
      self._broadcastMembers();
    });
    conn.on("error", function () {});
  };

  Radio.prototype._onHostCall = function (call) {
    var self = this;
    call.answer(this.broadcastDest.stream);
    call.on("stream", function (stream) {
      var rec = self.nodes.get(call.peer);
      if (!rec) {
        rec = { conn: null, name: "UNKNOWN", stream: null, talking: false };
        self.nodes.set(call.peer, rec);
      }
      rec.stream = stream;
      rec.call = call;

      var src = self.ctx.createMediaStreamSource(stream);
      var g = self.ctx.createGain();
      g.gain.value = 0.9;
      src.connect(g).connect(self.broadcastDest);

      // Host monitors members locally (host never plays its own broadcast).
      window.RadioAudio.attachAudio(call.peer, stream);
      self.meters.set(call.peer, window.RadioAudio.makeLevelMeter(stream, self.ctx));

      self._rebuildMembers();
      self._broadcastMembers();
    });
    call.on("close", function () {
      window.RadioAudio.detachAudio(call.peer);
      self.meters.delete(call.peer);
    });
  };

  Radio.prototype._joinStart = function (code, name, mic) {
    var self = this;
    this.isHost = false;
    this.code = code;
    this.myName = name;
    this.mic = mic;
    this.ctx = window.RadioAudio.getCtx();

    this.peer = new Peer(newNodeId());
    this.peer.on("open", function () {
      self._connectToHost();
    });
    this.peer.on("error", function (err) {
      self.onError(err);
    });
    this.peer.on("disconnected", function () {
      self.onStatus("reconnecting");
      try { self.peer.reconnect(); } catch (e) {}
    });
  };

  Radio.prototype._connectToHost = function () {
    var self = this;
    var hostId = hostPeerId(this.code);
    var conn = this.peer.connect(hostId, { reliable: true });
    this.hostConn = conn;

    conn.on("open", function () {
      conn.send({ type: "join", name: self.myName });
      self.onStatus("online");
      self._callHost(hostId);
    });
    conn.on("data", function (data) {
      if (!data || !data.type) return;
      if (data.type === "welcome") {
        self.groupName = data.groupName || "";
        self.members = data.members || self.members;
        self.onSelf({ groupName: self.groupName, code: self.code });
        self.onMembers(self.members);
      } else if (data.type === "members") {
        self.members = data.members || [];
        self.onMembers(self.members);
      } else if (data.type === "ptt") {
        self.onTalking({ peerId: data.peerId, name: data.name, active: !!data.active });
      }
    });
    conn.on("close", function () {
      self.onStatus("disconnected");
    });
    conn.on("error", function (err) {
      self.onError(err);
    });
  };

  Radio.prototype._callHost = function (hostId) {
    var self = this;
    var call = this.peer.call(hostId, this.mic);
    this.hostCall = call;
    call.on("stream", function (remote) {
      window.RadioAudio.attachAudio("broadcast", remote);
      self.meters.set("broadcast", window.RadioAudio.makeLevelMeter(remote, self.ctx));
      self.onStatus("online");
    });
    call.on("close", function () {
      self.onStatus("disconnected");
    });
  };

  Radio.prototype._rebuildMembers = function () {
    var arr = [{ peerId: "host", name: this.myName, isHost: true, talking: !!this.hostTalking }];
    this.nodes.forEach(function (rec, peerId) {
      arr.push({ peerId: peerId, name: rec.name || "???", isHost: false, talking: !!rec.talking });
    });
    this.members = arr;
    this.onMembers(arr);
  };

  Radio.prototype._broadcast = function (msg) {
    this.nodes.forEach(function (rec) {
      if (rec.conn && rec.conn.open) {
        try { rec.conn.send(msg); } catch (e) {}
      }
    });
  };

  Radio.prototype._broadcastMembers = function () {
    this._broadcast({ type: "members", members: this.members });
  };

  Radio.prototype.startHost = function (opts) {
    this._hostStart(opts.code || makeCode(5), opts.groupName || "BALITA GROUP", opts.name, opts.mic);
    return this.code;
  };

  Radio.prototype.startJoin = function (opts) {
    this._joinStart(cleanCode(opts.code), opts.name, opts.mic);
  };

  // PTT control. on=true means transmitting.
  Radio.prototype.setTransmitting = function (on) {
    if (this.isHost) {
      if (this.micGain) this.micGain.gain.value = on ? 1 : 0;
      this.hostTalking = on;
      this._rebuildMembers();
      this._broadcast({ type: "ptt", peerId: "host", name: this.myName, active: on });
    } else {
      if (this.mic) {
        this.mic.getAudioTracks().forEach(function (t) { t.enabled = on; });
      }
      if (this.hostConn && this.hostConn.open) {
        try { this.hostConn.send({ type: "ptt", active: on }); } catch (e) {}
      }
    }
  };

  Radio.prototype.selfMeter = function () {
    if (!this.meters.has("self") && this.mic && this.ctx) {
      this.meters.set("self", window.RadioAudio.makeLevelMeter(this.mic, this.ctx));
    }
    return this.meters.get("self");
  };

  Radio.prototype.incomingLevel = function () {
    var max = 0;
    this.meters.forEach(function (m, key) {
      if (key === "self") return;
      max = Math.max(max, m.getLevel());
    });
    return max;
  };

  Radio.prototype.destroy = function () {
    try { if (this.hostConn) this.hostConn.close(); } catch (e) {}
    try { if (this.hostCall) this.hostCall.close(); } catch (e) {}
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    window.RadioAudio.detachAudio("broadcast");
    this.nodes.forEach(function (rec, peerId) {
      window.RadioAudio.detachAudio(peerId);
    });
    this.nodes.clear();
    this.meters.clear();
  };

  window.RadioNet = {
    Radio: Radio,
    makeCode: makeCode,
    cleanCode: cleanCode,
    hostPeerId: hostPeerId
  };
})();
