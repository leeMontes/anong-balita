// qr.js — thin wrapper around the `qrcode` CDN library.
// Renders the join URL into a canvas with a retro monochrome palette.
(function () {
  "use strict";

  function joinUrl(code) {
    var base = location.origin + location.pathname;
    return base + "#join=" + encodeURIComponent(code);
  }

  function render(canvas, text, cb) {
    if (!canvas) return;
    if (!window.QRCode || !window.QRCode.toCanvas) {
      cb && cb(new Error("QR library unavailable"));
      return;
    }
    window.QRCode.toCanvas(
      canvas,
      text,
      {
        width: 168,
        margin: 2,
        color: { dark: "#0b1a0b", light: "#7dff9b" },
        errorCorrectionLevel: "M"
      },
      function (err) {
        cb && cb(err || null);
      }
    );
  }

  function renderCode(canvas, code, cb) {
    render(canvas, joinUrl(code), cb);
  }

  window.RadioQR = { joinUrl: joinUrl, render: render, renderCode: renderCode };
})();
