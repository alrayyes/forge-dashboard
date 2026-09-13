(() => {
  var REFRESH_INTERVAL_MS = 30000;
  var CI_LABELS = {
    success: 'Passing',
    failure: 'Failing',
    pending: 'Running',
    none: 'No checks',
  };
  var FORGE_LABELS = { github: 'GitHub', forgejo: 'Forgejo' };
  var FORGE_CLASSES = { github: 'gh', forgejo: 'fj' };

  var lastGeneratedAt = null;

  // ---- theme toggle ----
  (function initTheme() {
    var root = document.documentElement;
    var toggle = document.getElementById('theme-toggle');
    var STORAGE_KEY = 'forge-board-theme';

    function systemPrefersDark() {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    }

    function applyTheme(theme) {
      if (theme === 'dark' || theme === 'light') {
        root.setAttribute('data-theme', theme);
      } else {
        root.removeAttribute('data-theme');
      }
      var isDark =
        theme === 'dark' || (theme !== 'light' && systemPrefersDark());
      toggle.setAttribute('aria-pressed', String(isDark));
      toggle.setAttribute(
        'aria-label',
        isDark ? 'Switch to light theme' : 'Switch to dark theme',
      );
    }

    var stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch (_e) {
      /* private browsing, etc. */
    }
    applyTheme(stored);

    toggle.addEventListener('click', () => {
      var currentlyDark =
        root.getAttribute('data-theme') === 'dark' ||
        (!root.getAttribute('data-theme') && systemPrefersDark());
      var next = currentlyDark ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (_e) {
        /* ignore */
      }
    });
  })();

  // ---- formatting ----
  function minutesAgo(iso) {
    return Math.max(
      0,
      Math.round((Date.now() - new Date(iso).getTime()) / 60000),
    );
  }

  function relativeTime(iso) {
    var mins = minutesAgo(iso);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    var hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    var days = Math.round(hours / 24);
    return `${days}d ago`;
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
    var badge = el('span', `forge-badge ${FORGE_CLASSES[item.forge]}`);
    badge.appendChild(el('span', 'dot'));
    badge.appendChild(
      document.createTextNode(FORGE_LABELS[item.forge] || item.forge),
    );
    wrap.appendChild(badge);
    wrap.appendChild(el('span', 'repo-name', item.repo));
    return wrap;
  }

  // WCAG relative-luminance/contrast math (same formula this codebase's
  // own design tokens were hand-verified against) — picks whichever of
  // near-black/near-white ink actually reads against a label's real
  // background color, since that color is arbitrary and forge-supplied,
  // not one of our own palette's pre-checked pairs.
  function relativeLuminance(hex) {
    function channel(c) {
      c = c / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }
    var r = channel(parseInt(hex.substr(0, 2), 16));
    var g = channel(parseInt(hex.substr(2, 2), 16));
    var b = channel(parseInt(hex.substr(4, 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(l1, l2) {
    var lighter = Math.max(l1, l2);
    var darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function labelTextColor(bgHex) {
    // True black/white, not this app's own --ink/--ink-3 tokens — a
    // themed near-black measurably under-performs pure black against an
    // arbitrary background (caught live: GitHub's own default "bug" red,
    // #d73a4a, cleared 4.5:1 against pure black at 4.59:1 but only hit
    // 4.2:1 against this app's #0b0f14 — the decision math and the
    // applied color have to agree on which black they mean, or a label
    // can fail axe-core's contrast check despite this function "picking
    // the higher-contrast option").
    var bg = relativeLuminance(bgHex);
    var blackContrast = contrastRatio(bg, 0);
    var whiteContrast = contrastRatio(bg, 1);
    return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
  }

  // A real button — see the comment above ciPill on why the row isn't an
  // <a> around everything.
  function labelChip(label, onLabelClick, activeLabel) {
    var chip = document.createElement('button');
    chip.type = 'button';
    var isActive = label.name === activeLabel;
    chip.className = `label-chip${isActive ? ' active' : ''}`;
    chip.textContent = label.name;
    if (label.color && !isActive) {
      // The active state has its own fixed accent styling (see
      // .label-chip.active in style.css) — a per-label background would
      // fight with "this is the one currently filtering" as a signal.
      chip.style.backgroundColor = `#${label.color}`;
      chip.style.borderColor = `#${label.color}`;
      chip.style.color = labelTextColor(label.color);
    }
    chip.setAttribute('aria-label', `Filter by label: ${label.name}`);
    chip.setAttribute('aria-pressed', String(isActive));
    chip.addEventListener('click', () => {
      onLabelClick(label.name);
    });
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
    text.appendChild(el('span', 'num', `#${item.number}`));
    text.appendChild(document.createTextNode(item.title));
    title.appendChild(text);
    wrap.appendChild(title);
    if (item.draft) wrap.appendChild(el('span', 'draft-badge', 'Draft'));
    (item.labels || []).slice(0, 3).forEach((label) => {
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
    pill.className = `ci-pill ${status}`;
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(document.createTextNode(CI_LABELS[status] || status));
    pill.setAttribute(
      'aria-label',
      `Filter pull requests by CI status: ${CI_LABELS[status] || status}`,
    );
    pill.addEventListener('click', () => {
      onStatusClick(status);
    });
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
    var repoKey = `${item.forge} ${item.repo}`.toLowerCase();
    if (filters.forge && item.forge !== filters.forge) return false;
    if (filters.repo && repoKey.indexOf(filters.repo) === -1) return false;
    if (filters.title && item.title.toLowerCase().indexOf(filters.title) === -1)
      return false;
    if (
      filters.author &&
      (item.author || '').toLowerCase().indexOf(filters.author) === -1
    )
      return false;
    if (filters.created && minutesAgo(item.createdAt) > Number(filters.created))
      return false;
    if (filters.updated && minutesAgo(item.updatedAt) > Number(filters.updated))
      return false;
    if (filters.status && isPR && item.ci !== filters.status) return false;
    if (
      filters.label &&
      !(item.labels || []).some((l) => l.name === filters.label)
    )
      return false;
    return true;
  }

  function createBoard(
    containerId,
    emptyId,
    noResultsId,
    isPR,
    onStatusClick,
    idPrefix,
  ) {
    var state = {
      items: [],
      filters: {},
      groupBy: null,
      page: 1,
      pageSize: 25,
    };

    // Grouped by repo or by forge, alphabetically (forge by its display
    // label, not the raw "github"/"forgejo" value, since that's what a
    // screen reader announces), under a real heading (not a styled div)
    // so it's announced as structure, not decoration. Off by default —
    // this is a chosen mode, not a permanent change to how the flat list
    // already reads.
    function renderGrouped(container, items, groupBy) {
      var keyOf =
        groupBy === 'forge'
          ? (item) => FORGE_LABELS[item.forge] || item.forge
          : (item) => item.repo;

      var groups = {};
      var order = [];
      items.forEach((item) => {
        var key = keyOf(item);
        if (!groups[key]) {
          groups[key] = [];
          order.push(key);
        }
        groups[key].push(item);
      });
      order.sort();

      order.forEach((key) => {
        var heading = document.createElement('h3');
        heading.className = 'group-heading';
        heading.appendChild(document.createTextNode(key));
        heading.appendChild(
          el('span', 'group-count', String(groups[key].length)),
        );
        container.appendChild(heading);
        groups[key].forEach((item) => {
          container.appendChild(
            buildRow(
              item,
              isPR,
              onStatusClick,
              handleLabelClick,
              state.filters.label,
            ),
          );
        });
      });
    }

    // Distinct, sorted values of getValue(item) across the items currently
    // on screen — what both a filter <select>'s options and a filter
    // <input>'s <datalist> suggestions are populated from.
    function distinctValues(getValue) {
      var seen = {};
      var values = [];
      state.items.forEach((item) => {
        var v = getValue(item);
        if (v && !seen[v]) {
          seen[v] = true;
          values.push(v);
        }
      });
      values.sort();
      return values;
    }

    // Repo and author are a small, closed set of values actually on
    // screen at any moment — the same reasoning created/updated/status
    // are already plain <select>s for. The "all" placeholder is the
    // select's own first <option>, written once in the HTML rather than
    // rebuilt here; only the options after it get replaced. Can't just
    // clear+repopulate blindly either way, or a selection survives only
    // until the next item-set refresh (a poll, an SSE push, another
    // filter narrowing what's visible) silently resets it back to "all."
    function populateSelect(select, values) {
      if (!select) return;
      var previous = select.value;
      while (select.options.length > 1) select.remove(1);
      values.forEach((v) => {
        var option = document.createElement('option');
        option.value = v;
        option.textContent = v;
        select.appendChild(option);
      });
      if (values.indexOf(previous) !== -1) select.value = previous;
    }

    // Title is the one column that's genuinely open-ended free text —
    // the datalist only adds suggestions from what's on screen, it
    // doesn't restrict what can still be typed and substring-matched.
    function populateDatalist(datalist, values) {
      if (!datalist) return;
      datalist.innerHTML = '';
      values.forEach((v) => {
        var option = document.createElement('option');
        option.value = v;
        datalist.appendChild(option);
      });
    }

    function updateFilterOptions() {
      populateSelect(
        document.getElementById(`${idPrefix}-repo-select`),
        distinctValues((item) => item.repo),
      );
      populateSelect(
        document.getElementById(`${idPrefix}-author-select`),
        distinctValues((item) => item.author),
      );
      populateDatalist(
        document.getElementById(`${idPrefix}-title-options`),
        distinctValues((item) => item.title),
      );
    }

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

    function setPage(page) {
      state.page = page;
      render();
    }

    function renderPagination(totalPages) {
      var wrap = document.getElementById(`${idPrefix}-pagination`);
      if (!wrap) return;

      var needed = totalPages > 1;
      wrap.hidden = !needed;
      if (!needed) return;

      var pages = document.getElementById(`${idPrefix}-pagination-pages`);
      pages.innerHTML = '';

      var prev = el('button', 'pagination-nav', 'Previous');
      prev.type = 'button';
      prev.disabled = state.page <= 1;
      prev.addEventListener('click', () => {
        setPage(state.page - 1);
      });
      pages.appendChild(prev);

      var p;
      var button;
      for (p = 1; p <= totalPages; p++) {
        button = el('button', 'pagination-page', String(p));
        button.type = 'button';
        if (p === state.page) {
          button.classList.add('active');
          button.setAttribute('aria-current', 'page');
        }
        button.addEventListener(
          'click',
          ((page) => () => {
            setPage(page);
          })(p),
        );
        pages.appendChild(button);
      }

      var next = el('button', 'pagination-nav', 'Next');
      next.type = 'button';
      next.disabled = state.page >= totalPages;
      next.addEventListener('click', () => {
        setPage(state.page + 1);
      });
      pages.appendChild(next);
    }

    function render() {
      var container = document.getElementById(containerId);
      var visible = state.items.filter((item) =>
        matchesFilters(item, isPR, state.filters),
      );

      container.innerHTML = '';

      var groupedPagination;
      var totalPages;
      var start;
      var pageItems;
      if (state.groupBy) {
        // Grouping and pagination stay mutually exclusive — paginating
        // grouped clusters coherently is a bigger problem than either
        // feature's own acceptance criteria asked for, so grouped mode
        // just renders the whole filtered set and the pager hides.
        renderGrouped(container, visible, state.groupBy);
        groupedPagination = document.getElementById(`${idPrefix}-pagination`);
        if (groupedPagination) groupedPagination.hidden = true;
      } else {
        totalPages = Math.max(1, Math.ceil(visible.length / state.pageSize));
        if (state.page > totalPages) state.page = totalPages;
        start = (state.page - 1) * state.pageSize;
        pageItems = visible.slice(start, start + state.pageSize);
        pageItems.forEach((item) => {
          container.appendChild(
            buildRow(
              item,
              isPR,
              onStatusClick,
              handleLabelClick,
              state.filters.label,
            ),
          );
        });
        renderPagination(totalPages);
      }

      document.getElementById(emptyId).hidden = state.items.length !== 0;
      var noResults = document.getElementById(noResultsId);
      if (noResults)
        noResults.hidden = visible.length !== 0 || state.items.length === 0;
    }

    var pageSizeSelect = document.getElementById(`${idPrefix}-page-size`);
    if (pageSizeSelect) {
      pageSizeSelect.addEventListener('change', () => {
        state.pageSize = Number(pageSizeSelect.value) || 25;
        state.page = 1;
        render();
      });
    }

    var groupSelect = document.getElementById(`${idPrefix}-group-select`);
    if (groupSelect) {
      groupSelect.addEventListener('change', () => {
        state.groupBy = groupSelect.value || null;
        state.page = 1;
        render();
      });
    }

    return {
      setItems: (items) => {
        state.items = items;
        state.page = 1;
        updateFilterOptions();
        render();
      },
      setFilter: (col, value) => {
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
    var select = document.querySelector(
      'section[aria-label="Open pull requests"] .col-filter[data-col="status"]',
    );
    if (select) select.value = next;
    var section = document.querySelector(
      'section[aria-label="Open pull requests"]',
    );
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  var prBoard = createBoard(
    'pr-rows',
    'pr-empty',
    'pr-no-results',
    true,
    handleStatusClick,
    'pr',
  );
  var issueBoard = createBoard(
    'issue-rows',
    'issue-empty',
    'issue-no-results',
    false,
    undefined,
    'issue',
  );

  var statFailingTile = document.getElementById('stat-failing-tile');
  if (statFailingTile)
    statFailingTile.addEventListener('click', () => {
      handleStatusClick('failure');
    });

  document.querySelectorAll('section.board').forEach((board) => {
    var target = board.querySelector('#issue-rows') ? issueBoard : prBoard;
    board.querySelectorAll('.col-filter').forEach((c) => {
      var apply = () => {
        target.setFilter(c.dataset.col, c.value.trim().toLowerCase());
      };
      c.addEventListener('input', apply);
      c.addEventListener('change', apply);
    });
  });

  // ---- forge health ----
  function renderForgeHealth(forges) {
    var container = document.getElementById('forge-health');
    container.innerHTML = '';
    forges.forEach((f) => {
      var chip = el('span', `forge-health${f.reachable ? '' : ' unreachable'}`);
      chip.appendChild(el('span', 'pulse-dot'));
      var label =
        (FORGE_LABELS[f.forge] || f.forge) +
        (f.reachable ? ' reachable' : ' unreachable');
      chip.appendChild(document.createTextNode(label));
      if (!f.reachable && f.error) chip.title = f.error;
      container.appendChild(chip);
    });
    document.getElementById('forge-names').innerHTML = forges
      .map(
        (f) =>
          '<span class="mono">' +
          (FORGE_LABELS[f.forge] || f.forge) +
          '</span>',
      )
      .join(' + ');
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
    document
      .querySelector('.wrap')
      .insertBefore(banner, document.querySelector('.stats'));
  }

  function clearError() {
    var existing = document.getElementById('error-banner');
    if (existing) existing.remove();
  }

  // ---- who's signed in, and signing out ----
  fetch('/api/auth/session', { headers: { Accept: 'application/json' } })
    .then((res) => {
      if (res.status === 401) {
        window.location.href = '/login.html';
        return null;
      }
      return res.ok ? res.json() : null;
    })
    .then((session) => {
      if (!session) return;
      document.getElementById('whoami').textContent = session.displayName;
      document.getElementById('admin-link').hidden = !session.isAdmin;
    })
    .catch(() => {
      /* a transient failure here isn't worth blocking the page over */
    });

  document.getElementById('logout-button').addEventListener('click', () => {
    fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
      window.location.href = '/login.html';
    });
  });

  // ---- switching to a dashboard someone else shared with you ----
  var currentOwner = '';
  var ownerSelect = document.getElementById('dashboard-owner-select');

  fetch('/api/sharing', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data?.sharedWithMe || data.sharedWithMe.length === 0) return;
      data.sharedWithMe.forEach((u) => {
        var option = document.createElement('option');
        option.value = u.username;
        option.textContent = `${u.displayName}’s dashboard`;
        ownerSelect.appendChild(option);
      });
      ownerSelect.hidden = false;
    })
    .catch(() => {
      /* a transient failure here isn't worth blocking the page over */
    });

  ownerSelect.addEventListener('change', () => {
    currentOwner = ownerSelect.value;
    refresh();
  });

  // ---- main fetch/render loop ----
  function applySnapshot(data) {
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
    document.getElementById('stat-failing').textContent = String(
      prs.filter((p) => p.ci === 'failure').length,
    );
    document.getElementById('stat-repos').textContent = String(
      (data.forges || []).reduce((sum, f) => sum + (f.repoCount || 0), 0),
    );
    document.getElementById('pr-count').textContent = `${prs.length} open`;
    document.getElementById('issue-count').textContent =
      `${issues.length} open`;
  }

  function refresh() {
    var url =
      '/api/dashboard' +
      (currentOwner ? `?owner=${encodeURIComponent(currentOwner)}` : '');
    fetch(url, { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/login.html';
          throw new Error('session expired');
        }
        if (!res.ok) throw new Error(`backend answered ${res.status}`);
        return res.json();
      })
      .then(applySnapshot)
      .catch((err) => {
        showError(`Could not reach the backend: ${err.message}`);
      });
  }

  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);

  // ---- live updates over Server-Sent Events, on top of the poll above ----
  // The poll keeps running unconditionally — this only ever makes the
  // dashboard update sooner than the next one, never a replacement for
  // it. A browser or proxy that can't hold this connection open just
  // never benefits from it: EventSource retries on its own, and if it
  // never connects at all the poll still keeps the data fresh.
  var eventSource;
  if (window.EventSource) {
    eventSource = new EventSource('/api/dashboard/stream');
    eventSource.onmessage = (event) => {
      // Only when looking at your own dashboard — a push here is always
      // this session's own aggregator, never the owner currently
      // selected in the sharing dropdown.
      if (currentOwner) return;
      try {
        applySnapshot(JSON.parse(event.data));
      } catch (_e) {
        /* a malformed event here isn't worth surfacing over the working poll */
      }
    };
  }
})();
