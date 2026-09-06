// auth-gate.js — shared sign-in flow for portal.html, admin3d.html and
// editor.html (email → 6-digit PIN → session). The three pages used to carry
// their own copy of this logic; they now share this one so the PIN steps
// behave identically everywhere.
//
// Expects the page's gate markup (same ids on every page):
//   #sn-auth-gate  #sn-auth-msg  #sn-auth-email-row  #sn-email-input
//   #sn-email-submit  #sn-create-submit  #sn-auth-error
// A PIN row is injected after #sn-auth-email-row, styled by copying the
// email input/button's own classes + inline styles so it matches each page.
//
//   const gate = SnAuthGate.attach({
//     onSignedIn(email) {...},          // session cookie is set; hide the gate
//     next: location.pathname + location.search,  // where the emailed link returns
//   });
//   gate.showLoginState('Session expired — sign in again.');
//   SnAuthGate.changePin();             // from a "Change PIN" button, when signed in
;(function () {
  const $ = (id) => document.getElementById(id);
  const DOMAIN_MSG = 'Only @hcma.com.au emails may sign in.';

  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let d = {};
    try { d = await r.json(); } catch {}
    d._status = r.status;
    return d;
  }

  function fmtLock(until) {
    const mins = Math.max(1, Math.ceil((new Date(until) - Date.now()) / 60000));
    return `Too many attempts — try again in ${mins} min.`;
  }

  function attach(opts = {}) {
    const msg = $('sn-auth-msg'), emailRow = $('sn-auth-email-row'), emailInput = $('sn-email-input');
    const emailBtn = $('sn-email-submit'), createBtn = $('sn-create-submit'), err = $('sn-auth-error');
    const next = opts.next || (location.pathname + location.search);
    let lastEmail = '';

    // ── PIN row (injected) ──
    const pinRow = document.createElement('div');
    pinRow.id = 'sn-auth-pin-row';
    pinRow.style.cssText = emailRow.style.cssText + ';display:none;flex-direction:column;gap:8px;align-items:stretch;';
    pinRow.className = emailRow.className;
    const pinLine = document.createElement('div');
    pinLine.style.cssText = 'display:flex;gap:8px;';
    const pinInput = document.createElement('input');
    pinInput.id = 'sn-pin-input';
    pinInput.type = 'password';
    pinInput.inputMode = 'numeric';
    pinInput.autocomplete = 'one-time-code';
    pinInput.maxLength = 6;
    pinInput.pattern = '[0-9]{6}';
    pinInput.placeholder = '6-digit PIN';
    pinInput.className = emailInput.className;
    pinInput.style.cssText = emailInput.style.cssText + ';letter-spacing:0.3em;text-align:center;';
    const pinBtn = document.createElement('button');
    pinBtn.id = 'sn-pin-submit';
    pinBtn.textContent = 'Sign in';
    pinBtn.className = emailBtn.className;
    pinBtn.style.cssText = emailBtn.style.cssText;
    pinLine.append(pinInput, pinBtn);
    const links = document.createElement('div');
    links.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font-size:0.8rem;';
    const forgot = document.createElement('a');
    forgot.href = '#'; forgot.textContent = 'Forgot PIN? Email me a reset link';
    forgot.style.cssText = 'color:#94A3B8;text-decoration:underline;cursor:pointer;';
    const back = document.createElement('a');
    back.href = '#'; back.textContent = 'Different email';
    back.style.cssText = forgot.style.cssText;
    links.append(forgot, back);
    pinRow.append(pinLine, links);
    emailRow.insertAdjacentElement('afterend', pinRow);

    // ── states ──
    function showError(t) { err.textContent = t; err.style.display = ''; }
    function clearError() { err.style.display = 'none'; }
    function only(el) {
      emailRow.style.display = el === emailRow ? 'flex' : 'none';
      pinRow.style.display = el === pinRow ? 'flex' : 'none';
      createBtn.style.display = el === createBtn ? '' : 'none';
      clearError();
    }
    function showLoginState(message) { msg.textContent = message; only(emailRow); emailInput.focus(); }
    function showPending() { msg.textContent = 'Your access is pending admin approval.'; only(null); opts.onPending?.(); }
    function showCreatePrompt(email) { msg.textContent = `No profile found for ${email}. Create one?`; only(createBtn); }
    function showPinState(email) {
      msg.textContent = `Enter the 6-digit PIN for ${email}.`;
      only(pinRow); pinInput.value = ''; pinInput.focus();
    }
    function showLinkSent(d, verb) {
      only(null);
      if (d.emailSent) {
        msg.textContent = `We emailed ${lastEmail} a link to ${verb} your PIN. It expires in 30 minutes — check your inbox, then sign in here.`;
      } else if (d.devLink) {
        msg.innerHTML = '';
        msg.append(`Email isn't configured on this server (dev mode). Use this link to ${verb} your PIN: `);
        const a = document.createElement('a'); a.href = d.devLink; a.textContent = 'open link'; a.style.color = '#14B8A6';
        msg.append(a);
      } else {
        msg.textContent = `Your account needs a PIN, but this server can't send email yet. Ask an admin to configure RESEND_API_KEY, then try again.`;
      }
      const again = document.createElement('a');
      again.href = '#'; again.textContent = ' Back to sign in'; again.style.cssText = forgot.style.cssText;
      again.onclick = (e) => { e.preventDefault(); showLoginState('Sign in with your @hcma.com.au email to continue.'); };
      msg.append(document.createElement('br'), again);
    }

    // ── actions ──
    async function login() {
      const email = emailInput.value.trim();
      if (!email) return;
      lastEmail = email;
      clearError();
      try {
        const d = await post('/api/auth/login', { email, next });
        if (d.status === 'pin-required') showPinState(email);
        else if (d.status === 'pin-setup-sent') showLinkSent(d, 'set');
        else if (d.status === 'active') opts.onSignedIn?.(email);   // legacy server without PIN support
        else if (d.status === 'pending') showPending();
        else if (d.status === 'none') showCreatePrompt(email);
        else if (d._status === 429) showError('Too many attempts — wait a few minutes.');
        else showError(DOMAIN_MSG);
      } catch { showError('Login failed — try again.'); }
    }

    async function submitPin() {
      const pin = pinInput.value.trim();
      if (!/^\d{6}$/.test(pin)) { showError('PIN must be exactly 6 digits.'); return; }
      clearError();
      pinBtn.disabled = true;
      try {
        const d = await post('/api/auth/login', { email: lastEmail, pin, next });
        if (d.status === 'active') opts.onSignedIn?.(lastEmail);
        else if (d.status === 'pin-invalid') { showError(`Incorrect PIN${d.remaining != null ? ` — ${d.remaining} attempt${d.remaining === 1 ? '' : 's'} left` : ''}.`); pinInput.value = ''; pinInput.focus(); }
        else if (d.status === 'locked') showError(fmtLock(d.lockedUntil));
        else if (d.status === 'pin-setup-sent') showLinkSent(d, 'set');
        else if (d._status === 429) showError('Too many attempts — wait a few minutes.');
        else showError('Sign-in failed — try again.');
      } catch { showError('Sign-in failed — try again.'); }
      finally { pinBtn.disabled = false; }
    }

    async function requestReset(e) {
      e?.preventDefault();
      clearError();
      try {
        const d = await post('/api/auth/pin/request-reset', { email: lastEmail, next });
        if (d._status === 429) return showError('Too many reset requests — wait an hour.');
        showLinkSent(d, 'reset');
      } catch { showError('Could not send reset email — try again.'); }
    }

    async function createProfile() {
      clearError();
      try {
        const d = await post('/api/auth/create', { email: lastEmail });
        if (d.status === 'pin-setup-sent') showLinkSent(d, 'set');
        else if (d.status === 'active') opts.onSignedIn?.(lastEmail);
        else if (d.status === 'pending') showPending();
        else showError(DOMAIN_MSG);
      } catch { showError('Could not create profile — try again.'); }
    }

    emailBtn.onclick = login;
    emailInput.onkeydown = (e) => { if (e.key === 'Enter') login(); };
    pinBtn.onclick = submitPin;
    pinInput.onkeydown = (e) => { if (e.key === 'Enter') submitPin(); };
    pinInput.oninput = () => { pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6); };
    forgot.onclick = requestReset;
    back.onclick = (e) => { e.preventDefault(); showLoginState('Sign in with your @hcma.com.au email to continue.'); };
    createBtn.onclick = createProfile;

    return { showLoginState, showPending, showError, clearError };
  }

  // Signed-in "Change PIN" dialog (also offers the emailed reset for a
  // forgotten current PIN). Self-contained so pages only need a button.
  function changePin() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,0.85);display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif;color:#fff;';
    const inp = (ph) => `<input type="password" inputmode="numeric" maxlength="6" placeholder="${ph}" style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid rgba(255,255,255,0.12);border-radius:8px;background:#0F172A;color:#fff;font-size:0.95rem;letter-spacing:0.3em;text-align:center;">`;
    wrap.innerHTML = `
      <form style="background:#192134;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px;width:300px;display:flex;flex-direction:column;gap:10px;">
        <h3 style="margin:0 0 4px;font-size:1rem;">Change login PIN</h3>
        ${inp('Current PIN')}${inp('New 6-digit PIN')}${inp('Repeat new PIN')}
        <p data-err style="margin:0;color:#DC2626;font-size:0.8rem;display:none;"></p>
        <button type="submit" style="padding:9px;background:#0F766E;border:none;border-radius:8px;color:#fff;font-weight:600;cursor:pointer;">Save PIN</button>
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;">
          <a href="#" data-forgot style="color:#94A3B8;">Forgot it? Email me a reset link</a>
          <a href="#" data-cancel style="color:#94A3B8;">Cancel</a>
        </div>
      </form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form'), [cur, nw, rep] = wrap.querySelectorAll('input'), errEl = wrap.querySelector('[data-err]');
    const showErr = (t) => { errEl.textContent = t; errEl.style.display = ''; };
    wrap.querySelectorAll('input').forEach((i) => { i.oninput = () => { i.value = i.value.replace(/\D/g, '').slice(0, 6); }; });
    wrap.querySelector('[data-cancel]').onclick = (e) => { e.preventDefault(); wrap.remove(); };
    wrap.querySelector('[data-forgot]').onclick = async (e) => {
      e.preventDefault();
      try {
        const me = await fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null));
        if (!me?.email) return showErr('Not signed in.');
        const d = await post('/api/auth/pin/request-reset', { email: me.email, next: location.pathname });
        form.innerHTML = `<p style="margin:0;font-size:0.9rem;line-height:1.5">${d.emailSent ? `Reset link sent to ${me.email}. It expires in 30 minutes.` : d.devLink ? `Email not configured (dev): <a href="${d.devLink}" style="color:#14B8A6">open reset link</a>` : 'This server cannot send email yet — ask an admin to set RESEND_API_KEY.'}</p><button type="button" style="margin-top:12px;padding:9px;background:#192134;border:1px solid rgba(255,255,255,0.12);border-radius:8px;color:#fff;cursor:pointer;">Close</button>`;
        form.querySelector('button').onclick = () => wrap.remove();
      } catch { showErr('Could not send reset email.'); }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!/^\d{6}$/.test(nw.value)) return showErr('New PIN must be exactly 6 digits.');
      if (nw.value !== rep.value) return showErr('New PINs do not match.');
      const d = await post('/api/auth/pin/change', { currentPin: cur.value, newPin: nw.value });
      if (d.ok) { wrap.remove(); return; }
      if (d.status === 'pin-invalid') showErr(`Current PIN incorrect${d.remaining != null ? ` — ${d.remaining} attempts left` : ''}.`);
      else if (d.status === 'locked') showErr(fmtLock(d.lockedUntil));
      else if (d.status === 'pin-unacceptable') showErr('Choose a less guessable PIN (not 000000, 123456, etc).');
      else showErr('Could not change PIN — try again.');
    };
    cur.focus();
  }

  // Adds a "Change PIN" button beside #sn-signout-btn in the auth bar, if present.
  function decorateAuthBar() {
    const signout = $('sn-signout-btn');
    if (!signout || $('sn-change-pin-btn')) return;
    const b = signout.cloneNode(false);
    b.id = 'sn-change-pin-btn';
    b.textContent = 'Change PIN';
    b.onclick = changePin;
    signout.insertAdjacentElement('beforebegin', b);
  }

  window.SnAuthGate = { attach, changePin, decorateAuthBar };
})();
