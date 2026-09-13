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

  // A real button — see the comment above ciPill on why the row isn't an
  // <a> around everything.
  function labelChip(label, onLabelClick, activeLabel) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'label-chip' + (label === activeLabel ? ' active' : '');
    chip.textContent = label;
    chip.setAttribute('aria-label', 'Filter by label: ' + label);
    chip.setAttribute('aria-pressed', String(label === activeLabel));
    chip.addEventListener('click', function () { onLabelClick(label); });
    return chip;
  }

  function titleCell(item, onLabelClick, activeLabel) {
    var wrap = el('div', 'title-cell');
    // The real, keyboard-focusable link — a "stretched link" (see
    // .title-cell .title::after in style.css) makes the whole row
    // clickable, without the row itself being an <a> that would make the
    // CI pill and label chips invalid/inaccessible nested interactive
    // elements. https://css-tricks.com/block-links-the-search-for-a-perfect-solution/
    var title = document.createElement('a');
    title.className = 'title';
    title.href = item.url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    // The ellipsis truncation lives on this inner span, not .title itself
    // — overflow:hidden on .title would clip its own ::after stretched
    // overlay down to .title's box instead of letting it cover the whole
    // row (see the comment on .title in style.css).
    var text = el('span', 'title-text');
    text.appendChild(el('span', 'num', '#' + item.number));
    text.appendChild(document.createTextNode(item.title));
    title.appendChild(text);
    wrap.appendChild(title);
    if (item.draft) wrap.appendChild(el('span', 'draft-badge', 'Draft'));
    (item.labels || []).slice(0, 3).forEach(function (label) {
      wrap.appendChild(labelChip(label, onLabelClick, activeLabel));
    });
    return wrap;
  }

  // status is a real button — see titleCell's comment on why the row
  // isn't an <a> around everything. onStatusClick is only ever passed for
  // the pull requests board (isPR).
  function ciPill(status, onStatusClick) {
    var pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'ci-pill ' + status;
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(document.createTextNode(CI_LABELS[status] || status));
    pill.setAttribute('aria-label', 'Filter pull requests by CI status: ' + (CI_LABELS[status] || status));
    pill.addEventListener('click', function () { onStatusClick(status); });
    return pill;
  }

  function buildRow(item, isPR, onStatusClick, onLabelClick, activeLabel) {
    var row = el('div', 'row');

    row.appendChild(repoCell(item));
    row.appendChild(titleCell(item, onLabelClick, activeLabel));

    var meta = el('div', 'row-meta');
    meta.appendChild(el('div', 'author', item.author));
    meta.appendChild(el('div', 'created', relativeTime(item.createdAt)));
    meta.appendChild(el('div', 'updated', relativeTime(item.updatedAt)));
    if (isPR) {
      meta.appendChild(ciPill(item.ci, onStatusClick));
    } else {
      meta.appendChild(el('div', 'empty-cell'));
    }
    row.appendChild(meta);
    row.appendChild(el('div', 'go', '→'));
    return row;
  }

  // ---- board state + render ----
  // Each board (pull requests, issues) owns one state object — the raw
  // items last fetched, the active per-column filters, and placeholders
  // for grouping/pagination so those features have a state shape to slot
  // into instead of bolting another special case onto row-hiding, which
  // is what this replaces (see issue #36).
  function matchesFilters(item, isPR, filters) {
    var repoKey = (item.forge + ' ' + item.repo).toLowerCase();
    if (filters.repo && repoKey.indexOf(filters.repo) === -1) return false;
    if (filters.title && item.title.toLowerCase().indexOf(filters.title) === -1) return false;
    if (filters.author && (item.author || '').toLowerCase().indexOf(filters.author) === -1) return false;
    if (filters.created && minutesAgo(item.createdAt) > Number(filters.created)) return false;
    if (filters.updated && minutesAgo(item.updatedAt) > Number(filters.updated)) return false;
    if (filters.status && isPR && item.ci !== filters.status) return false;
    if (filters.label && (item.labels || []).indexOf(filters.label) === -1) return false;
    return true;
  }

  function createBoard(containerId, emptyId, noResultsId, isPR, onStatusClick) {
    var state = {
      items: [],
      filters: {},
      groupBy: null, // no grouping feature yet (issue #38) — reserved
      page: 1, // no pagination feature yet (issue #37) — reserved
      pageSize: Infinity,
    };

    // Sets col to value, unless it's already value — then clears it. Used
    // by a click on something that represents one specific value (a CI
    // pill, a label chip, the "CI failing" stat tile) rather than the
    // free-choice dropdown, where a second click meaning "never mind" is
    // the expected behavior. Returns the filter's new value so a caller
    // can sync a visible control (the status <select>) to match.
    function toggleFilter(col, value) {
      var next = state.filters[col] === value ? '' : value;
      state.filters[col] = next;
      state.page = 1;
      render();
      return next;
    }

    // Each board filters its own labels independently — a click here
    // never touches the other board's state.
    function handleLabelClick(label) {
      toggleFilter('label', label);
    }

    function render() {
      var container = document.getElementById(containerId);
      var visible = state.items.filter(function (item) {
        return matchesFilters(item, isPR, state.filters);
      });

      container.innerHTML = '';
      visible.forEach(function (item) {
        container.appendChild(buildRow(item, isPR, onStatusClick, handleLabelClick, state.filters.label));
      });

      document.getElementById(emptyId).hidden = state.items.length !== 0;
      var noResults = document.getElementById(noResultsId);
      if (noResults) noResults.hidden = visible.length !== 0 || state.items.length === 0;
    }

    return {
      setItems: function (items) {
        state.items = items;
        state.page = 1;
        render();
      },
      setFilter: function (col, value) {
        state.filters[col] = value;
        state.page = 1;
        render();
      },
      toggleFilter: toggleFilter,
    };
  }

  // Clicking a CI pill or the "CI failing" stat tile jumps to the pull
  // requests board filtered to that status — declared before prBoard is
  // assigned below since it's only ever called later, after a user click,
  // by which point prBoard exists (function declarations hoist, so this
  // is safe to reference here).
  function handleStatusClick(status) {
    var next = prBoard.toggleFilter('status', status);
    var select = document.querySelector('section[aria-label="Open pull requests"] .col-filter[data-col="status"]');
    if (select) select.value = next;
    var section = document.querySelector('section[aria-label="Open pull requests"]');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  var prBoard = createBoard('pr-rows', 'pr-empty', 'pr-no-results', true, handleStatusClick);
  var issueBoard = createBoard('issue-rows', 'issue-empty', 'issue-no-results', false);

  var statFailingTile = document.getElementById('stat-failing-tile');
  if (statFailingTile) statFailingTile.addEventListener('click', function () { handleStatusClick('failure'); });

  document.querySelectorAll('section.board').forEach(function (board) {
    var target = board.querySelector('#issue-rows') ? issueBoard : prBoard;
    board.querySelectorAll('.col-filter').forEach(function (c) {
      var apply = function () { target.setFilter(c.dataset.col, c.value.trim().toLowerCase()); };
      c.addEventListener('input', apply);
      c.addEventListener('change', apply);
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
      if (!session) return;
      document.getElementById('whoami').textContent = session.displayName;
      document.getElementById('admin-link').hidden = !session.isAdmin;
    })
    .catch(function () { /* a transient failure here isn't worth blocking the page over */ });

  document.getElementById('logout-button').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' }).finally(function () {
      window.location.href = '/login.html';
    });
  });

  // ---- switching to a dashboard someone else shared with you ----
  var currentOwner = '';
  var ownerSelect = document.getElementById('dashboard-owner-select');

  fetch('/api/sharing', { headers: { Accept: 'application/json' } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.sharedWithMe || data.sharedWithMe.length === 0) return;
      data.sharedWithMe.forEach(function (u) {
        var option = document.createElement('option');
        option.value = u.username;
        option.textContent = u.displayName + "’s dashboard";
        ownerSelect.appendChild(option);
      });
      ownerSelect.hidden = false;
    })
    .catch(function () { /* a transient failure here isn't worth blocking the page over */ });

  ownerSelect.addEventListener('change', function () {
    currentOwner = ownerSelect.value;
    refresh();
  });

  // ---- main fetch/render loop ----
  function refresh() {
    var url = '/api/dashboard' + (currentOwner ? '?owner=' + encodeURIComponent(currentOwner) : '');
    fetch(url, { headers: { Accept: 'application/json' } })
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
        prBoard.setItems(prs);
        issueBoard.setItems(issues);

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
