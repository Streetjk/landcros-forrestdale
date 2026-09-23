(function (global) {
  "use strict";

  const SITE_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
  const BASE_ITEMS = Object.freeze([
    Object.freeze({ id: "map", label: "Map", href: "/index.html" }),
    Object.freeze({ id: "pins", label: "My Pins", href: "/admin3d.html" }),
  ]);
  const MORE_ITEM = Object.freeze({ id: "more", label: "More", href: "/portal.html" });

  function normalizeSiteSlug(value) {
    if (typeof value !== "string") return null;
    const slug = value.trim().toLowerCase();
    return SITE_SLUG.test(slug) ? slug : null;
  }

  function buildItems({ siteSlug } = {}) {
    const items = BASE_ITEMS.map((item) => ({ ...item }));
    const slug = normalizeSiteSlug(siteSlug);
    if (slug) {
      items.push({
        id: "editor",
        label: "Editor",
        href: `/editor.html?site=${encodeURIComponent(slug)}`,
      });
    }
    items.push({ ...MORE_ITEM });
    return items;
  }

  function mount({ currentPage = "", siteSlug = null, document: doc = global.document } = {}) {
    if (!doc || typeof doc.createElement !== "function" || !doc.body) return null;

    let nav = typeof doc.getElementById === "function" ? doc.getElementById("sn-staff-nav") : null;
    if (!nav) {
      nav = doc.createElement("nav");
      nav.id = "sn-staff-nav";
      nav.setAttribute("aria-label", "Staff navigation");
      nav.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:0",
        "transform:translateX(-50%)",
        "z-index:9997",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "gap:4px",
        "width:min(100%,430px)",
        "box-sizing:border-box",
        "padding:5px max(8px,env(safe-area-inset-right)) calc(5px + env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))",
        "background:rgba(8,10,16,0.9)",
        "border:1px solid rgba(255,255,255,0.1)",
        "border-bottom:0",
        "border-radius:14px 14px 0 0",
        "box-shadow:0 -4px 18px rgba(0,0,0,0.28)",
        "backdrop-filter:blur(12px)",
        "-webkit-backdrop-filter:blur(12px)",
        "font:600 12px Inter,system-ui,sans-serif",
      ].join(";");
      doc.body.appendChild(nav);
    }

    while (nav.firstChild) nav.removeChild(nav.firstChild);
    for (const item of buildItems({ siteSlug })) {
      const link = doc.createElement("a");
      link.href = item.href;
      link.textContent = item.label;
      link.dataset.staffNav = item.id;
      link.style.cssText = [
        "min-height:44px",
        "min-width:64px",
        "padding:0 10px",
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "box-sizing:border-box",
        "border-radius:10px",
        "color:#eef0f4",
        "text-decoration:none",
        "white-space:nowrap",
      ].join(";");
      if (item.id === currentPage) {
        link.setAttribute("aria-current", "page");
        link.style.background = "color-mix(in srgb, var(--sn-landcros-orange,#e6500a) 28%, transparent)";
        link.style.color = "#fff";
      }
      nav.appendChild(link);
    }
    return nav;
  }

  const api = Object.freeze({ buildItems, mount, normalizeSiteSlug });
  global.SiteNavStaffNav = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
