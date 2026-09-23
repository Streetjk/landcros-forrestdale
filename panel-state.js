(function (global) {
  'use strict';

  var BREAKPOINT = 1024;
  var currentMode = null;
  var resizeListenerAttached = false;
  var lastObservedCompact = null;

  function getWin() {
    return typeof window !== 'undefined' ? window : global;
  }

  function getDoc() {
    var win = getWin();
    return win && win.document ? win.document : null;
  }

  function getApp() {
    var doc = getDoc();
    return doc ? doc.getElementById('app') : null;
  }

  function getPanel() {
    var doc = getDoc();
    return doc ? doc.getElementById('side-panel') : null;
  }

  function isCompact() {
    var win = getWin();
    if (!win || typeof win.innerWidth !== 'number') {
      return false;
    }
    return win.innerWidth <= BREAKPOINT;
  }

  function snapshot() {
    var compact = isCompact();
    var app = getApp();
    var panel = getPanel();

    var hasDesktopOpen = !!(app && app.classList && app.classList.contains('panel-open'));
    var hasSheetMid = !!(panel && panel.classList && panel.classList.contains('sheet-mid'));
    var hasSheetFull = !!(panel && panel.classList && panel.classList.contains('sheet-full'));
    var hasPanelFolded = !!(panel && panel.classList && panel.classList.contains('panel-folded'));
    var hasSheetOpenMirror = !!(app && app.classList && app.classList.contains('sheet-open'));
    var hasFoldedMirror = !!(app && app.classList && app.classList.contains('panel-is-folded'));

    var detailOpen = currentMode === 'sheet'
      ? (hasSheetMid || hasSheetFull)
      : (currentMode === 'fold' ? !hasPanelFolded : false);

    var expanded = currentMode === 'sheet'
      ? hasSheetFull
      : (currentMode === 'fold' ? !hasPanelFolded : false);

    var folded = currentMode === 'fold'
      ? hasPanelFolded
      : (!hasSheetMid && !hasSheetFull);

    var appMirrorOpen = currentMode === 'sheet'
      ? hasSheetOpenMirror
      : (currentMode === 'fold' ? hasFoldedMirror : false);

    return {
      mode: currentMode,
      compact: compact,
      desktopOpen: hasDesktopOpen,
      detailOpen: detailOpen,
      expanded: expanded,
      folded: folded,
      appMirrorOpen: appMirrorOpen
    };
  }

  function sync() {
    var compact = isCompact();
    var app = getApp();
    var panel = getPanel();

    if (!app || !app.classList) {
      return snapshot();
    }

    if (!compact) {
      app.classList.remove('sheet-open');
      app.classList.remove('panel-is-folded');
      return snapshot();
    }

    if (currentMode === 'sheet') {
      var hasSheet = !!(panel && panel.classList && (panel.classList.contains('sheet-mid') || panel.classList.contains('sheet-full')));
      if (hasSheet) {
        app.classList.add('sheet-open');
      } else {
        app.classList.remove('sheet-open');
      }
      app.classList.remove('panel-is-folded');
    } else if (currentMode === 'fold') {
      var isFolded = !!(panel && panel.classList && panel.classList.contains('panel-folded'));
      if (isFolded) {
        app.classList.add('panel-is-folded');
      } else {
        app.classList.remove('panel-is-folded');
      }
      app.classList.remove('sheet-open');
    }

    return snapshot();
  }

  function toggleDesktop() {
    var app = getApp();
    if (app && app.classList) {
      if (app.classList.contains('panel-open')) {
        app.classList.remove('panel-open');
      } else {
        app.classList.add('panel-open');
      }
    }
    sync();
    return snapshot();
  }

  function toggle() {
    var compact = isCompact();
    if (!compact) {
      return toggleDesktop();
    }

    var panel = getPanel();
    if (panel && panel.classList) {
      if (currentMode === 'sheet') {
        var isSheetOpen = panel.classList.contains('sheet-mid') || panel.classList.contains('sheet-full');
        if (isSheetOpen) {
          panel.classList.remove('sheet-mid');
          panel.classList.remove('sheet-full');
        } else {
          panel.classList.add('sheet-mid');
        }
      } else if (currentMode === 'fold') {
        if (panel.classList.contains('panel-folded')) {
          panel.classList.remove('panel-folded');
        } else {
          panel.classList.add('panel-folded');
        }
      }
    }

    sync();
    return snapshot();
  }

  function openDetail(options) {
    var opts = options || {};
    var full = !!opts.full;
    var compact = isCompact();

    if (compact) {
      var panel = getPanel();
      if (panel && panel.classList) {
        if (currentMode === 'sheet') {
          if (full) {
            panel.classList.remove('sheet-mid');
            panel.classList.add('sheet-full');
          } else {
            if (!panel.classList.contains('sheet-full')) {
              panel.classList.add('sheet-mid');
            }
          }
        } else if (currentMode === 'fold') {
          panel.classList.remove('panel-folded');
        }
      }
    }

    sync();
    return snapshot();
  }

  function collapseList() {
    var compact = isCompact();
    if (compact && currentMode === 'sheet') {
      var panel = getPanel();
      if (panel && panel.classList) {
        panel.classList.remove('sheet-mid');
        panel.classList.remove('sheet-full');
      }
    }
    sync();
    return snapshot();
  }

  function expandFull() {
    var compact = isCompact();
    if (compact) {
      var panel = getPanel();
      if (panel && panel.classList) {
        if (currentMode === 'sheet') {
          panel.classList.remove('sheet-mid');
          panel.classList.add('sheet-full');
        } else if (currentMode === 'fold') {
          panel.classList.remove('panel-folded');
        }
      }
    }
    sync();
    return snapshot();
  }

  function handleBreakpointChange() {
    var compact = isCompact();
    if (lastObservedCompact === null) {
      lastObservedCompact = compact;
      sync();
      return snapshot();
    }

    if (compact !== lastObservedCompact) {
      var app = getApp();
      var panel = getPanel();

      if (compact) {
        if (app && app.classList) {
          app.classList.remove('panel-open');
        }
      } else {
        if (panel && panel.classList) {
          panel.classList.remove('sheet-mid');
          panel.classList.remove('sheet-full');
        }
      }
      lastObservedCompact = compact;
    }

    sync();
    return snapshot();
  }

  function init(config) {
    if (!config || (config.mode !== 'sheet' && config.mode !== 'fold')) {
      throw new Error("SiteNavPanelState: mode must be 'sheet' or 'fold'");
    }

    if (currentMode !== null && currentMode !== config.mode) {
      throw new Error("SiteNavPanelState: conflicting re-init mode '" + config.mode + "' (already '" + currentMode + "')");
    }

    currentMode = config.mode;
    lastObservedCompact = isCompact();

    var win = getWin();
    if (!resizeListenerAttached && win && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', handleBreakpointChange);
      resizeListenerAttached = true;
    }

    sync();
    return snapshot();
  }

  var api = Object.freeze({
    BREAKPOINT: BREAKPOINT,
    init: init,
    isCompact: isCompact,
    snapshot: snapshot,
    sync: sync,
    toggle: toggle,
    toggleDesktop: toggleDesktop,
    openDetail: openDetail,
    collapseList: collapseList,
    expandFull: expandFull,
    handleBreakpointChange: handleBreakpointChange
  });

  var target = getWin();
  if (target) {
    target.SiteNavPanelState = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
