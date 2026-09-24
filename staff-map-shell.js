(function (global) {
  "use strict";

  const STAFF_ROLES = new Set(["editor", "admin", "owner"]);
  const EMAIL = /^[^\s@]+@[^\s@]+$/;
  let generation = 0;

  function isStaffIdentity(value) {
    return Boolean(value
      && typeof value === "object"
      && !Array.isArray(value)
      && typeof value.email === "string"
      && EMAIL.test(value.email.trim())
      && STAFF_ROLES.has(value.role));
  }

  async function readJson(response) {
    if (!response || typeof response.json !== "function") return null;
    try { return await response.json(); } catch { return null; }
  }

  function clearDom(nav, doc) {
    nav?.unmount?.({ document: doc });
    if (doc?.body?.dataset) delete doc.body.dataset.staffNavMounted;
    else if (typeof doc?.body?.removeAttribute === "function") doc.body.removeAttribute("data-staff-nav-mounted");
  }

  function clearAuthenticatedMapNav({
    nav = global.SiteNavStaffNav,
    document: doc = global.document,
  } = {}) {
    generation += 1;
    clearDom(nav, doc);
  }

  async function mountAuthenticatedMapNav({
    fetchFn = global.fetch,
    nav = global.SiteNavStaffNav,
    document: doc = global.document,
  } = {}) {
    if (typeof fetchFn !== "function" || !nav || typeof nav.mount !== "function"
        || typeof nav.normalizeSiteSlug !== "function" || !doc?.body) return false;

    const run = ++generation;
    const clearIfCurrent = () => {
      if (run !== generation) return;
      generation += 1;
      clearDom(nav, doc);
    };

    let authResponse;
    try {
      authResponse = await fetchFn("/api/auth/me", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      clearIfCurrent();
      return false;
    }
    if (!authResponse?.ok) { clearIfCurrent(); return false; }

    const identity = await readJson(authResponse);
    if (!isStaffIdentity(identity)) { clearIfCurrent(); return false; }
    if (run !== generation) return false;

    // Authentication is enough for shell continuity. Site metadata is optional:
    // Map / My Pins / More remain available even if /api/site is unavailable.
    nav.mount({ currentPage: "map", document: doc });
    if (doc.body.dataset) doc.body.dataset.staffNavMounted = "true";
    else if (typeof doc.body.setAttribute === "function") doc.body.setAttribute("data-staff-nav-mounted", "true");

    try {
      const siteResponse = await fetchFn("/api/site", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!siteResponse?.ok) return run === generation;
      const site = await readJson(siteResponse);
      if (run !== generation) return false;
      const siteSlug = nav.normalizeSiteSlug(site?.slug);
      if (siteSlug) nav.mount({ currentPage: "map", siteSlug, document: doc });
    } catch {
      // Keep the safe three-item shell. Public Map startup is never gated here.
    }
    return run === generation;
  }

  const api = Object.freeze({ clearAuthenticatedMapNav, isStaffIdentity, mountAuthenticatedMapNav });
  global.SiteNavStaffMapShell = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
