(function (global) {
  "use strict";

  const STAFF_ROLES = new Set(["editor", "admin", "owner"]);
  const EMAIL = /^[^\s@]+@[^\s@]+$/;

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

  async function mountAuthenticatedMapNav({
    fetchFn = global.fetch,
    nav = global.SiteNavStaffNav,
    document: doc = global.document,
  } = {}) {
    if (typeof fetchFn !== "function" || !nav || typeof nav.mount !== "function"
        || typeof nav.normalizeSiteSlug !== "function" || !doc?.body) return false;

    let authResponse;
    try {
      authResponse = await fetchFn("/api/auth/me", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      return false;
    }
    if (!authResponse?.ok) return false;

    const identity = await readJson(authResponse);
    if (!isStaffIdentity(identity)) return false;

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
      if (!siteResponse?.ok) return true;
      const site = await readJson(siteResponse);
      const siteSlug = nav.normalizeSiteSlug(site?.slug);
      if (siteSlug) nav.mount({ currentPage: "map", siteSlug, document: doc });
    } catch {
      // Keep the safe three-item shell. Public Map startup is never gated here.
    }
    return true;
  }

  const api = Object.freeze({ isStaffIdentity, mountAuthenticatedMapNav });
  global.SiteNavStaffMapShell = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
