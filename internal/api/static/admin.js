(() => {
  var statusEl = document.getElementById('status');
  var rowsEl = document.getElementById('user-rows');
  var emptyStateEl = document.getElementById('empty-state');
  var currentUsername = null;

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = `status${kind ? ` ${kind}` : ''}`;
  }

  function escapeHTML(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function formatDate(iso) {
    var d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  }

  function renderUsers(users) {
    rowsEl.innerHTML = '';
    var others = users.filter((u) => u.username !== currentUsername);
    emptyStateEl.hidden = others.length > 0;

    users.forEach((u) => {
      var isSelf = u.username === currentUsername;
      var tr = document.createElement('tr');
      tr.setAttribute('data-username', u.username);
      tr.innerHTML =
        '<td data-label="Username">' +
        escapeHTML(u.username) +
        (u.isAdmin ? ' <span class="admin-badge">Admin</span>' : '') +
        '</td>' +
        '<td data-label="Display name">' +
        escapeHTML(u.displayName) +
        '</td>' +
        '<td data-label="Registered">' +
        escapeHTML(formatDate(u.createdAt)) +
        '</td>' +
        '<td class="row-actions" data-label="Actions">' +
        '<button class="btn" type="button" data-action="revoke" data-username="' +
        escapeHTML(u.username) +
        '"' +
        (isSelf ? ' disabled' : '') +
        '>Revoke</button>' +
        '<button class="btn btn-danger" type="button" data-action="remove" data-username="' +
        escapeHTML(u.username) +
        '"' +
        (isSelf ? ' disabled' : '') +
        '>Remove</button>' +
        '</td>';
      rowsEl.appendChild(tr);
    });
  }

  function loadUsers() {
    return fetch('/api/admin/users', {
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return null;
        }
        if (res.status === 403) {
          window.location.href = '/';
          return null;
        }
        return res.ok
          ? res.json()
          : Promise.reject(new Error(`could not load users (${res.status})`));
      })
      .then((users) => {
        if (users) renderUsers(users);
      });
  }

  fetch('/api/auth/session', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((session) => {
      if (session) currentUsername = session.username;
      return loadUsers();
    })
    .catch((err) => {
      setStatus(err.message || 'Could not load users.', 'error');
    });

  rowsEl.addEventListener('click', (e) => {
    var button = e.target.closest('button[data-action]');
    if (!button) return;

    var username = button.getAttribute('data-username');
    var action = button.getAttribute('data-action');

    if (
      action === 'remove' &&
      !window.confirm(
        'Remove ' +
          username +
          ' outright? This deletes their account, passkeys and saved forge credentials — irreversible.',
      )
    ) {
      return;
    }
    if (
      action === 'revoke' &&
      !window.confirm(
        'Revoke ' +
          username +
          '’s passkeys and sessions? They’ll be signed out everywhere and have to register again.',
      )
    ) {
      return;
    }

    button.disabled = true;
    setStatus(action === 'remove' ? 'Removing…' : 'Revoking…');

    var request =
      action === 'remove'
        ? fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
            method: 'DELETE',
          })
        : fetch(`/api/admin/users/${encodeURIComponent(username)}/revoke`, {
            method: 'POST',
          });

    request
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return;
        }
        if (!res.ok) {
          return res.json().then((data) => {
            throw new Error(data.error || 'action failed');
          });
        }
        setStatus(
          action === 'remove' ? `${username} removed.` : `${username} revoked.`,
          'ok',
        );
        return loadUsers();
      })
      .catch((err) => {
        setStatus(err.message || 'Action failed.', 'error');
      });
  });
})();
