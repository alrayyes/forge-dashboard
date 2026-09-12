(function () {
  'use strict';

  // ---- base64url <-> ArrayBuffer ----
  function base64urlToBuffer(base64url) {
    var padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
    var padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    var binary = atob(padded + padding);
    var buffer = new ArrayBuffer(binary.length);
    var bytes = new Uint8Array(buffer);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return buffer;
  }

  function bufferToBase64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ---- WebAuthn options: server JSON -> browser-ready objects ----
  function prepareCreationOptions(options) {
    options.publicKey.challenge = base64urlToBuffer(options.publicKey.challenge);
    options.publicKey.user.id = base64urlToBuffer(options.publicKey.user.id);
    if (options.publicKey.excludeCredentials) {
      options.publicKey.excludeCredentials.forEach(function (c) {
        c.id = base64urlToBuffer(c.id);
      });
    }
    return options.publicKey;
  }

  function prepareRequestOptions(options) {
    options.publicKey.challenge = base64urlToBuffer(options.publicKey.challenge);
    if (options.publicKey.allowCredentials) {
      options.publicKey.allowCredentials.forEach(function (c) {
        c.id = base64urlToBuffer(c.id);
      });
    }
    return options.publicKey;
  }

  // ---- WebAuthn credential: browser object -> server JSON ----
  function creationCredentialToJSON(cred) {
    var response = cred.response;
    return {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToBase64url(response.clientDataJSON),
        attestationObject: bufferToBase64url(response.attestationObject),
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
  }

  function assertionCredentialToJSON(cred) {
    var response = cred.response;
    return {
      id: cred.id,
      rawId: bufferToBase64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufferToBase64url(response.clientDataJSON),
        authenticatorData: bufferToBase64url(response.authenticatorData),
        signature: bufferToBase64url(response.signature),
        userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
  }

  // ---- status line ----
  var statusEl = document.getElementById('status');
  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function postJSON(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'request failed (' + res.status + ')');
    return data;
  }

  // ---- login ----
  var loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var username = document.getElementById('login-username').value.trim();
    if (!username) return;

    var submitBtn = document.getElementById('login-submit');
    submitBtn.disabled = true;
    setStatus('Waiting for your passkey…');

    try {
      var options = await postJSON('/api/auth/login/begin', { username: username });
      var publicKey = prepareRequestOptions(options);
      var assertion = await navigator.credentials.get({ publicKey: publicKey });
      var credentialJSON = assertionCredentialToJSON(assertion);

      var res = await fetch('/api/auth/login/finish?username=' + encodeURIComponent(username), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(credentialJSON),
      });
      if (!res.ok) {
        var errBody = await res.json().catch(function () { return {}; });
        throw new Error(errBody.error || 'sign-in failed');
      }

      setStatus('Signed in.', 'ok');
      window.location.href = '/';
    } catch (err) {
      setStatus(err.message || 'Sign-in failed.', 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- register ----
  var registerForm = document.getElementById('register-form');
  registerForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var username = document.getElementById('register-username').value.trim();
    var displayName = document.getElementById('register-display-name').value.trim();
    if (!username || !displayName) return;

    var submitBtn = document.getElementById('register-submit');
    submitBtn.disabled = true;
    setStatus('Follow your browser or device prompt to create a passkey…');

    try {
      var options = await postJSON('/api/auth/register/begin', { username: username, displayName: displayName });
      var publicKey = prepareCreationOptions(options);
      var credential = await navigator.credentials.create({ publicKey: publicKey });
      var credentialJSON = creationCredentialToJSON(credential);

      var res = await fetch('/api/auth/register/finish?username=' + encodeURIComponent(username), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(credentialJSON),
      });
      if (!res.ok) {
        var errBody = await res.json().catch(function () { return {}; });
        throw new Error(errBody.error || 'registration failed');
      }

      setStatus('Passkey created. Signed in.', 'ok');
      window.location.href = '/';
    } catch (err) {
      setStatus(err.message || 'Registration failed.', 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---- toggling between the two forms ----
  document.getElementById('show-register').addEventListener('click', function () {
    loginForm.hidden = true;
    registerForm.hidden = false;
    setStatus('');
    document.getElementById('register-username').focus();
  });
  document.getElementById('show-login').addEventListener('click', function () {
    registerForm.hidden = true;
    loginForm.hidden = false;
    setStatus('');
    document.getElementById('login-username').focus();
  });

  if (!window.PublicKeyCredential) {
    setStatus('This browser does not support passkeys.', 'error');
    loginForm.querySelectorAll('button, input').forEach(function (el) { el.disabled = true; });
  }
})();
