/* Fieldbook — how the pages reach the server.
   Same address (pages served by the NAS): the sign-in cookie is used.
   Other address (pages on GitHub Pages, server on the NAS): a sign-in token kept in
   this browser is sent with every request instead, because browsers don't send
   cookies to another site. */
(function () {
  "use strict";
  const API = String(window.FIELDBOOK_API || "").trim().replace(/\/+$/, "");
  let sameOrigin = true;
  if (API) { try { sameOrigin = new URL(API, location.href).origin === location.origin; } catch (e) { sameOrigin = false; } }
  const KEY = "fieldbook-token";
  const token = {
    get() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } },
    set(t) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) {} },
  };
  const url = (p) => (sameOrigin ? "" : API) + p;
  function headers(extra) {
    const h = Object.assign({ "x-fieldbook": "1" }, extra || {});
    if (!sameOrigin) { const t = token.get(); if (t) h.authorization = "Bearer " + t; }
    return h;
  }
  function request(path, opts) {
    opts = opts || {};
    return fetch(url(path), Object.assign({}, opts, { credentials: sameOrigin ? "same-origin" : "omit", headers: headers(opts.headers) }));
  }
  window.FieldbookClient = { API: sameOrigin ? "" : API, sameOrigin, url, request, headers, token };
})();
