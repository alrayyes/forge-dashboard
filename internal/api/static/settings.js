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

  function escapeHTML(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // ---- show/hide toggle for token fields ----
  // A token is pasted, not typed — always-masked gives no way to notice a
  // truncated paste or stray whitespace before saving.
  document.querySelectorAll('.token-toggle').forEach(function (button) {
    button.addEventListener('click', function () {
      var input = document.getElementById(button.dataset.target);
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.textContent = showing ? 'Show' : 'Hide';
      button.setAttribute('aria-pressed', String(!showing));
      var label = button.getAttribute('aria-label').replace(/^(Show|Hide)/, showing ? 'Show' : 'Hide');
      button.setAttribute('aria-label', label);
    });
  });

  // ---- sharing ----
  var shareStatusEl = document.getElementById('share-status');
  function setShareStatus(message, kind) {
    shareStatusEl.textContent = message || '';
    shareStatusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function renderShareList(listEl, emptyEl, users, removable) {
    listEl.innerHTML = '';
    emptyEl.hidden = users.length > 0;
    users.forEach(function (u) {
      var li = document.createElement('li');
      var label = escapeHTML(u.displayName) + ' (' + escapeHTML(u.username) + ')';
      if (removable) {
        li.innerHTML = '<span>' + label + '</span><button class="btn-remove" type="button" data-username="' + escapeHTML(u.username) + '">Stop sharing</button>';
      } else {
        li.innerHTML = '<span>' + label + '</span>';
      }
      listEl.appendChild(li);
    });
  }

  function loadSharing() {
    return fetch('/api/sharing', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return null;
        }
        return res.ok ? res.json() : Promise.reject(new Error('could not load sharing (' + res.status + ')'));
      })
      .then(function (data) {
        if (!data) return;
        renderShareList(document.getElementById('shared-with-list'), document.getElementById('shared-with-empty'), data.sharedWith, true);
        renderShareList(document.getElementById('shared-with-me-list'), document.getElementById('shared-with-me-empty'), data.sharedWithMe, false);
      });
  }

  loadSharing().catch(function (err) {
    setShareStatus(err.message || 'Could not load sharing.', 'error');
  });

  document.getElementById('share-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var usernameInput = document.getElementById('share-username');
    var username = usernameInput.value.trim();
    if (!username) return;

    setShareStatus('Sharing…');
    fetch('/api/sharing/' + encodeURIComponent(username), { method: 'PUT' })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return;
        }
        if (!res.ok) {
          return res.json().then(function (data) { throw new Error(data.error || 'could not share'); });
        }
        usernameInput.value = '';
        setShareStatus('Shared with ' + username + '.', 'ok');
        return loadSharing();
      })
      .catch(function (err) {
        setShareStatus(err.message || 'Could not share.', 'error');
      });
  });

  document.getElementById('shared-with-list').addEventListener('click', function (e) {
    var button = e.target.closest('button.btn-remove');
    if (!button) return;
    var username = button.getAttribute('data-username');

    setShareStatus('Removing…');
    fetch('/api/sharing/' + encodeURIComponent(username), { method: 'DELETE' })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return;
        }
        if (!res.ok) throw new Error('could not stop sharing');
        setShareStatus('No longer shared with ' + username + '.', 'ok');
        return loadSharing();
      })
      .catch(function (err) {
        setShareStatus(err.message || 'Could not stop sharing.', 'error');
      });
  });

  // ---- Forgejo token-settings link, built from whatever URL is typed in ----
  function updateForgejoTokenLink() {
    var link = document.getElementById('forgejo-token-link');
    var raw = document.getElementById('forgejo-url').value.trim();
    if (!raw) {
      link.removeAttribute('href');
      return;
    }
    var base = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    base = base.replace(/\/+$/, '');
    link.href = base + '/user/settings/applications';
  }
  document.getElementById('forgejo-url').addEventListener('input', updateForgejoTokenLink);

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
      updateForgejoTokenLink();
    })
    .catch(function (err) {
      setStatus(err.message || 'Could not load settings.', 'error');
    });

  // ---- save ----
  document.getElementById('settings-form').addEventListener('submit', function (e) {
    e.preventDefault();

    var forgejoUrl = document.getElementById('forgejo-url').value.trim();
    var forgejoToken = document.getElementById('forgejo-token').value;
    var forgejoUsername = document.getElementById('forgejo-username').value.trim();
    // A blank token field still means "keep the one already saved" (see
    // the PUT handler's doc comment), so a saved token counts here too —
    // otherwise re-saving without retyping the token would sail past this
    // check only to be rejected server-side.
    var forgejoTokenAlreadySaved = !document.getElementById('forgejo-token-badge').hidden;
    if (!forgejoUrl && (forgejoToken || forgejoTokenAlreadySaved || forgejoUsername)) {
      setStatus('Forgejo needs an instance URL to use that token or username against.', 'error');
      document.getElementById('forgejo-url').focus();
      return;
    }

    var saveButton = document.getElementById('save-button');
    saveButton.disabled = true;
    setStatus('Saving…');

    var body = {
      githubToken: document.getElementById('github-token').value,
      githubUsername: document.getElementById('github-username').value.trim(),
      forgejoUrl: forgejoUrl,
      forgejoToken: forgejoToken,
      forgejoUsername: forgejoUsername,
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
