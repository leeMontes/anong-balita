// qr.js — renders the join URL as a crisp SVG QR using qrcode-generator.
(function () {
  "use strict";

  function joinUrl(handle) {
    // Clean URL (no index.html) so the #join fragment survives the host's
    // index.html -> / redirect.
    var base = location.origin + location.pathname
      .replace(/index\.html$/i, "")
      .replace(/\/+$/, "");
    return base + "/#join=" + encodeURIComponent(handle);
  }

  function render(container, text, cb) {
    if (!container) return;
    if (typeof window.qrcode !== "function") {
      if (cb) cb(new Error("QR library unavailable"));
      return;
    }
    try {
      var qr = window.qrcode(0, "M"); // type 0 = auto, medium error correction
      qr.addData(text);
      qr.make();
      container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      if (cb) cb(null);
    } catch (e) {
      if (cb) cb(e);
    }
  }

  function renderHandle(container, handle, cb) {
    render(container, joinUrl(handle), cb);
  }

  window.RadioQR = { joinUrl: joinUrl, render: render, renderHandle: renderHandle };
})();
