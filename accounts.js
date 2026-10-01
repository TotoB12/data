(() => {
  "use strict";
  const el = id => document.getElementById(id);
  const mode = el("rankedMode");
  const dialog = el("loginDialog");
  let config;
  let profile;
  let widget;
  let ranked;
  let boardData;
  let boardExpires = 0;
  let boardLoading = false;
  let signingIn = false;
  let email = "";

  try { profile = JSON.parse(localStorage.getItem("data-profile") || "null"); } catch { /* Empty or invalid local hint. */ }
  function account(value) {
    profile = value;
    if (value) localStorage.setItem("data-profile", JSON.stringify(value));
    else localStorage.removeItem("data-profile");
    el("accountName").textContent = value?.alias || "Play as a guest";
    el("acceptedTotal").textContent = `${((value?.totalBytes || 0) / 1024 ** 3).toFixed(3)} GiB`;
    el("openLogin").textContent = value ? "Account" : "Sign in with email";
    el("accountActions").hidden = !value;
    el("aliasInput").value = value?.alias || "";
  }
  account(profile);
  window.dataAccount = { isRanked: () => mode.checked };

  const configuration = fetch("app-config.json").then(r => r.ok ? r.json() : null).then(value => {
    config = value;
    if (!value?.api) { el("accountNotice").textContent = "Accounts are available when this repository is deployed with its Cloudflare Worker."; mode.disabled = true; }
    else if (!value.rankedEnabled) { el("accountNotice").textContent = "Ranked downloads will open after the owner checks usage and speed. You can sign in and browse the boards."; mode.disabled = true; }
    else el("accountNotice").textContent = "Ranked downloads use signed transfer proofs. Accepted totals are saved every two minutes.";
    return value;
  }).catch(() => { mode.disabled = true; return null; });

  async function api(path, body) {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || value.error || value.message || "The request could not be completed.");
    return value;
  }
  function notice(message) { el("accountNotice").textContent = message; }
  function getWorker() {
    if (ranked) return ranked;
    ranked = new Worker("ranked-worker.js");
    ranked.onmessage = ({ data: { type, payload } }) => {
      if (type === "profile" || type === "accepted") account(payload.profile);
      if (type === "stats") window.dispatchEvent(new CustomEvent("data:ranked-stats", { detail: payload }));
      if (type === "boards") { boardData = payload; boardExpires = Date.now() + 300000; boardLoading = false; renderBoard(); }
      if (type === "started") notice(`Ranked run: up to ${(payload.maxBytes / 1024 ** 3).toFixed(2)} GiB. Stop anytime; accepted progress is saved separately.`);
      if (type === "notice") { notice(payload); if (boardLoading) el("boardStatus").textContent = payload; boardLoading = false; }
      if (type === "error" || type === "stopped") {
        notice(typeof payload === "string" ? payload : payload.message);
        if (type === "error" && typeof payload === "string" && payload.includes("Sign in again")) {
          account(null); mode.checked = false;
          el("aggressionSlider").disabled = false; el("resetStats").disabled = false;
          el("loginEmailStep").hidden = false; el("accountActions").hidden = true;
        }
        el("toggleButton").checked = false;
        el("toggleButton").dispatchEvent(new Event("change"));
      }
    };
    return ranked;
  }
  window.addEventListener("data:ranked-toggle", event => {
    if (event.detail.running && !profile) {
      el("toggleButton").checked = false;
      el("toggleButton").dispatchEvent(new Event("change"));
      void login();
      return;
    }
    getWorker().postMessage({ type: event.detail.running ? "start" : "stop" });
  });
  mode.addEventListener("change", () => {
    el("aggressionSlider").disabled = mode.checked;
    el("resetStats").disabled = mode.checked;
    if (el("toggleButton").checked) { el("toggleButton").checked = false; el("toggleButton").dispatchEvent(new Event("change")); }
    window.dispatchEvent(new Event("data:stop-direct"));
    ranked?.postMessage({ type: "stop" });
    if (mode.checked && !profile) void login();
  });

  async function login() {
    await configuration;
    if (!config?.api) { notice("Deploy the Worker to enable email accounts."); return; }
    el("loginEmailStep").hidden = !!profile;
    el("loginCodeStep").hidden = true;
    el("accountActions").hidden = !profile;
    el("loginError").textContent = "";
    dialog.showModal();
    if (profile) { getWorker().postMessage({ type: "profile" }); return; }
    if (typeof window.turnstile?.render !== "function") {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.onload = resolve; script.onerror = reject; document.head.append(script);
      });
    }
    if (widget === undefined) widget = window.turnstile.render(el("turnstileWidget"), { sitekey: config.turnstileSiteKey, action: "login", theme: "dark" });
    else window.turnstile.reset(widget);
  }
  el("openLogin").onclick = () => void login().catch(() => { el("loginError").textContent = "Verification could not load. Please try again."; });
  el("closeLogin").onclick = () => dialog.close();
  el("emailForm").onsubmit = async event => {
    event.preventDefault();
    if (signingIn) return;
    signingIn = true; el("sendCode").disabled = true; el("loginError").textContent = "";
    try {
      email = el("emailInput").value.trim().toLowerCase();
      await api("/api/auth/email-otp/send-verification-otp", { email, turnstileToken: window.turnstile?.getResponse(widget) });
      el("loginEmailStep").hidden = true; el("loginCodeStep").hidden = false;
      el("codeDestination").textContent = `Enter the code sent to ${email}.`;
      el("codeInput").focus();
    } catch (e) { el("loginError").textContent = e.message; window.turnstile?.reset(widget); }
    finally { signingIn = false; el("sendCode").disabled = false; }
  };
  el("codeForm").onsubmit = async event => {
    event.preventDefault(); if (signingIn) return;
    signingIn = true; el("verifyCode").disabled = true; el("loginError").textContent = "";
    try {
      const result = await api("/api/auth/sign-in/email-otp", { email, otp: el("codeInput").value.trim() });
      account(result.profile); dialog.close(); el("codeInput").value = "";
      notice("Signed in. Choose ranked mode when it is available to add accepted bytes to your account.");
    } catch (e) { el("loginError").textContent = e.message; }
    finally { signingIn = false; el("verifyCode").disabled = false; }
  };
  el("differentEmail").onclick = () => { el("loginCodeStep").hidden = true; el("loginEmailStep").hidden = false; window.turnstile?.reset(widget); };
  el("aliasForm").onsubmit = async event => {
    event.preventDefault(); const button = el("saveAlias"); button.disabled = true;
    try { account((await api("/api/profile", { alias: el("aliasInput").value.trim() })).profile); el("loginError").textContent = "Display name saved."; }
    catch (e) { el("loginError").textContent = e.message; }
    finally { button.disabled = false; }
  };
  el("signOut").onclick = async () => {
    ranked?.postMessage({ type: "close" });
    try {
      await api("/api/auth/sign-out", {}); account(null); mode.checked = false;
      el("toggleButton").checked = false; el("toggleButton").dispatchEvent(new Event("change"));
      el("aggressionSlider").disabled = false; el("resetStats").disabled = false; dialog.close();
    }
    catch (e) { el("loginError").textContent = e.message; }
  };

  function renderBoard() {
    const rows = boardData?.periods?.[el("leaderboardPeriod").value] || [];
    const body = el("leaderboardRows"); body.replaceChildren();
    rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      for (const text of [String(i + 1), row.alias, `${(row.bytes / 1024 ** 3).toFixed(3)} GiB`]) {
        const td = document.createElement("td"); td.textContent = text; tr.append(td);
      }
      body.append(tr);
    });
    el("boardStatus").textContent = rows.length ? "Calendar periods in UTC · updates every five minutes" : "No accepted downloads in this period yet.";
  }
  el("leaderboardPeriod").onchange = renderBoard;
  el("leaderboards").ontoggle = async () => {
    if (!el("leaderboards").open || boardLoading) return;
    if (boardData && Date.now() < boardExpires) { renderBoard(); return; }
    await configuration;
    if (!config?.api) { el("boardStatus").textContent = "Deploy the Worker to enable leaderboards."; return; }
    boardLoading = true; el("boardStatus").textContent = "Loading leaderboards…";
    if (ranked) { ranked.postMessage({ type: "boards" }); return; }
    try {
      const response = await fetch("/api/leaderboards");
      if (!response.ok) throw new Error("Leaderboards could not load.");
      boardData = await response.json(); boardExpires = Date.now() + 300000; renderBoard();
    } catch (e) { el("boardStatus").textContent = e.message; }
    finally { boardLoading = false; }
  };
})();
