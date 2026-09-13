(function () {
  'use strict';

  var statusEl = document.getElementById('status');
  var rowsEl = document.getElementById('user-rows');
  var emptyStateEl = document.getElementById('empty-state');
  var currentUsername = null;

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function escapeHTML(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function formatDate(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  }

  function renderUsers(users) {
    rowsEl.innerHTML = '';
    var others = users.filter(function (u) { return u.username !== currentUsername; });
    emptyStateEl.hidden = others.length > 0;

    users.forEach(function (u) {
      var isSelf = u.username === currentUsername;
      var tr = document.createElement('tr');
      tr.setAttribute('data-username', u.username);
      tr.innerHTML =
        '<td>' + escapeHTML(u.username) + (u.isAdmin ? ' <span class="admin-badge">Admin</span>' : '') + '</td>' +
        '<td>' + escapeHTML(u.displayName) + '</td>' +
        '<td>' + escapeHTML(formatDate(u.createdAt)) + '</td>' +
        '<td class="row-actions">' +
        '<button class="btn" type="button" data-action="revoke" data-username="' + escapeHTML(u.username) + '"' + (isSelf ? ' disabled' : '') + '>Revoke</button>' +
        '<button class="btn btn-danger" type="button" data-action="remove" data-username="' + escapeHTML(u.username) + '"' + (isSelf ? ' disabled' : '') + '>Remove</button>' +
        '</td>';
      rowsEl.appendChild(tr);
    });
  }

  function loadUsers() {
    return fetch('/api/admin/users', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return null;
        }
        if (res.status === 403) {
          window.location.href = '/';
          return null;
        }
        return res.ok ? res.json() : Promise.reject(new Error('could not load users (' + res.status + ')'));
      })
      .then(function (users) {
        if (users) renderUsers(users);
      });
  }

  fetch('/api/auth/session', { headers: { Accept: 'application/json' } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (session) {
      if (session) currentUsername = session.username;
      return loadUsers();
    })
    .catch(function (err) {
      setStatus(err.message || 'Could not load users.', 'error');
    });

  rowsEl.addEventListener('click', function (e) {
    var button = e.target.closest('button[data-action]');
    if (!button) return;

    var username = button.getAttribute('data-username');
    var action = button.getAttribute('data-action');

    if (action === 'remove' && !window.confirm('Remove ' + username + ' outright? This deletes their account, passkeys and saved forge credentials — irreversible.')) {
      return;
    }
    if (action === 'revoke' && !window.confirm('Revoke ' + username + '’s passkeys and sessions? They’ll be signed out everywhere and have to register again.')) {
      return;
    }

    button.disabled = true;
    setStatus(action === 'remove' ? 'Removing…' : 'Revoking…');

    var request = action === 'remove'
      ? fetch('/api/admin/users/' + encodeURIComponent(username), { method: 'DELETE' })
      : fetch('/api/admin/users/' + encodeURIComponent(username) + '/revoke', { method: 'POST' });

    request
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/login.html';
          return;
        }
        if (!res.ok) {
          return res.json().then(function (data) { throw new Error(data.error || 'action failed'); });
        }
        setStatus(action === 'remove' ? username + ' removed.' : username + ' revoked.', 'ok');
        return loadUsers();
      })
      .catch(function (err) {
        setStatus(err.message || 'Action failed.', 'error');
      });
  });
})();
