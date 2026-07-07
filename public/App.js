var state = { envelopeId: null, signingUrl: null, signerName: null, signerEmail: null };

// ── Helpers ──────────────────────────────────
function showAlert(id, type, msg) {
  var icons = {
    error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
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
    if (i < n) el.classList.add('done');
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

// ── Start signing ────────────────────────────
function startSigning() {
  var name  = document.getElementById('signerName').value.trim();
  var email = document.getElementById('signerEmail').value.trim();

  if (!name)  { showAlert('alert-signer', 'error', 'Please enter the signer\'s full name.'); return; }
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
        throw new Error('Admin consent needed. <a href="' + r.data.consentUrl + '" target="_blank" style="color:inherit;text-decoration:underline;">Grant access &#8599;</a>');
      }
      throw new Error(r.data.error || 'Server error — check server logs.');
    }

    state.envelopeId  = r.data.envelopeId;
    state.signingUrl  = r.data.signingUrl;
    state.signerName  = name;
    state.signerEmail = email;

    // Open iframe
    var wrapper = document.getElementById('signing-wrapper');
    var iframe  = document.getElementById('docusign-iframe');
    document.getElementById('frame-url-display').textContent = r.data.signingUrl;
    iframe.src = r.data.signingUrl;
    wrapper.classList.add('visible');
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStep(2);
  })
  .catch(function (err) {
    showAlert('alert-signer', 'error', err.message);
  })
  .finally(function () {
    setLoading(false);
  });
}

// ── DocuSign postMessage events ──────────────
window.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.type !== 'docusign') return;
  if (d.event === 'signing_complete')             onComplete(d.envelopeId);
  if (d.event === 'cancel' || d.event === 'decline') onCancelled(d.event);
});

function onComplete(envelopeId) {
  document.getElementById('signing-wrapper').classList.remove('visible');

  document.getElementById('complete-summary').innerHTML =
    '<div class="summary-row"><span class="summary-label">Signer</span><span>' + state.signerName + '</span></div>'
    + '<div class="summary-row"><span class="summary-label">Email</span><span>' + state.signerEmail + '</span></div>'
    + '<div class="summary-row"><span class="summary-label">Envelope</span><span style="font-size:.75rem;font-family:monospace;">' + envelopeId + '</span></div>'
    + '<div class="summary-row"><span class="summary-label">Completed</span><span>' + new Date().toLocaleString() + '</span></div>';

  document.getElementById('panel-complete').style.display = 'block';
  document.getElementById('panel-complete').scrollIntoView({ behavior: 'smooth' });
  setStep(3);
}

function onCancelled(event) {
  document.getElementById('signing-wrapper').classList.remove('visible');
  showAlert('alert-signer', 'error', 'Signing was ' + (event === 'decline' ? 'declined' : 'cancelled') + '. You can try again.');
  setStep(1);
}

function resetFlow() {
  state = { envelopeId: null, signingUrl: null, signerName: null, signerEmail: null };
  document.getElementById('panel-complete').style.display = 'none';
  document.getElementById('signing-wrapper').classList.remove('visible');
  document.getElementById('docusign-iframe').src = '';
  document.getElementById('signerName').value = '';
  document.getElementById('signerEmail').value = '';
  clearAlert('alert-signer');
  setStep(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Init ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('btn-start').addEventListener('click', startSigning);
  document.getElementById('btn-sign-another').addEventListener('click', resetFlow);

  // Allow Enter key to submit
  document.getElementById('signerEmail').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') startSigning();
  });

  // Show environment badge from server config
  fetch('/api/config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      if (cfg.environment === 'production') {
        var badge = document.getElementById('env-badge');
        badge.textContent = 'Production';
        badge.style.background = 'var(--danger-lt)';
        badge.style.color = 'var(--danger)';
      }
    })
    .catch(function () {});
});

