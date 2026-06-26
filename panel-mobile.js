;(function () {
  // Target bottom-sheet height per CSS breakpoints + fold state. Computed
  // (not read from offsetHeight) so it's correct even while the height
  // transition is still animating.
  function panelTargetHeight(panel) {
    var folded = panel.classList.contains('panel-folded');
    if (window.innerWidth <= 767) return folded ? 48 : window.innerHeight * 0.38;
    return folded ? 52 : window.innerHeight * 0.32;
  }
  function updateCamPresetsBottom() {
    if (window.innerWidth >= 1025) return;
    var presets = document.getElementById('cam-presets');
    var panel   = document.getElementById('side-panel');
    if (!presets || !panel) return;
    // setProperty with 'important' so it beats the `!important` bottom in style.css
    presets.style.setProperty('bottom', (panelTargetHeight(panel) + 8) + 'px', 'important');
  }
  window._updateCamPresetsBottom = updateCamPresetsBottom;
  window.addEventListener('resize', updateCamPresetsBottom);
})();
