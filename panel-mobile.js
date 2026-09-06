;(function () {
  // Camera-button positioning is driven by CSS in style.css:
  //   #app.panel-is-folded #cam-presets { ... }
  //   #app:has(#side-panel.panel-folded) #cam-presets { ... }
  // Both the panel height and the button `bottom` use the same vh units and
  // the same 0.28s transition, so they move in perfect lockstep — no JS
  // measurement (which lagged a frame and mismatched vh vs innerHeight).
  //
  // The :has() form alone left older mobile browsers (iOS Safari < 15.4, older
  // Android WebViews) with buttons that never followed the fold. This mirrors
  // the panel's fold state onto #app as a plain class so the same rule works
  // everywhere. Every fold/unfold path already calls this function.
  function sync() {
    var panel = document.getElementById('side-panel');
    var app = document.getElementById('app');
    if (!panel || !app) return;
    app.classList.toggle('panel-is-folded', panel.classList.contains('panel-folded'));
  }
  window._updateCamPresetsBottom = sync;
  window.addEventListener('resize', sync);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync);
  else sync();
})();
