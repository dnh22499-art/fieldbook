/* Fieldbook — login page. */
(function () {
  const T = {
    en: {
      setupTitle: "Set up Fieldbook", setupSub: "Create the owner account. The owner is always an Admin and approves everyone else.",
      loginTitle: "Sign in", loginSub: "Construction projects, receipts and job costs — in one place.",
      signupTitle: "Create your account", signupSub: "After you sign up, an Admin approves your access and picks your role.",
      name: "Your name", email: "E-mail", password: "Password", pwHint: "At least 10 characters.",
      setupBtn: "Create owner account", loginBtn: "Sign in", signupBtn: "Create account", wait: "Please wait…",
      toSignup: "New here? <button class=linkbtn type=button data-mode=signup>Create an account</button>",
      toLogin: "Already have an account? <button class=linkbtn type=button data-mode=login>Sign in</button>",
      forgot: "Forgot your password? Ask an Admin to reset it from Fieldbook → your name → Password & sign out.",
      offline: "Can't reach the Fieldbook server.",
    },
    vi: {
      setupTitle: "Cài đặt Fieldbook", setupSub: "Tạo tài khoản chủ sở hữu. Chủ sở hữu luôn là Quản trị viên và duyệt quyền cho mọi người.",
      loginTitle: "Đăng nhập", loginSub: "Dự án xây dựng, hoá đơn và chi phí công trình — ở cùng một nơi.",
      signupTitle: "Tạo tài khoản", signupSub: "Sau khi đăng ký, Quản trị viên sẽ duyệt quyền truy cập và chọn vai trò cho bạn.",
      name: "Họ tên", email: "E-mail", password: "Mật khẩu", pwHint: "Ít nhất 10 ký tự.",
      setupBtn: "Tạo tài khoản chủ sở hữu", loginBtn: "Đăng nhập", signupBtn: "Tạo tài khoản", wait: "Vui lòng chờ…",
      toSignup: "Chưa có tài khoản? <button class=linkbtn type=button data-mode=signup>Tạo tài khoản</button>",
      toLogin: "Đã có tài khoản? <button class=linkbtn type=button data-mode=login>Đăng nhập</button>",
      forgot: "Quên mật khẩu? Nhờ Quản trị viên đặt lại trong Fieldbook → tên bạn → Mật khẩu & đăng xuất.",
      offline: "Không kết nối được máy chủ Fieldbook.",
    },
  };
  const $ = (id) => document.getElementById(id);
  let lang = (() => { try { const v = localStorage.getItem("fieldbook-lang"); if (v === "vi" || v === "en") return v; } catch (e) {} return /^vi/i.test(navigator.language || "") ? "vi" : "en"; })();
  let mode = "login", state = { allowSignup: false };
  const C = window.FieldbookClient;
  const page = (name) => name;   // links are relative, so the pages also work from a sub-folder (github.io/<repo>/)
  // Only ever go back to a page on this same site after signing in.
  const next = (() => {
    try {
      const u = new URL(new URLSearchParams(location.search).get("next") || "./", location.href);
      return u.origin === location.origin && !/\/(login|setup|signup)(\.html)?$/.test(u.pathname) ? u.href : new URL("./", location.href).href;
    } catch (e) { return "./"; }
  })();

  function paint() {
    const t = T[lang];
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t[el.dataset.t]; });
    $("title").textContent = t[mode + "Title"];
    $("subtitle").textContent = t[mode + "Sub"];
    $("submit").textContent = t[mode + "Btn"];
    $("nameRow").hidden = mode === "login";
    $("pwHint").hidden = mode === "login";
    $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
    $("switch").innerHTML = mode === "setup" ? "" : mode === "login" ? (state.allowSignup ? t.toSignup : "") : t.toLogin;
    $("foot").hidden = mode !== "login";
    document.title = "Fieldbook — " + t[mode + "Title"];
  }
  document.addEventListener("click", (e) => {
    const l = e.target.closest("[data-lang]");
    if (l) { lang = l.dataset.lang; try { localStorage.setItem("fieldbook-lang", lang); } catch (x) {} paint(); }
    const m = e.target.closest("[data-mode]");
    if (m) { mode = m.dataset.mode; $("err").hidden = true; history.replaceState(null, "", page(mode) + location.search); paint(); }
  });
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("submit"), err = $("err");
    err.hidden = true; btn.disabled = true; btn.textContent = T[lang].wait;
    try {
      const r = await C.request("/api/auth/" + mode, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: $("name").value, email: $("email").value, password: $("password").value, token: !C.sameOrigin }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      if (d.token) C.token.set(d.token);
      location.replace(mode === "login" ? next : "./");
    } catch (x) {
      err.textContent = x instanceof TypeError ? T[lang].offline : x.message;
      err.hidden = false; btn.disabled = false; btn.textContent = T[lang][mode + "Btn"];
    }
  });
  C.request("/api/auth/state").then((r) => r.json()).then((s) => {
    state = s;
    if (s.needsSetup) mode = "setup";
    else if (/\/signup(\.html)?$/.test(location.pathname) && s.allowSignup) mode = "signup";
    else mode = "login";
    if (s.signedIn && !s.needsSetup) location.replace(next);
    paint();
    $(mode === "login" ? "email" : "name").focus();
  }).catch(() => paint());
  paint();
})();
