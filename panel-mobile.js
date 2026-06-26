;(function () {
  // Camera-button positioning is now driven entirely by CSS:
  //   #app:has(#side-panel.panel-folded) #cam-presets { ... }
  // Both the panel height and the button `bottom` use the same vh units and
  // the same 0.28s transition, so they move in perfect lockstep — no JS
  // measurement (which lagged a frame and mismatched vh vs innerHeight).
  // Kept as a no-op so existing callers stay valid.
  window._updateCamPresetsBottom = function () {};
})();
