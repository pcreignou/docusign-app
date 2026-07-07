/**
 * DocuSign Embedded Signing — Express Backend
 * Handles JWT grant auth, envelope creation, and recipient view URL.
 *
 * Endpoints:
 *   POST /api/docusign/authenticate  → returns { accessToken, expiresAt }
 *   POST /api/docusign/envelope      → returns { envelopeId }
 *   POST /api/docusign/signing-url   → returns { signingUrl }
 *   GET  /api/health                 → returns { ok: true }
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const jwt        = require('jsonwebtoken');
const axios      = require('axios');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Config — sourced from environment variables
// ─────────────────────────────────────────────
const config = {
  integrationKey : process.env.DS_INTEGRATION_KEY,
  userId         : process.env.DS_USER_ID,
  accountId      : process.env.DS_ACCOUNT_ID,
  templateId      : process.env.DS_TEMPLATE_ID,
  // RSA private key: store as a single-line env var with \n for newlines
  // e.g.  DS_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----"
  privateKey     : (process.env.DS_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  isDemo         : process.env.DS_ENVIRONMENT !== 'production',
};

const oauthBase = config.isDemo
  ? 'https://account-d.docusign.com'
  : 'https://account.docusign.com';

const apiBase = config.isDemo
  ? 'https://demo.docusign.net/restapi/v2.1'
  : 'https://www.docusign.net/restapi/v2.1';

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(helmet({
  // Allow iframe embedding for the signing page
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],  // needed for inline scripts in index.html
      styleSrc:   ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc:    ["'self'", 'fonts.gstatic.com'],
      frameSrc:   ["'self'", 'https://demo.docusign.net', 'https://www.docusign.net', 'https://account-d.docusign.com'],
      connectSrc: ["'self'", 'https://account-d.docusign.com', 'https://account.docusign.com',
                   'https://demo.docusign.net', 'https://www.docusign.net'],
      imgSrc:     ["'self'", 'data:'],
    },
  },
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*', // tighten this to your frontend URL in production
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// Rate limiter — 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', limiter);

// Serve the frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// In-memory token cache (avoids redundant JWT exchanges)
// ─────────────────────────────────────────────
let tokenCache = { accessToken: null, expiresAt: 0 };

function getCachedToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }
  return null;
}

function setCachedToken(token, expiresInSeconds) {
  tokenCache = {
    accessToken: token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

// ─────────────────────────────────────────────
// DocuSign helpers
// ─────────────────────────────────────────────

/**
 * Build a signed JWT assertion for the JWT grant flow.
 */
function buildJwtAssertion(integrationKey, userId, privateKey, isDemo) {
  const audience = isDemo ? 'account-d.docusign.com' : 'account.docusign.com';
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iss: integrationKey,
      sub: userId,
      aud: audience,
      iat: now,
      exp: now + 3600,
      scope: 'signature impersonation',
    },
    privateKey,
    { algorithm: 'RS256' }
  );
}

/**
 * Exchange a JWT assertion for a DocuSign OAuth access token.
 */
async function exchangeJwtForToken(jwtAssertion) {
  const url = `${oauthBase}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwtAssertion,
  });

  const response = await axios.post(url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return response.data; // { access_token, token_type, expires_in, scope }
}

/**
 * Create an envelope from a template with embedded signing.
 */
async function createEnvelopeFromTemplate({ accessToken, accountId, templateId, signer }) {
  const url = `${apiBase}/accounts/${accountId}/envelopes`;

  const envelopeDefinition = {
    templateId,
    status: 'sent',
    templateRoles: [
      {
        email:        signer.email,
        name:         signer.name,
        roleName:     signer.roleName || 'signer',
        clientUserId: signer.clientUserId, // required for embedded signing
      },
    ],
  };

  const response = await axios.post(url, envelopeDefinition, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  return response.data; // { envelopeId, status, statusDateTime, ... }
}

/**
 * Get the recipient view (embedded signing URL) for an envelope.
 */
async function getRecipientView({ accessToken, accountId, envelopeId, signer, returnUrl }) {
  const url = `${apiBase}/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`;

  const viewRequest = {
    returnUrl,
    authenticationMethod: 'none',
    email:        signer.email,
    userName:     signer.name,
    clientUserId: signer.clientUserId,
  };

  const response = await axios.post(url, viewRequest, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  return response.data; // { url }
}

// ─────────────────────────────────────────────
// Input validation helpers
// ─────────────────────────────────────────────
function validateSigner(signer) {
  if (!signer || typeof signer !== 'object') return 'signer object is required';
  if (!signer.name  || typeof signer.name  !== 'string') return 'signer.name is required';
  if (!signer.email || !signer.email.includes('@'))       return 'signer.email must be a valid email';
  if (!signer.clientUserId)                               return 'signer.clientUserId is required';
  return null;
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

/**
 * GET /api/health
 * Simple liveness check — also tells you which environment is active.
 */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    environment: config.isDemo ? 'demo' : 'production',
    configLoaded: !!(config.integrationKey && config.userId && config.accountId && config.privateKey),
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/docusign/authenticate
 * Exchanges a JWT assertion for a DocuSign access token.
 * Returns the token (server caches it; client only needs it for reference).
 *
 * Body: {} (uses server-side env vars — no secrets from client)
 * Returns: { accessToken, expiresAt, environment }
 */
app.post('/api/docusign/authenticate', async (req, res) => {
  try {
    // Check required config
    if (!config.integrationKey || !config.userId || !config.privateKey) {
      return res.status(500).json({
        error: 'Server is missing DocuSign configuration. Check environment variables.',
      });
    }

    // Return cached token if still valid
    const cached = getCachedToken();
    if (cached) {
      return res.json({
        accessToken: maskToken(cached),
        expiresAt: tokenCache.expiresAt,
        environment: config.isDemo ? 'demo' : 'production',
        cached: true,
      });
    }

    // Build and exchange JWT
    const assertion = buildJwtAssertion(
      config.integrationKey,
      config.userId,
      config.privateKey,
      config.isDemo
    );

    const tokenData = await exchangeJwtForToken(assertion);
    setCachedToken(tokenData.access_token, tokenData.expires_in);

    res.json({
      accessToken: maskToken(tokenData.access_token),
      expiresAt: tokenCache.expiresAt,
      environment: config.isDemo ? 'demo' : 'production',
      cached: false,
    });

  } catch (err) {
    const status  = err.response?.status  || 500;
    const message = err.response?.data?.error_description || err.message;
    console.error('[authenticate] Error:', message);

    // Consent not granted yet — give the developer the consent URL
    if (message?.includes('consent_required') || status === 400) {
      const consentUrl = `${oauthBase}/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=${config.integrationKey}&redirect_uri=${encodeURIComponent(process.env.DS_REDIRECT_URI || 'https://example.com')}`;
      return res.status(400).json({
        error: 'consent_required',
        message: 'User consent is required. Visit the consentUrl to grant access, then retry.',
        consentUrl,
      });
    }

    res.status(status).json({ error: message });
  }
});

/**
 * POST /api/docusign/envelope
 * Creates a DocuSign envelope from a template.
 *
 * Body: { templateId, signer: { name, email, clientUserId, roleName? } }
 * Returns: { envelopeId, status }
 */
app.post('/api/docusign/envelope', async (req, res) => {
  try {
    const { templateId, signer } = req.body;

    if (!templateId) return res.status(400).json({ error: 'templateId is required' });
    const signerError = validateSigner(signer);
    if (signerError)  return res.status(400).json({ error: signerError });

    // Get (or refresh) access token
    let accessToken = getCachedToken();
    if (!accessToken) {
      const assertion = buildJwtAssertion(config.integrationKey, config.userId, config.privateKey, config.isDemo);
      const tokenData = await exchangeJwtForToken(assertion);
      setCachedToken(tokenData.access_token, tokenData.expires_in);
      accessToken = tokenData.access_token;
    }

    const envelope = await createEnvelopeFromTemplate({
      accessToken,
      accountId:  config.accountId,
      templateId,
      signer,
    });

    console.log(`[envelope] Created: ${envelope.envelopeId} for ${signer.email}`);

    res.json({
      envelopeId: envelope.envelopeId,
      status:     envelope.status,
    });

  } catch (err) {
    const status  = err.response?.status  || 500;
    const message = err.response?.data?.message || err.message;
    console.error('[envelope] Error:', message);
    res.status(status).json({ error: message });
  }
});

/**
 * POST /api/docusign/signing-url
 * Returns the embedded signing URL for a given envelope + signer.
 *
 * Body: { envelopeId, signer: { name, email, clientUserId }, returnUrl }
 * Returns: { signingUrl }
 */
app.post('/api/docusign/signing-url', async (req, res) => {
  try {
    const { envelopeId, signer, returnUrl } = req.body;

    if (!envelopeId) return res.status(400).json({ error: 'envelopeId is required' });
    if (!returnUrl)  return res.status(400).json({ error: 'returnUrl is required' });
    const signerError = validateSigner(signer);
    if (signerError)  return res.status(400).json({ error: signerError });

    // Validate returnUrl is a proper URL
    try { new URL(returnUrl); } catch {
      return res.status(400).json({ error: 'returnUrl must be a valid URL' });
    }

    let accessToken = getCachedToken();
    if (!accessToken) {
      const assertion = buildJwtAssertion(config.integrationKey, config.userId, config.privateKey, config.isDemo);
      const tokenData = await exchangeJwtForToken(assertion);
      setCachedToken(tokenData.access_token, tokenData.expires_in);
      accessToken = tokenData.access_token;
    }

    const view = await getRecipientView({
      accessToken,
      accountId:  config.accountId,
      envelopeId,
      signer,
      returnUrl,
    });

    console.log(`[signing-url] Generated for envelope ${envelopeId}`);

    res.json({ signingUrl: view.url });

  } catch (err) {
    const status  = err.response?.status  || 500;
    const message = err.response?.data?.message || err.message;
    console.error('[signing-url] Error:', message);
    res.status(status).json({ error: message });
  }
});

/**
 * POST /api/docusign/sign  (convenience: does all 3 steps in one call)
 * Authenticates, creates envelope, and returns the signing URL.
 *
 * Body: { templateId, signer: { name, email, clientUserId, roleName? }, returnUrl }
 * Returns: { envelopeId, signingUrl }
 */
app.post('/api/docusign/sign', async (req, res) => {
  try {
    const { templateId, signer, returnUrl } = req.body;

    if (!templateId) return res.status(400).json({ error: 'templateId is required' });
    if (!returnUrl)  return res.status(400).json({ error: 'returnUrl is required' });
    const signerError = validateSigner(signer);
    if (signerError)  return res.status(400).json({ error: signerError });

    // Step 1: token
    let accessToken = getCachedToken();
    if (!accessToken) {
      const assertion = buildJwtAssertion(config.integrationKey, config.userId, config.privateKey, config.isDemo);
      const tokenData = await exchangeJwtForToken(assertion);
      setCachedToken(tokenData.access_token, tokenData.expires_in);
      accessToken = tokenData.access_token;
    }

    // Step 2: envelope
    const envelope = await createEnvelopeFromTemplate({
      accessToken,
      accountId:  config.accountId,
      templateId,
      signer,
    });

    // Step 3: signing URL
    const view = await getRecipientView({
      accessToken,
      accountId:  config.accountId,
      envelopeId: envelope.envelopeId,
      signer,
      returnUrl,
    });

    console.log(`[sign] Envelope ${envelope.envelopeId} ready for ${signer.email}`);

    res.json({
      envelopeId: envelope.envelopeId,
      signingUrl: view.url,
    });

  } catch (err) {
    const status  = err.response?.status  || 500;
    const message = err.response?.data?.message || err.message;
    console.error('[sign] Error:', message);
    res.status(status).json({ error: message });
  }
});

// ─────────────────────────────────────────────
// Catch-all: serve frontend with env values injected
// ─────────────────────────────────────────────
app.get('*', (req, res) => {
  const fs = require('fs');
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  fs.readFile(htmlPath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load index.html');

    // Inject a small config script before </head>
    // Only non-secret values are sent — the RSA key never leaves the server.
    // Build config block using string concat — no template literal escaping issues
    const configScript = '<script>\n'
      + '  window.__DS_CONFIG__ = {\n'
      + '    accountId:      ' + JSON.stringify(config.accountId      || '') + ',\n'
	  + '    templateId:      ' + JSON.stringify(config.templateId      || '') + ',\n'
      + '    integrationKey: ' + JSON.stringify(config.integrationKey || '') + ',\n'
      + '    userId:         ' + JSON.stringify(config.userId         || '') + ',\n'
      + '    environment:    ' + JSON.stringify(config.isDemo ? 'demo' : 'production') + ',\n'
      + '  };\n'
      + '<\/script>';

    html = html.replace('</head>', configScript + '\n</head>');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function maskToken(token) {
  if (!token || token.length < 16) return '••••••••';
  return token.slice(0, 8) + '••••••••' + token.slice(-6);
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  DocuSign server running on port ${PORT}`);
  console.log(`   Environment : ${config.isDemo ? 'Demo (sandbox)' : 'Production'}`);
  console.log(`   Config OK   : ${!!(config.integrationKey && config.userId && config.accountId && config.privateKey)}`);
  console.log(`   Health      : http://localhost:${PORT}/api/health\n`);
});
