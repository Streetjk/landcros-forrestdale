;(function () {
  function updateCamPresetsBottom() {
    if (window.innerWidth >= 1025) return;
    var presets = document.getElementById('cam-presets');
    var panel   = document.getElementById('side-panel');
    if (!presets || !panel) return;
    presets.style.bottom = (panel.offsetHeight + 8) + 'px';
  }
  window._updateCamPresetsBottom = updateCamPresetsBottom;
  window.addEventListener('resize', updateCamPresetsBottom);
})();
