(function () {
  'use strict';

  var REFRESH_INTERVAL_MS = 30000;
  var CI_LABELS = { success: 'Passing', failure: 'Failing', pending: 'Running', none: 'No checks' };
  var FORGE_LABELS = { github: 'GitHub', forgejo: 'Forgejo' };
  var FORGE_CLASSES = { github: 'gh', forgejo: 'fj' };

  var lastGeneratedAt = null;

  // ---- theme toggle ----
  (function initTheme() {
    var root = document.documentElement;
    var toggle = document.getElementById('theme-toggle');
    var STORAGE_KEY = 'forge-board-theme';

    function systemPrefersDark() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function applyTheme(theme) {
      if (theme === 'dark' || theme === 'light') {
        root.setAttribute('data-theme', theme);
      } else {
        root.removeAttribute('data-theme');
      }
      var isDark = theme === 'dark' || (theme !== 'light' && systemPrefersDark());
      toggle.setAttribute('aria-pressed', String(isDark));
      toggle.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
    }

    var stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) { /* private browsing, etc. */ }
    applyTheme(stored);

    toggle.addEventListener('click', function () {
      var currentlyDark = root.getAttribute('data-theme') === 'dark' ||
        (!root.getAttribute('data-theme') && systemPrefersDark());
      var next = currentlyDark ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
    });
  })();

  // ---- formatting ----
  function minutesAgo(iso) {
    return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  }

  function relativeTime(iso) {
    var mins = minutesAgo(iso);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.round(hours / 24);
    return days + 'd ago';
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---- row rendering ----
  function repoCell(item) {
    var wrap = el('div', 'repo');
    var badge = el('span', 'forge-badge ' + FORGE_CLASSES[item.forge]);
    badge.appendChild(el('span', 'dot'));
    badge.appendChild(document.createTextNode(FORGE_LABELS[item.forge] || item.forge));
    wrap.appendChild(badge);
    wrap.appendChild(el('span', 'repo-name', item.repo));
    return wrap;
  }

  function titleCell(item) {
    var wrap = el('div', 'title-cell');
    var title = el('div', 'title');
    title.appendChild(el('span', 'num', '#' + item.number));
    title.appendChild(document.createTextNode(item.title));
    wrap.appendChild(title);
    if (item.draft) wrap.appendChild(el('span', 'draft-badge', 'Draft'));
    (item.labels || []).slice(0, 3).forEach(function (label) {
      wrap.appendChild(el('span', 'label-chip', label));
    });
    return wrap;
  }

  function ciPill(status) {
    var pill = el('div', 'ci-pill ' + status);
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(document.createTextNode(CI_LABELS[status] || status));
    return pill;
  }

  function buildRow(item, isPR) {
    var row = document.createElement('a');
    row.className = 'row';
    row.href = item.url;
    row.target = '_blank';
    row.rel = 'noopener noreferrer';
    row.dataset.repo = (item.forge + ' ' + item.repo).toLowerCase();
    row.dataset.title = item.title.toLowerCase();
    row.dataset.author = (item.author || '').toLowerCase();
    row.dataset.createdMin = String(minutesAgo(item.createdAt));
    row.dataset.updatedMin = String(minutesAgo(item.updatedAt));
    if (isPR) row.dataset.status = item.ci;

    row.appendChild(repoCell(item));
    row.appendChild(titleCell(item));

    var meta = el('div', 'row-meta');
    meta.appendChild(el('div', 'author', item.author));
    meta.appendChild(el('div', 'created', relativeTime(item.createdAt)));
    meta.appendChild(el('div', 'updated', relativeTime(item.updatedAt)));
    if (isPR) {
      meta.appendChild(ciPill(item.ci));
    } else {
      meta.appendChild(el('div', 'empty-cell'));
    }
    row.appendChild(meta);
    row.appendChild(el('div', 'go', '→'));
    return row;
  }

  function renderRows(containerId, items, isPR, emptyId) {
    var container = document.getElementById(containerId);
    container.innerHTML = '';
    document.getElementById(emptyId).hidden = items.length !== 0;
    items.forEach(function (item) {
      container.appendChild(buildRow(item, isPR));
    });
    applyFilters(container.closest('section.board'));
  }

  // ---- per-column filtering ----
  function applyFilters(board) {
    if (!board) return;
    var controls = board.querySelectorAll('.col-filter');
    var rows = board.querySelectorAll('#pr-rows > .row, #issue-rows > .row');
    var noResults = board.querySelector('.no-results');
    var f = {};
    controls.forEach(function (c) { f[c.dataset.col] = c.value.trim().toLowerCase(); });

    var visible = 0;
    rows.forEach(function (row) {
      var ok = true;
      if (f.repo && (row.dataset.repo || '').indexOf(f.repo) === -1) ok = false;
      if (f.title && (row.dataset.title || '').indexOf(f.title) === -1) ok = false;
      if (f.author && (row.dataset.author || '').indexOf(f.author) === -1) ok = false;
      if (f.created && Number(row.dataset.createdMin) > Number(f.created)) ok = false;
      if (f.updated && Number(row.dataset.updatedMin) > Number(f.updated)) ok = false;
      if (f.status && row.dataset.status !== f.status) ok = false;
      row.style.display = ok ? '' : 'none';
      if (ok) visible += 1;
    });
    if (noResults) noResults.hidden = visible !== 0 || rows.length === 0;
  }

  document.querySelectorAll('section.board').forEach(function (board) {
    board.querySelectorAll('.col-filter').forEach(function (c) {
      c.addEventListener('input', function () { applyFilters(board); });
      c.addEventListener('change', function () { applyFilters(board); });
    });
  });

  // ---- forge health ----
  function renderForgeHealth(forges) {
    var container = document.getElementById('forge-health');
    container.innerHTML = '';
    forges.forEach(function (f) {
      var chip = el('span', 'forge-health' + (f.reachable ? '' : ' unreachable'));
      chip.appendChild(el('span', 'pulse-dot'));
      var label = (FORGE_LABELS[f.forge] || f.forge) + (f.reachable ? ' reachable' : ' unreachable');
      chip.appendChild(document.createTextNode(label));
      if (!f.reachable && f.error) chip.title = f.error;
      container.appendChild(chip);
    });
    document.getElementById('forge-names').innerHTML =
      forges.map(function (f) { return '<span class="mono">' + (FORGE_LABELS[f.forge] || f.forge) + '</span>'; }).join(' + ');
  }

  // ---- ticking "refreshed Xs ago" clock, independent of the poll interval ----
  function tickRefreshedAt() {
    var target = document.getElementById('refreshed-at');
    if (!lastGeneratedAt) return;
    target.textContent = relativeTime(lastGeneratedAt);
  }
  setInterval(tickRefreshedAt, 1000);

  function showError(message) {
    var existing = document.getElementById('error-banner');
    if (existing) existing.remove();
    var banner = el('div', 'error-banner', message);
    banner.id = 'error-banner';
    document.querySelector('.wrap').insertBefore(banner, document.querySelector('.stats'));
  }

  function clearError() {
    var existing = document.getElementById('error-banner');
    if (existing) existing.remove();
  }

  // ---- who's signed in, and signing out ----
  fetch('/api/auth/session', { headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (res.status === 401) {
        window.location.href = '/login.html';
        return null;
      }
      return res.ok ? res.json() : null;
    })
    .then(function (session) {
      if (session) document.getElementById('whoami').textContent = session.displayName;
    })
    .catch(function () { /* a transient failure here isn't worth blocking the page over */ });

  document.getElementById('logout-button').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).finally(function () {
      window.location.href = '/login.html';
    });
  });

  // ---- main fetch/render loop ----
  function refresh() {
    fetch('/api/dashboard', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = '/login.html';
          throw new Error('session expired');
        }
        if (!res.ok) throw new Error('backend answered ' + res.status);
        return res.json();
      })
      .then(function (data) {
        clearError();
        lastGeneratedAt = data.generatedAt;
        tickRefreshedAt();

        renderForgeHealth(data.forges || []);

        var prs = data.pullRequests || [];
        var issues = data.issues || [];
        renderRows('pr-rows', prs, true, 'pr-empty');
        renderRows('issue-rows', issues, false, 'issue-empty');

        document.getElementById('stat-prs').textContent = String(prs.length);
        document.getElementById('stat-issues').textContent = String(issues.length);
        document.getElementById('stat-failing').textContent = String(prs.filter(function (p) { return p.ci === 'failure'; }).length);
        document.getElementById('stat-repos').textContent = String(
          (data.forges || []).reduce(function (sum, f) { return sum + (f.repoCount || 0); }, 0)
        );
        document.getElementById('pr-count').textContent = prs.length + ' open';
        document.getElementById('issue-count').textContent = issues.length + ' open';
      })
      .catch(function (err) {
        showError('Could not reach the backend: ' + err.message);
      });
  }

  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
})();
