;(function () {
  // Park the camera buttons just above the bottom-sheet panel. Measure the
  // panel's real pixel height (offsetHeight) rather than estimating from vh —
  // on mobile `vh` ≠ window.innerHeight, which left the buttons overlapping
  // the panel when expanded.
  function setBottom() {
    if (window.innerWidth >= 1025) return;
    var presets = document.getElementById('cam-presets');
    var panel   = document.getElementById('side-panel');
    if (!presets || !panel) return;
    // setProperty with 'important' so it beats the `!important` bottom in style.css
    presets.style.setProperty('bottom', (panel.offsetHeight + 8) + 'px', 'important');
  }

  window._updateCamPresetsBottom = setBottom;
  window.addEventListener('resize', setBottom);

  function init() {
    var panel = document.getElementById('side-panel');
    // Re-measure once the fold/unfold height transition finishes so the resting
    // position is exact (offsetHeight mid-transition is the pre-animation value).
    if (panel) panel.addEventListener('transitionend', function (e) {
      if (e.propertyName === 'height') setBottom();
    });
    setBottom();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
