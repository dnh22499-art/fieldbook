/* Fieldbook — account page. */
(function () {
  const T = {
    en: {
      back: "← Back to Fieldbook", title: "Your account", logout: "Sign out", nameTitle: "Name", name: "Name", save: "Save", saved: "Saved.",
      pwTitle: "Change password", current: "Current password", newPw: "New password", pwHint: "At least 10 characters. Changing it signs you out on your other devices.",
      changePw: "Change password", pwDone: "Password changed.",
      accTitle: "Sign-in accounts", accSub: "Create accounts for your team and reset forgotten passwords. Roles and approvals are also in Fieldbook → Users & access.",
      person: "Person", role: "Role", state: "Status", owner: "Owner", active: "Active", disabled: "Disabled", noAccess: "Waiting for approval",
      resetPw: "Reset password", disable: "Disable", enable: "Enable",
      addTitle: "Add a person", email: "E-mail", pm: "Project manager", accountant: "Accountant", adminRole: "Admin", noneYet: "No access yet",
      sendMail: "E-mail the sign-in details to them", add: "Create account",
      tempFor: (n) => `Temporary password for ${n} — share it privately; it is shown only once:`, mailed: "The sign-in details were e-mailed.",
      confirmDisable: (n) => `Disable ${n}? They are signed out at once.`, signedAs: (n, e) => `Signed in as ${n} (${e})`,
      roles: { admin: "Admin", pm: "Project manager", accountant: "Accountant" },
    },
    vi: {
      back: "← Quay lại Fieldbook", title: "Tài khoản của bạn", logout: "Đăng xuất", nameTitle: "Họ tên", name: "Họ tên", save: "Lưu", saved: "Đã lưu.",
      pwTitle: "Đổi mật khẩu", current: "Mật khẩu hiện tại", newPw: "Mật khẩu mới", pwHint: "Ít nhất 10 ký tự. Đổi mật khẩu sẽ đăng xuất bạn trên các thiết bị khác.",
      changePw: "Đổi mật khẩu", pwDone: "Đã đổi mật khẩu.",
      accTitle: "Tài khoản đăng nhập", accSub: "Tạo tài khoản cho đội và đặt lại mật khẩu bị quên. Vai trò và duyệt quyền cũng có trong Fieldbook → Người dùng & quyền.",
      person: "Người dùng", role: "Vai trò", state: "Trạng thái", owner: "Chủ sở hữu", active: "Đang hoạt động", disabled: "Đã khoá", noAccess: "Chờ duyệt",
      resetPw: "Đặt lại mật khẩu", disable: "Khoá", enable: "Mở khoá",
      addTitle: "Thêm người", email: "E-mail", pm: "Quản lý dự án", accountant: "Kế toán", adminRole: "Quản trị viên", noneYet: "Chưa cấp quyền",
      sendMail: "Gửi thông tin đăng nhập qua e-mail", add: "Tạo tài khoản",
      tempFor: (n) => `Mật khẩu tạm cho ${n} — gửi riêng cho họ; chỉ hiện một lần:`, mailed: "Đã gửi thông tin đăng nhập qua e-mail.",
      confirmDisable: (n) => `Khoá ${n}? Người này sẽ bị đăng xuất ngay.`, signedAs: (n, e) => `Đang đăng nhập: ${n} (${e})`,
      roles: { admin: "Quản trị viên", pm: "Quản lý dự án", accountant: "Kế toán" },
    },
  };
  const $ = (id) => document.getElementById(id);
  let lang = (() => { try { const v = localStorage.getItem("fieldbook-lang"); if (v === "vi" || v === "en") return v; } catch (e) {} return /^vi/i.test(navigator.language || "") ? "vi" : "en"; })();
  let me = null, accounts = [], pendingDisable = null;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const C = window.FieldbookClient;
  async function call(method, url, body) {
    const r = await C.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.replace("login?next=account"); throw new Error("signed out"); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  }
  function show(id, text, ok, html) { const el = $(id); el.className = "msg " + (ok ? "ok" : "err"); if (html) el.innerHTML = html; else el.textContent = text; el.hidden = false; }

  function paint() {
    const t = T[lang];
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t[el.dataset.t]; });
    if (me) $("who").textContent = t.signedAs(me.user.name, me.user.email);
    paintRows();
  }
  function paintRows() {
    const t = T[lang];
    $("rows").innerHTML = accounts.map((a) => {
      const st = a.disabled ? `<span class="pill off">${t.disabled}</span>` : a.is_owner ? `<span class="pill on">${t.owner}</span>` : a.status === "active" ? `<span class="pill on">${t.active}</span>` : `<span class="pill">${t.noAccess}</span>`;
      const self = me && a.id === me.user.id;
      const canTouch = !a.is_owner || (me && me.user.isOwner);
      return `<tr><td><b>${esc(a.name)}</b><div class="em">${esc(a.email)}</div></td>
        <td>${esc(a.role ? t.roles[a.role] || a.role : "—")}</td><td>${st}</td>
        <td><div class="actions">${canTouch ? `<button class="btn btn-ghost btn-sm" data-reset="${esc(a.id)}">${t.resetPw}</button>` : ""}
        ${!self && !a.is_owner ? (a.disabled ? `<button class="btn btn-ghost btn-sm" data-enable="${esc(a.id)}">${t.enable}</button>`
          : `<button class="btn btn-ghost btn-sm" data-disable="${esc(a.id)}">${pendingDisable === a.id ? t.confirmDisable(esc(a.name)) : t.disable}</button>`) : ""}</div></td></tr>`;
    }).join("");
  }
  async function loadAccounts() { accounts = (await call("GET", "/api/accounts")).accounts; paintRows(); }

  document.addEventListener("click", async (e) => {
    const l = e.target.closest("[data-lang]");
    if (l) { lang = l.dataset.lang; try { localStorage.setItem("fieldbook-lang", lang); } catch (x) {} paint(); return; }
    const t = T[lang];
    const name = (id) => (accounts.find((a) => a.id === id) || {}).name || "";
    const r = e.target.closest("[data-reset]");
    if (r) {
      try { const d = await call("POST", `/api/accounts/${encodeURIComponent(r.dataset.reset)}/password`); show("accMsg", "", true, `${esc(t.tempFor(name(r.dataset.reset)))}<div class="secret" style="margin-top:8px;">${esc(d.password)}</div>`); }
      catch (x) { show("accMsg", x.message); }
      return;
    }
    const dis = e.target.closest("[data-disable]");
    if (dis) {
      // Two clicks: the first turns the button into a confirmation.
      if (pendingDisable !== dis.dataset.disable) { pendingDisable = dis.dataset.disable; paintRows(); return; }
      pendingDisable = null;
      try { await call("POST", `/api/accounts/${encodeURIComponent(dis.dataset.disable)}/disable`); await loadAccounts(); } catch (x) { show("accMsg", x.message); }
      return;
    }
    const en = e.target.closest("[data-enable]");
    if (en) { try { await call("POST", `/api/accounts/${encodeURIComponent(en.dataset.enable)}/enable`); await loadAccounts(); } catch (x) { show("accMsg", x.message); } }
  });
  $("logout").addEventListener("click", async () => { try { await call("POST", "/api/auth/logout"); } catch (x) {} C.token.set(""); location.replace("login"); });
  $("nameForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await call("POST", "/api/account/name", { name: $("myName").value }); me.user.name = $("myName").value.trim(); paint(); show("nameMsg", T[lang].saved, true); }
    catch (x) { show("nameMsg", x.message); }
  });
  $("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { const d = await call("POST", "/api/account/password", { current: $("cur").value, password: $("new1").value }); if (d.token) C.token.set(d.token); $("cur").value = $("new1").value = ""; show("pwMsg", T[lang].pwDone, true); }
    catch (x) { show("pwMsg", x.message); }
  });
  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = T[lang];
    try {
      const nm = $("aName").value.trim();
      const d = await call("POST", "/api/accounts", { name: nm, email: $("aEmail").value, role: $("aRole").value, sendEmail: me.mail && $("aMail").checked });
      show("addMsg", "", true, `${esc(t.tempFor(nm))}<div class="secret" style="margin-top:8px;">${esc(d.password)}</div>${d.mailed ? `<div style="margin-top:8px;">${esc(t.mailed)}</div>` : ""}`);
      $("aName").value = $("aEmail").value = "";
      await loadAccounts();
    } catch (x) { show("addMsg", x.message); }
  });

  call("GET", "/api/me").then(async (d) => {
    me = d;
    $("myName").value = d.user.name;
    $("mailRow").hidden = !d.mail;
    if (d.user.canEdit) { $("admin").hidden = false; await loadAccounts(); }
    paint();
  }).catch(() => {});
  paint();
})();
