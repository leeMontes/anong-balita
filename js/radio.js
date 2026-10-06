// radio.js — PeerJS "Balita Group" networking.
// Topology: host relay bridge. The creator is the base station: every member
// sends mic audio to the host, the host mixes all members + its own mic into a
// single broadcast stream and sends that back to everyone. Member count and
// chat live on the host and are broadcast to the whole channel.
(function () {
  "use strict";

  var HOST_PREFIX = "anongbalita-h-";
  var NODE_PREFIX = "anongbalita-n-";
  var MAX_HANDLE = 32;
  var MAX_CHAT = 500;

  function hostPeerId(handle) {
    return HOST_PREFIX + cleanHandle(handle);
  }
  function newNodeId() {
    return NODE_PREFIX + Math.random().toString(36).slice(2, 11);
  }

  // Channels are human-chosen but must map onto a safe PeerJS id:
  // letters/numbers/dash/underscore only, spaces become dashes.
  function cleanHandle(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_HANDLE);
  }

  var HANDLE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no i l o 0 1
  function makeHandle(len) {
    var out = "";
    for (var i = 0; i < (len || 8); i++) {
      out += HANDLE_ALPHABET[Math.floor(Math.random() * HANDLE_ALPHABET.length)];
    }
    return out;
  }

  function Radio(opts) {
    opts = opts || {};
    this.onMembers = opts.onMembers || function () {};
    this.onStatus = opts.onStatus || function () {};
    this.onTalking = opts.onTalking || function () {};
    this.onSelf = opts.onSelf || function () {};
    this.onChat = opts.onChat || function () {};
    this.onHostLeft = opts.onHostLeft || function () {};
    this.onError = opts.onError || function () {};

    this.destroying = false;
    this.hostLeftReported = false;

    this.peer = null;
    this.isHost = false;
    this.handle = null;
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

  Radio.prototype._hostStart = function (handle, groupName, name, mic) {
    var self = this;
    this.isHost = true;
    this.handle = handle;
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

    this.peer = new Peer(hostPeerId(handle));
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
          handle: self.handle,
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
      } else if (data.type === "chat" && rec) {
        var msg = {
          id: data.id || String(Date.now()) + Math.random().toString(36).slice(2, 6),
          peerId: conn.peer,
          name: rec.name,
          text: String(data.text || "").slice(0, MAX_CHAT),
          ts: Date.now()
        };
        self._broadcastExcept(conn.peer, { type: "chat", msg: msg });
        self.onChat(msg);
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

  Radio.prototype._joinStart = function (handle, name, mic) {
    var self = this;
    this.isHost = false;
    this.handle = handle;
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
    var hostId = hostPeerId(this.handle);
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
        self.onSelf({ groupName: self.groupName, handle: self.handle });
        self.onMembers(self.members);
      } else if (data.type === "members") {
        self.members = data.members || [];
        self.onMembers(self.members);
      } else if (data.type === "ptt") {
        self.onTalking({ peerId: data.peerId, name: data.name, active: !!data.active });
      } else if (data.type === "chat") {
        self.onChat(data.msg);
      }
    });
    conn.on("close", function () {
      self._hostGone();
      self.onStatus("disconnected");
    });
    conn.on("error", function (err) {
      self.onError(err);
    });
  };

  // The base station dropped. Only meaningful for joiners, and only once.
  Radio.prototype._hostGone = function () {
    if (this.isHost || this.destroying || this.hostLeftReported) return;
    this.hostLeftReported = true;
    this.onHostLeft();
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
      self._hostGone();
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

  Radio.prototype._broadcastExcept = function (exceptPeerId, msg) {
    this.nodes.forEach(function (rec, peerId) {
      if (peerId === exceptPeerId) return;
      if (rec.conn && rec.conn.open) {
        try { rec.conn.send(msg); } catch (e) {}
      }
    });
  };

  Radio.prototype._broadcastMembers = function () {
    this._broadcast({ type: "members", members: this.members });
  };

  Radio.prototype.startHost = function (opts) {
    var handle = cleanHandle(opts.handle) || makeHandle(8);
    this._hostStart(handle, opts.groupName || "BALITA GROUP", opts.name, opts.mic);
    return handle;
  };

  Radio.prototype.startJoin = function (opts) {
    this._joinStart(cleanHandle(opts.handle), opts.name, opts.mic);
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

  // Chat. Host echoes locally and relays to everyone else; a joiner echoes
  // locally and hands the message to the host for distribution.
  Radio.prototype.sendChat = function (text) {
    text = String(text || "").trim().slice(0, MAX_CHAT);
    if (!text) return;
    var id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    if (this.isHost) {
      var msg = { id: id, peerId: "host", name: this.myName, text: text, ts: Date.now(), self: true };
      this.onChat(msg);
      this._broadcast({ type: "chat", msg: { id: id, peerId: "host", name: this.myName, text: text, ts: msg.ts } });
    } else {
      this.onChat({ id: id, peerId: "me", name: this.myName, text: text, ts: Date.now(), self: true });
      if (this.hostConn && this.hostConn.open) {
        try { this.hostConn.send({ type: "chat", id: id, text: text }); } catch (e) {}
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
    this.destroying = true;
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
    makeHandle: makeHandle,
    cleanHandle: cleanHandle,
    hostPeerId: hostPeerId,
    MAX_HANDLE: MAX_HANDLE,
    MAX_CHAT: MAX_CHAT
  };
})();
