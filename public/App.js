// ─────────────────────────────────────────────────────────────────────────────
// DocuSign Embedded Signing — app.js
//
// Device strategy:
//   Desktop  → iframe (inline embedded signing, postMessage events)
//   Mobile   → window.open new tab (avoids IDV popup blocking),
//               state persisted in sessionStorage so the waiting screen
//               knows when the user returns after signing
// ─────────────────────────────────────────────────────────────────────────────

var state = {
  envelopeId:   null,
  signingUrl:   null,
  signerName:   null,
  signerEmail:  null,
  clientUserId: null,
  signingTab:   null,   // reference to the opened tab (mobile only)
  pollTimer:    null,   // setInterval handle for tab-closed polling
};

var SESSION_KEY = 'ds_signing_state';

// ── Device detection ─────────────────────────────────────────────────────────
function isMobile() {
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); // iPadOS
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showAlert(id, type, msg) {
  var icons = {
    error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    warn:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };
  document.getElementById(id).innerHTML =
    '<div class="alert alert-' + type + '">' + (icons[type] || '') + '<div>' + msg + '</div></div>';
}

function clearAlert(id) { document.getElementById(id).innerHTML = ''; }

function setStep(n) {
  for (var i = 1; i <= 3; i++) {
    var el = document.getElementById('step-' + i);
    if (!el) continue;
    el.classList.remove('active', 'done');
    if (i < n)  el.classList.add('done');
    if (i === n) el.classList.add('active');
  }
}

function setLoading(loading) {
  var btn = document.getElementById('btn-start');
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<div class="spinner"></div> Preparing document&hellip;'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Start Signing';
}

function showPanel(id) {
  ['panel-signer', 'signing-wrapper', 'panel-waiting', 'panel-complete'].forEach(function (p) {
    var el = document.getElementById(p);
    if (!el) return;
    el.style.display   = 'none';
    el.classList.remove('visible');
  });
  var target = document.getElementById(id);
  if (!target) return;
  target.style.display = 'block';
  target.classList.add('visible');
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Start signing (entry point) ───────────────────────────────────────────────
function startSigning() {
  var name  = document.getElementById('signerName').value.trim();
  var email = document.getElementById('signerEmail').value.trim();

  if (!name)                        { showAlert('alert-signer', 'error', "Please enter the signer's full name.");  return; }
  if (!email || !email.includes('@')) { showAlert('alert-signer', 'error', 'Please enter a valid email address.'); return; }

  clearAlert('alert-signer');
  setLoading(true);

  var clientUserId = 'signer-' + Date.now();

  fetch('/api/docusign/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signer: { name: name, email: email, clientUserId: clientUserId, roleName: 'signer' },
    }),
  })
  .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
  .then(function (r) {
    if (!r.ok) {
      if (r.data.error === 'consent_required') {
        throw new Error('Admin consent needed. <a href="' + r.data.consentUrl
          + '" target="_blank" style="color:inherit;text-decoration:underline;">Grant access &#8599;</a>');
      }
      throw new Error(r.data.error || 'Server error — check server logs.');
    }

    state.envelopeId   = r.data.envelopeId;
    state.signingUrl   = r.data.signingUrl;
    state.signerName   = name;
    state.signerEmail  = email;
    state.clientUserId = clientUserId;

    if (isMobile()) {
      openMobileSigning();
    } else {
      openDesktopSigning();
    }
  })
  .catch(function (err) {
    showAlert('alert-signer', 'error', err.message);
  })
  .finally(function () {
    setLoading(false);
  });
}

// ── Desktop: iframe flow ──────────────────────────────────────────────────────
function openDesktopSigning() {
  var iframe = document.getElementById('docusign-iframe');
  document.getElementById('frame-url-display').textContent = state.signingUrl;
  iframe.src = state.signingUrl;
  showPanel('signing-wrapper');
  setStep(2);
}

// ── Mobile: new-tab flow ──────────────────────────────────────────────────────
function openMobileSigning() {
  // Persist state to sessionStorage so we can restore it if the page reloads
  // while the user is signing in the other tab.
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    envelopeId:  state.envelopeId,
    signerName:  state.signerName,
    signerEmail: state.signerEmail,
  }));

  // Open DocuSign in a new tab. window.open must be called synchronously
  // inside a user-gesture handler — we are inside the fetch .then() chain
  // which was triggered by a button click, so this is allowed.
  var tab = window.open(state.signingUrl, '_blank');
  state.signingTab = tab;

  if (!tab) {
    // Pop-up blocker prevented the new tab — fall back to same-tab redirect
    showAlert('alert-signer', 'warn',
      'Pop-up blocked. Redirecting you to DocuSign directly&hellip;');
    setTimeout(function () {
      window.location.href = state.signingUrl;
    }, 1500);
    return;
  }

  showPanel('panel-waiting');
  setStep(2);
  startPollingTab();
}

// Poll every second to detect when the signing tab is closed.
// When DocuSign finishes it redirects to DS_REDIRECT_URI (?event=signing_complete),
// which lands back on this app. The BroadcastChannel below handles that case.
// The tab-closed poll handles the case where the user manually closes the tab.
function startPollingTab() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(function () {
    if (state.signingTab && state.signingTab.closed) {
      clearInterval(state.pollTimer);
      // Tab closed — check sessionStorage for a result written by the return page
      var saved = sessionStorage.getItem(SESSION_KEY + '_result');
      if (saved) {
        try {
          var result = JSON.parse(saved);
          sessionStorage.removeItem(SESSION_KEY + '_result');
          sessionStorage.removeItem(SESSION_KEY);
          if (result.event === 'signing_complete') {
            onComplete(result.envelopeId || state.envelopeId);
          } else {
            onCancelled(result.event || 'cancel');
          }
        } catch (e) { showSigningClosedPrompt(); }
      } else {
        // Tab closed with no result — ask the user what happened
        showSigningClosedPrompt();
      }
    }
  }, 1000);
}

function showSigningClosedPrompt() {
  showPanel('panel-waiting');
  document.getElementById('waiting-pulse').innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
    + '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
    + '</svg>'
    + '<span style="margin-left:6px;">The signing tab was closed. Did you finish signing?</span>';
  document.getElementById('btn-reopen-tab').style.display = 'inline-flex';

  // Add a "Yes, I finished" button dynamically if not already present
  if (!document.getElementById('btn-confirm-signed')) {
    var btn = document.createElement('button');
    btn.id = 'btn-confirm-signed';
    btn.className = 'btn btn-primary';
    btn.style.cssText = 'margin-top:10px;max-width:260px;';
    btn.textContent = 'Yes, I finished signing';
    btn.addEventListener('click', function () {
      onComplete(state.envelopeId || '');
    });
    document.getElementById('btn-cancel-wait').insertAdjacentElement('beforebegin', btn);
  }
}

// ── BroadcastChannel: cross-tab return communication ─────────────────────────
// When DocuSign redirects to DS_REDIRECT_URI (?event=signing_complete),
// the return page (this same app.js) broadcasts the result back to the
// waiting tab via BroadcastChannel, then closes itself.
(function setupBroadcastChannel() {
  if (!window.BroadcastChannel) return; // not supported in all browsers

  var bc = new BroadcastChannel('ds_signing');

  // Receiver: the original tab (showing the waiting screen) listens for results
  bc.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.event) return;
    clearInterval(state.pollTimer);
    bc.close();
    sessionStorage.removeItem(SESSION_KEY);
    if (d.event === 'signing_complete') {
      onComplete(d.envelopeId || state.envelopeId);
    } else {
      onCancelled(d.event);
    }
  });

  window._dsBroadcastChannel = bc; // keep reference for sender side
})();

// ── Return URL handler ────────────────────────────────────────────────────────
// Runs on page load. Handles two scenarios:
//
//  A) DocuSign redirected to DS_REDIRECT_URI with ?event=signing_complete
//     in the SAME tab (desktop fallback or same-tab redirect).
//
//  B) DocuSign redirected to DS_REDIRECT_URI in the NEW TAB opened for mobile.
//     In this case we broadcast the result back to the original tab, then close.
(function handleReturnUrl() {
  var params = new URLSearchParams(window.location.search);
  var event  = params.get('event');
  if (!event) return;

  // Clean query string immediately
  history.replaceState(null, '', window.location.pathname);

  var envelopeId = params.get('envelopeId') || params.get('envelopeid') || '';
  var result = { event: event, envelopeId: envelopeId };

  // Check if this is the return tab (opened by mobile flow)
  // Detect by checking if the opener exists and has sessionStorage state
  var isReturnTab = false;
  try {
    if (window.opener && window.opener.sessionStorage.getItem(SESSION_KEY)) {
      isReturnTab = true;
    }
  } catch (e) { /* cross-origin — not the return tab */ }

  if (isReturnTab) {
    // Write result to opener's sessionStorage as fallback
    try {
      window.opener.sessionStorage.setItem(SESSION_KEY + '_result', JSON.stringify(result));
    } catch (e) {}

    // Broadcast result to original tab via BroadcastChannel
    if (window._dsBroadcastChannel) {
      window._dsBroadcastChannel.postMessage(result);
    } else if (window.BroadcastChannel) {
      var bc = new BroadcastChannel('ds_signing');
      bc.postMessage(result);
      setTimeout(function () { bc.close(); }, 500);
    }

    // Show a brief message then close this tab
    document.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML =
        '<div style="font-family:system-ui,sans-serif;display:flex;flex-direction:column;'
        + 'align-items:center;justify-content:center;min-height:100vh;gap:16px;background:#f7f9fc;padding:32px;text-align:center;">'
        + '<div style="width:64px;height:64px;background:#d1fae5;border-radius:50%;display:flex;align-items:center;justify-content:center;">'
        + '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
        + '</div>'
        + '<div style="font-size:1.2rem;font-weight:700;color:#0f1923;">Signing complete!</div>'
        + '<div style="color:#4a5568;font-size:.9rem;">You can close this tab and return to the app.</div>'
        + '<button onclick="window.close()" style="margin-top:8px;background:#2563eb;color:white;border:none;'
        + 'padding:10px 24px;border-radius:8px;font-size:.9rem;font-weight:600;cursor:pointer;">Close this tab</button>'
        + '</div>';
    });

    // Auto-close after 2 seconds
    setTimeout(function () { window.close(); }, 2000);
    return;
  }

  // Same-tab return (desktop fallback or direct navigation)
  // Wait for DOM then handle
  function handleSameTabReturn() {
    // Restore signer state from sessionStorage if available
    var saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      try {
        var s = JSON.parse(saved);
        state.envelopeId  = envelopeId || s.envelopeId;
        state.signerName  = s.signerName;
        state.signerEmail = s.signerEmail;
      } catch (e) {}
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      state.envelopeId = envelopeId;
    }

    if (event === 'signing_complete') onComplete(state.envelopeId);
    if (event === 'cancel' || event === 'decline') onCancelled(event);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handleSameTabReturn);
  } else {
    handleSameTabReturn();
  }
})();

// ── postMessage: iframe events (desktop) ─────────────────────────────────────
window.addEventListener('message', function (e) {
  var d = e.data;
  if (!d) return;
  if (d.type === 'docusign') {
    if (d.event === 'signing_complete')                onComplete(d.envelopeId || state.envelopeId);
    if (d.event === 'cancel' || d.event === 'decline') onCancelled(d.event);
    return;
  }
  if (typeof d === 'string') {
    if (d === 'signing_complete') onComplete(state.envelopeId);
    if (d === 'cancel' || d === 'decline') onCancelled(d);
  }
});

// ── Completion handlers ───────────────────────────────────────────────────────
function onComplete(envelopeId) {
  clearInterval(state.pollTimer);
  showPanel('panel-complete');

  var id = envelopeId || state.envelopeId || '—';
  document.getElementById('complete-summary').innerHTML =
    '<div class="summary-row"><span class="summary-label">Signer</span><span>'  + (state.signerName  || '—') + '</span></div>'
    + '<div class="summary-row"><span class="summary-label">Email</span><span>' + (state.signerEmail || '—') + '</span></div>'
    + '<div class="summary-row"><span class="summary-label">Envelope</span><span style="font-size:.75rem;font-family:monospace;">' + id + '</span></div>'
    + '<div class="summary-row"><span class="summary-label">Completed</span><span>' + new Date().toLocaleString() + '</span></div>';

  setStep(3);
}

function onCancelled(event) {
  clearInterval(state.pollTimer);
  showPanel('panel-signer');
  showAlert('alert-signer', 'error',
    'Signing was ' + (event === 'decline' ? 'declined' : 'cancelled') + '. You can try again.');
  setStep(1);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetFlow() {
  clearInterval(state.pollTimer);
  if (state.signingTab && !state.signingTab.closed) state.signingTab.close();
  state = { envelopeId: null, signingUrl: null, signerName: null,
            signerEmail: null, clientUserId: null, signingTab: null, pollTimer: null };
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY + '_result');

  document.getElementById('docusign-iframe').src = '';
  document.getElementById('signerName').value  = '';
  document.getElementById('signerEmail').value = '';
  clearAlert('alert-signer');

  showPanel('panel-signer');
  setStep(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-start').addEventListener('click', startSigning);
  document.getElementById('btn-sign-another').addEventListener('click', resetFlow);
  document.getElementById('btn-cancel-wait').addEventListener('click', function () {
    clearInterval(state.pollTimer);
    if (state.signingTab && !state.signingTab.closed) state.signingTab.close();
    sessionStorage.removeItem(SESSION_KEY);
    showPanel('panel-signer');
    setStep(1);
  });
  document.getElementById('btn-reopen-tab').addEventListener('click', function () {
    if (state.signingUrl) {
      state.signingTab = window.open(state.signingUrl, '_blank');
      startPollingTab();
      // Reset waiting pulse
      document.getElementById('waiting-pulse').innerHTML =
        '<div class="spinner" style="border-top-color:var(--accent);border-color:var(--border);width:14px;height:14px;border-width:2px;"></div>'
        + '<span style="margin-left:6px;">Waiting for signing to complete&hellip;</span>';
      var old = document.getElementById('btn-confirm-signed');
      if (old) old.remove();
    }
  });

  document.getElementById('signerEmail').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') startSigning();
  });

  // Set environment badge
  fetch('/api/config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      var badge = document.getElementById('env-badge');
      if (cfg.environment === 'production') {
        badge.textContent        = 'Production';
        badge.style.background   = 'var(--danger-lt)';
        badge.style.color        = 'var(--danger)';
      }
      // Show device mode hint in badge subtitle
      var sub = document.getElementById('header-sub');
      if (sub) sub.textContent = isMobile() ? 'Mobile · New tab signing' : 'Desktop · Embedded signing';
    })
    .catch(function () {});

  // On mobile, show a subtle hint below the button
  if (isMobile()) {
    var btn = document.getElementById('btn-start');
    var hint = document.createElement('p');
    hint.style.cssText = 'font-size:.75rem;color:var(--ink-muted);text-align:center;margin-top:10px;';
    hint.textContent   = 'DocuSign will open in a new tab on your device';
    btn.insertAdjacentElement('afterend', hint);
  }
});
