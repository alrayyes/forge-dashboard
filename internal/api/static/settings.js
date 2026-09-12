(function () {
  'use strict';

  var statusEl = document.getElementById('status');
  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setConfiguredBadge(id, configured) {
    document.getElementById(id).hidden = !configured;
  }

  // ---- load whatever's already saved ----
  fetch('/api/settings', { headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (res.status === 401) {
        window.location.href = '/login.html';
        return null;
      }
      return res.ok ? res.json() : Promise.reject(new Error('could not load settings (' + res.status + ')'));
    })
    .then(function (data) {
      if (!data) return;
      document.getElementById('github-username').value = data.githubUsername || '';
      document.getElementById('forgejo-url').value = data.forgejoUrl || '';
      document.getElementById('forgejo-username').value = data.forgejoUsername || '';
      setConfiguredBadge('github-token-badge', data.githubTokenSet);
      setConfiguredBadge('forgejo-token-badge', data.forgejoTokenSet);
    })
    .catch(function (err) {
      setStatus(err.message || 'Could not load settings.', 'error');
    });

  // ---- save ----
  document.getElementById('settings-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var saveButton = document.getElementById('save-button');
    saveButton.disabled = true;
    setStatus('Saving…');

    var body = {
      githubToken: document.getElementById('github-token').value,
      githubUsername: document.getElementById('github-username').value.trim(),
      forgejoUrl: document.getElementById('forgejo-url').value.trim(),
      forgejoToken: document.getElementById('forgejo-token').value,
      forgejoUsername: document.getElementById('forgejo-username').value.trim(),
    };

    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return null;
        }
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'save failed');
          return data;
        });
      })
      .then(function (data) {
        if (!data) return;
        setConfiguredBadge('github-token-badge', data.githubTokenSet);
        setConfiguredBadge('forgejo-token-badge', data.forgejoTokenSet);
        // The token fields never get pre-filled with a real value, so
        // they're cleared after a successful save rather than left
        // showing whatever was just typed — the "Configured" badge is
        // what confirms it took.
        document.getElementById('github-token').value = '';
        document.getElementById('forgejo-token').value = '';
        setStatus('Saved.', 'ok');
      })
      .catch(function (err) {
        setStatus(err.message || 'Could not save settings.', 'error');
      })
      .finally(function () {
        saveButton.disabled = false;
      });
  });
})();
