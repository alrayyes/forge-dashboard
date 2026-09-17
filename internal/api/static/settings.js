(() => {
  var statusEl = document.getElementById('status');
  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = `status${kind ? ` ${kind}` : ''}`;
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
  document.querySelectorAll('.token-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      var input = document.getElementById(button.dataset.target);
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.textContent = showing ? 'Show' : 'Hide';
      button.setAttribute('aria-pressed', String(!showing));
      var label = button
        .getAttribute('aria-label')
        .replace(/^(Show|Hide)/, showing ? 'Show' : 'Hide');
      button.setAttribute('aria-label', label);
    });
  });

  // ---- sharing ----
  var shareStatusEl = document.getElementById('share-status');
  function setShareStatus(message, kind) {
    shareStatusEl.textContent = message || '';
    shareStatusEl.className = `status${kind ? ` ${kind}` : ''}`;
  }

  function renderShareList(listEl, emptyEl, users, removable) {
    listEl.innerHTML = '';
    emptyEl.hidden = users.length > 0;
    users.forEach((u) => {
      var li = document.createElement('li');
      var label = `${escapeHTML(u.displayName)} (${escapeHTML(u.username)})`;
      if (removable) {
        li.innerHTML =
          '<span>' +
          label +
          '</span><button class="btn-remove" type="button" data-username="' +
          escapeHTML(u.username) +
          '">Stop sharing</button>';
      } else {
        li.innerHTML = `<span>${label}</span>`;
      }
      listEl.appendChild(li);
    });
  }

  function loadSharing() {
    return fetch('/api/sharing', { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(new Error(`could not load sharing (${res.status})`));
      })
      .then((data) => {
        if (!data) return;
        renderShareList(
          document.getElementById('shared-with-list'),
          document.getElementById('shared-with-empty'),
          data.sharedWith,
          true,
        );
        renderShareList(
          document.getElementById('shared-with-me-list'),
          document.getElementById('shared-with-me-empty'),
          data.sharedWithMe,
          false,
        );
      });
  }

  loadSharing().catch((err) => {
    setShareStatus(err.message || 'Could not load sharing.', 'error');
  });

  document.getElementById('share-form').addEventListener('submit', (e) => {
    e.preventDefault();
    var usernameInput = document.getElementById('share-username');
    var username = usernameInput.value.trim();
    if (!username) return;

    setShareStatus('Sharing…');
    fetch(`/api/sharing/${encodeURIComponent(username)}`, { method: 'PUT' })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return;
        }
        if (!res.ok) {
          return res.json().then((data) => {
            throw new Error(data.error || 'could not share');
          });
        }
        usernameInput.value = '';
        setShareStatus(`Shared with ${username}.`, 'ok');
        return loadSharing();
      })
      .catch((err) => {
        setShareStatus(err.message || 'Could not share.', 'error');
      });
  });

  document.getElementById('shared-with-list').addEventListener('click', (e) => {
    var button = e.target.closest('button.btn-remove');
    if (!button) return;
    var username = button.getAttribute('data-username');

    setShareStatus('Removing…');
    fetch(`/api/sharing/${encodeURIComponent(username)}`, { method: 'DELETE' })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return;
        }
        if (!res.ok) throw new Error('could not stop sharing');
        setShareStatus(`No longer shared with ${username}.`, 'ok');
        return loadSharing();
      })
      .catch((err) => {
        setShareStatus(err.message || 'Could not stop sharing.', 'error');
      });
  });

  // ---- webhook URLs/secret ----
  var webhookCopyStatusEl = document.getElementById('webhook-copy-status');
  function setWebhookCopyStatus(message, kind) {
    webhookCopyStatusEl.textContent = message || '';
    webhookCopyStatusEl.className = `status${kind ? ` ${kind}` : ''}`;
  }

  document.querySelectorAll('.copy-button').forEach((button) => {
    button.addEventListener('click', () => {
      var input = document.getElementById(button.dataset.copyTarget);
      navigator.clipboard
        .writeText(input.value)
        .then(() => {
          setWebhookCopyStatus('Copied.', 'ok');
        })
        .catch(() => {
          setWebhookCopyStatus(
            'Could not copy — select and copy the URL by hand.',
            'error',
          );
        });
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
    var base = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    base = base.replace(/\/+$/, '');
    link.href = `${base}/user/settings/applications`;
  }
  document
    .getElementById('forgejo-url')
    .addEventListener('input', updateForgejoTokenLink);

  // ---- Renovate rebase label: only relevant once bot-PR updates are allowed ----
  function updateRenovateRebaseLabelVisibility() {
    document.getElementById('renovate-rebase-label-field').hidden =
      !document.getElementById('allow-bot-pr-updates').checked;
  }
  document
    .getElementById('allow-bot-pr-updates')
    .addEventListener('change', updateRenovateRebaseLabelVisibility);

  // ---- load whatever's already saved ----
  fetch('/api/settings', { headers: { Accept: 'application/json' } })
    .then((res) => {
      if (res.status === 401) {
        window.location.href = '/login.html';
        return null;
      }
      return res.ok
        ? res.json()
        : Promise.reject(new Error(`could not load settings (${res.status})`));
    })
    .then((data) => {
      if (!data) return;
      document.getElementById('github-username').value =
        data.githubUsername || '';
      document.getElementById('forgejo-url').value = data.forgejoUrl || '';
      document.getElementById('forgejo-username').value =
        data.forgejoUsername || '';
      setConfiguredBadge('github-token-badge', data.githubTokenSet);
      setConfiguredBadge('forgejo-token-badge', data.forgejoTokenSet);
      updateForgejoTokenLink();
      document.getElementById('webhook-url-github').value =
        `${window.location.origin}/api/webhooks/github/${data.webhookToken}`;
      document.getElementById('webhook-url-forgejo').value =
        `${window.location.origin}/api/webhooks/forgejo/${data.webhookToken}`;
      document.getElementById('webhook-secret').value = data.webhookSecret;
      document.getElementById('allow-bot-pr-updates').checked =
        !!data.allowBotPrUpdates;
      document.getElementById('renovate-rebase-label').value =
        data.renovateRebaseLabel || '';
      updateRenovateRebaseLabelVisibility();
    })
    .catch((err) => {
      setStatus(err.message || 'Could not load settings.', 'error');
    });

  // ---- webhook coverage summary ----
  // hasWebhook is primarily a live check against the forge's own webhook
  // list, falling back to settings.Store's delivery table when that
  // check errored or a repo's Source has no webhook path configured yet
  // — see internal/dashboard.WebhookChecker. Only the summary lives
  // here; the per-repo detail is /webhooks.html.
  fetch('/api/dashboard', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      var repos = data?.repos || [];
      var summary = document.getElementById('webhook-coverage-summary');
      if (!repos.length) {
        summary.hidden = true;
        return;
      }
      var withWebhook = repos.filter((r) => r.hasWebhook).length;
      document.getElementById('webhook-coverage-count').textContent =
        `${withWebhook} of ${repos.length} confirmed`;
      summary.hidden = false;
    })
    .catch(() => {
      // A transient failure here just leaves the summary hidden — this
      // page's own settings form is where a real error banner belongs.
    });

  // ---- save ----
  document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();

    var forgejoUrl = document.getElementById('forgejo-url').value.trim();
    var forgejoToken = document.getElementById('forgejo-token').value;
    var forgejoUsername = document
      .getElementById('forgejo-username')
      .value.trim();
    // A blank token field still means "keep the one already saved" (see
    // the PUT handler's doc comment), so a saved token counts here too —
    // otherwise re-saving without retyping the token would sail past this
    // check only to be rejected server-side.
    var forgejoTokenAlreadySaved = !document.getElementById(
      'forgejo-token-badge',
    ).hidden;
    if (
      !forgejoUrl &&
      (forgejoToken || forgejoTokenAlreadySaved || forgejoUsername)
    ) {
      setStatus(
        'Forgejo needs an instance URL to use that token or username against.',
        'error',
      );
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
      allowBotPrUpdates: document.getElementById('allow-bot-pr-updates')
        .checked,
      renovateRebaseLabel: document
        .getElementById('renovate-rebase-label')
        .value.trim(),
    };

    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return null;
        }
        return res.json().then((data) => {
          if (!res.ok) throw new Error(data.error || 'save failed');
          return data;
        });
      })
      .then((data) => {
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
      .catch((err) => {
        setStatus(err.message || 'Could not save settings.', 'error');
      })
      .finally(() => {
        saveButton.disabled = false;
      });
  });

  // ---- API tokens ----
  var tokenStatusEl = document.getElementById('token-status');
  function setTokenStatus(message, kind) {
    tokenStatusEl.textContent = message || '';
    tokenStatusEl.className = `status${kind ? ` ${kind}` : ''}`;
  }

  function renderTokenList(tokens) {
    var listEl = document.getElementById('api-token-list');
    var emptyEl = document.getElementById('api-token-empty');
    listEl.innerHTML = '';
    emptyEl.hidden = tokens.length > 0;
    tokens.forEach((tok) => {
      var created = new Date(tok.createdAt).toLocaleDateString();
      var lastUsed = tok.lastUsedAt
        ? new Date(tok.lastUsedAt).toLocaleDateString()
        : 'never used';
      var li = document.createElement('li');
      li.innerHTML =
        '<span>' +
        escapeHTML(tok.label) +
        '<br><span class="api-token-meta">Created ' +
        created +
        ' &middot; Last used ' +
        lastUsed +
        '</span></span><button class="btn-remove" type="button" data-token-id="' +
        escapeHTML(tok.id) +
        '">Revoke</button>';
      listEl.appendChild(li);
    });
  }

  function loadTokens() {
    return fetch('/api/tokens', { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(
              new Error(`could not load api tokens (${res.status})`),
            );
      })
      .then((tokens) => {
        if (!tokens) return;
        renderTokenList(tokens);
      });
  }

  loadTokens().catch((err) => {
    setTokenStatus(err.message || 'Could not load API tokens.', 'error');
  });

  document.getElementById('token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    var labelInput = document.getElementById('token-label');
    var label = labelInput.value.trim();
    if (!label) return;

    setTokenStatus('Generating…');
    fetch('/api/tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ label: label }),
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return null;
        }
        if (!res.ok) {
          return res.json().then((data) => {
            throw new Error(data.error || 'could not generate token');
          });
        }
        return res.json();
      })
      .then((created) => {
        if (!created) return;
        labelInput.value = '';
        document.getElementById('token-reveal-value').value = created.token;
        document.getElementById('token-reveal-field').hidden = false;
        setTokenStatus(`Generated "${created.label}".`, 'ok');
        return loadTokens();
      })
      .catch((err) => {
        setTokenStatus(err.message || 'Could not generate token.', 'error');
      });
  });

  document.getElementById('api-token-list').addEventListener('click', (e) => {
    var button = e.target.closest('button.btn-remove');
    if (!button) return;
    var id = button.getAttribute('data-token-id');

    setTokenStatus('Revoking…');
    fetch(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return;
        }
        if (!res.ok) throw new Error('could not revoke token');
        setTokenStatus('Revoked.', 'ok');
        return loadTokens();
      })
      .catch((err) => {
        setTokenStatus(err.message || 'Could not revoke token.', 'error');
      });
  });

  // Not swept up by the generic .copy-button loop above on purpose — see
  // the .token-copy-button CSS comment in settings.html for why.
  document.querySelectorAll('.token-copy-button').forEach((button) => {
    button.addEventListener('click', () => {
      var input = document.getElementById(button.dataset.copyTarget);
      navigator.clipboard
        .writeText(input.value)
        .then(() => {
          setTokenStatus('Copied.', 'ok');
        })
        .catch(() => {
          setTokenStatus(
            'Could not copy — select and copy the token by hand.',
            'error',
          );
        });
    });
  });
})();
