(() => {
  // Same labels app.js's own FORGE_LABELS uses.
  var FORGE_LABELS = { github: 'GitHub', forgejo: 'Forgejo' };
  var DEPENDENCY_DASHBOARD_TITLE = 'Dependency Dashboard';

  // ---- cookies — same shape app.js's own persisted filters use, not a
  // separate preference store. There's no module system to share code
  // through (the same reason theme.js duplicates app.js's cookie
  // helpers instead of importing them), but the *cookie itself* is
  // shared: filtering to a repo here or on the main dashboard is one
  // choice, not two independent ones. ----
  var FILTERS_COOKIE = 'forge-board-filters';

  function getCookie(name) {
    var match = document.cookie.match(
      new RegExp(
        `(?:^|; )${name.replace(/[-.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`,
      ),
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value) {
    var maxAgeSeconds = 365 * 24 * 60 * 60;
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API isn't in Safari yet, and this repo targets more than just Chromium (browser-compat.md).
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
  }

  function loadAllPersistedFilters() {
    var raw = getCookie(FILTERS_COOKIE);
    var parsed;
    if (!raw) return {};
    try {
      parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_e) {
      return {};
    }
  }

  function loadPersistedFilters(cookieKey) {
    return loadAllPersistedFilters()[cookieKey] || {};
  }

  function savePersistedFilters(cookieKey, filters) {
    var all = loadAllPersistedFilters();
    all[cookieKey] = filters;
    try {
      setCookie(FILTERS_COOKIE, JSON.stringify(all));
    } catch (_e) {
      /* ignore */
    }
  }

  // Same checks app.js's own matchesFilters runs. created/updated/status
  // are never actually set from this page (see PR_FILTER_COLS/
  // ISSUE_FILTER_COLS below), so those branches are dead weight here
  // rather than a risk — kept for the one piece that does matter:
  // hideDependencyDashboard, gated on !isPR the same way app.js gates it.
  function matchesFilters(item, isPR, filters) {
    var repoKey = `${item.forge}:${item.repo}`.toLowerCase();
    if (filters.forge && item.forge !== filters.forge) return false;
    if (filters.repo && repoKey !== filters.repo) return false;
    if (filters.title && item.title.toLowerCase().indexOf(filters.title) === -1)
      return false;
    if (
      filters.author &&
      (item.author || '').toLowerCase().indexOf(filters.author) === -1
    )
      return false;
    if (
      filters.label &&
      !(item.labels || []).some((l) => l.name.toLowerCase() === filters.label)
    )
      return false;
    if (
      !isPR &&
      filters.hideDependencyDashboard &&
      item.title.trim() === DEPENDENCY_DASHBOARD_TITLE
    )
      return false;
    return true;
  }

  // getEntry(item) -> {value, label} | {value, label}[] | null. Options
  // are deduped by value and sorted by label — the reverse of app.js's
  // populateRepoSelect, which sorts by value inside per-forge optgroups;
  // this page skips the optgroup split (same repo name on both forges is
  // rare enough not to earn that complexity here) so a plain label sort
  // is what actually reads right.
  function distinctOptions(getEntry, items) {
    var seen = {};
    var options = [];
    items.forEach((item) => {
      var entries = getEntry(item);
      (Array.isArray(entries) ? entries : [entries]).forEach((e) => {
        if (e?.value && !seen[e.value]) {
          seen[e.value] = true;
          options.push(e);
        }
      });
    });
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }

  // Restores desiredValue (the filter's own tracked value, not
  // select.value — this runs before the fetch that gives the select
  // anything to match against, so select.value is never the source of
  // truth here) if it's still among the new options; otherwise clears
  // the select and reports back that the underlying filter needs
  // clearing too, so a stale selection never keeps silently filtering
  // out everything (the same trap app.js's own populateSelect avoids).
  function populateSelect(select, options, desiredValue) {
    if (!select) return false;
    while (select.options.length > 1) select.remove(1);
    var stillPresent = false;
    options.forEach((opt) => {
      var el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      if (opt.value === desiredValue) stillPresent = true;
      select.appendChild(el);
    });
    if (stillPresent) {
      select.value = desiredValue;
      return false;
    }
    select.value = '';
    return Boolean(desiredValue);
  }

  // One scope per entity type (pr/issue), each owning its own masked
  // filter state and its own row of controls — mirrors the main
  // dashboard's two independent boards rather than one universal filter
  // bar, since pull requests and issues are different columns. Masked to
  // allowedCols so a status/created/updated filter left over in the
  // cookie from the main dashboard's own board never silently applies to
  // a chart here built to show exactly that dimension (CI status,
  // either age histogram).
  function createFilterScope(
    cookieKey,
    allowedCols,
    isPR,
    containerSelector,
    onChange,
    defaultFilters,
  ) {
    var container = document.querySelector(containerSelector);
    // Object.assign, not a truthy-only copy: an explicit "" (the user
    // unchecked Hide Dependency Dashboard) has to win over the default
    // just as much as a real value does — a truthy check would let the
    // default silently reassert itself over that explicit "off".
    var merged = Object.assign(
      {},
      defaultFilters,
      loadPersistedFilters(cookieKey),
    );
    var filters = {};
    var hideCheckbox;
    allowedCols.forEach((col) => {
      if (Object.hasOwn(merged, col)) filters[col] = merged[col];
    });

    // Always assigns, never deletes — matching app.js's own setFilter.
    // hideDependencyDashboard needs "" to persist as a real, explicit
    // override rather than vanish back to unset, or the default merge
    // above would silently reassert itself on the next load: unset means
    // "apply the default," "" means "the default was turned off," and
    // deleting the key on clear would erase that distinction.
    function setFilter(col, value) {
      filters[col] = value;
      var full = loadPersistedFilters(cookieKey);
      full[col] = value;
      savePersistedFilters(cookieKey, full);
      onChange();
    }

    if (container) {
      container.querySelectorAll('.col-filter').forEach((control) => {
        var col = control.dataset.col;
        if (allowedCols.indexOf(col) === -1) return;
        // Selects get their value from the first updateOptions call
        // (see populateSelect above) — only the plain text input has no
        // dynamic options to wait for.
        if (control.tagName !== 'SELECT' && filters[col]) {
          control.value = filters[col];
        }
        var apply = () => setFilter(col, control.value.trim().toLowerCase());
        control.addEventListener('input', apply);
        control.addEventListener('change', apply);
      });

      hideCheckbox = container.querySelector(
        '[data-col="hideDependencyDashboard"]',
      );
      if (hideCheckbox) {
        hideCheckbox.checked = filters.hideDependencyDashboard !== '';
        hideCheckbox.addEventListener('change', () => {
          setFilter('hideDependencyDashboard', hideCheckbox.checked ? '1' : '');
        });
      }
    }

    return {
      matches: (item) => matchesFilters(item, isPR, filters),
      updateOptions: (items) => {
        if (!container) return;
        var repoSelect = container.querySelector('[data-col="repo"]');
        if (
          populateSelect(
            repoSelect,
            distinctOptions(
              (i) => ({
                value: `${i.forge}:${i.repo}`.toLowerCase(),
                label: i.repo,
              }),
              items,
            ),
            filters.repo,
          )
        ) {
          setFilter('repo', '');
        }

        var authorSelect = container.querySelector('[data-col="author"]');
        if (
          populateSelect(
            authorSelect,
            distinctOptions(
              (i) =>
                i.author
                  ? { value: i.author.toLowerCase(), label: i.author }
                  : null,
              items,
            ),
            filters.author,
          )
        ) {
          setFilter('author', '');
        }

        var labelSelect = container.querySelector('[data-col="label"]');
        if (
          populateSelect(
            labelSelect,
            distinctOptions(
              (i) =>
                (i.labels || []).map((l) => ({
                  value: l.name.toLowerCase(),
                  label: l.name,
                })),
              items,
            ),
            filters.label,
          )
        ) {
          setFilter('label', '');
        }
      },
    };
  }

  var PR_FILTER_COLS = ['forge', 'repo', 'title', 'author', 'label'];
  var ISSUE_FILTER_COLS = [
    'forge',
    'repo',
    'title',
    'author',
    'label',
    'hideDependencyDashboard',
  ];

  function renderCIStatus(pullRequests) {
    var chart = document.getElementById('ci-status-chart');
    var empty = document.getElementById('ci-status-empty');
    var table = document.getElementById('ci-status-table');
    var tbody = table.querySelector('tbody');

    // Same order and labels app.js's own CI_LABELS uses, so "Passing"
    // here means the same thing it means on the dashboard's own
    // CI-failing tile.
    var CI_STATES = [
      { key: 'success', label: 'Passing', className: 'ci-good' },
      { key: 'failure', label: 'Failing', className: 'ci-critical' },
      { key: 'pending', label: 'Running', className: 'ci-warning' },
      { key: 'none', label: 'No checks', className: 'ci-neutral' },
    ];

    if (pullRequests.length === 0) {
      chart.hidden = true;
      table.hidden = true;
      empty.hidden = false;
      return;
    }

    var counts = {};
    CI_STATES.forEach((state) => {
      counts[state.key] = 0;
    });
    pullRequests.forEach((p) => {
      if (Object.hasOwn(counts, p.ci)) counts[p.ci]++;
    });

    var total = pullRequests.length;
    chart.innerHTML = '';
    tbody.innerHTML = '';

    CI_STATES.forEach((state) => {
      var count = counts[state.key];
      var pct = total > 0 ? (count / total) * 100 : 0;

      var row = document.createElement('div');
      row.className = 'ci-bar-row';
      row.dataset.ciStatus = state.key;
      row.innerHTML = `
        <span class="ci-bar-label">${state.label}</span>
        <div class="ci-bar-track">
          <div class="ci-bar-fill ${state.className}" style="width: ${pct}%"></div>
        </div>
        <span class="ci-count">${count}</span>
      `;
      chart.appendChild(row);

      var tr = document.createElement('tr');
      tr.innerHTML = `<td>${state.label}</td><td class="num">${count}</td>`;
      tbody.appendChild(tr);
    });

    chart.hidden = false;
    table.hidden = false;
    empty.hidden = true;
  }

  var REPO_RANK_CAP = 10;

  // Ranked by count, single neutral hue — repo identity rides the label,
  // not a color, since a fixed categorical hue order doesn't scale past
  // a handful of repos.
  function renderRepoRanking(items, idPrefix) {
    var list = document.getElementById(`${idPrefix}-ranking`);
    var empty = document.getElementById(`${idPrefix}-ranking-empty`);
    var more = document.getElementById(`${idPrefix}-ranking-more`);

    var counts = {};
    items.forEach((item) => {
      counts[item.repo] = (counts[item.repo] || 0) + 1;
    });
    var ranked = Object.keys(counts)
      .map((repo) => ({ repo, count: counts[repo] }))
      .sort((a, b) => b.count - a.count);

    list.innerHTML = '';

    if (ranked.length === 0) {
      empty.hidden = false;
      more.hidden = true;
      return;
    }
    empty.hidden = true;

    var top = ranked.slice(0, REPO_RANK_CAP);
    var maxCount = top[0].count;

    top.forEach((entry) => {
      var pct = maxCount > 0 ? (entry.count / maxCount) * 100 : 0;
      var row = document.createElement('div');
      row.className = 'rank-row';
      row.innerHTML = `
        <span class="rank-label" title="${entry.repo}">${entry.repo}</span>
        <span class="rank-count">${entry.count}</span>
        <div class="rank-track"><div class="rank-fill" style="width: ${pct}%"></div></div>
      `;
      list.appendChild(row);
    });

    var remaining = ranked.length - top.length;
    if (remaining > 0) {
      more.textContent = `+${remaining} more`;
      more.hidden = false;
    } else {
      more.hidden = true;
    }
  }

  // Fixed age buckets, oldest-catch-all last so nothing older ever gets
  // dropped instead of counted.
  var AGE_BUCKETS = [
    { key: 'lt1', label: '<1 day', maxHours: 24 },
    { key: '1to3', label: '1-3 days', maxHours: 24 * 3 },
    { key: '3to7', label: '3-7 days', maxHours: 24 * 7 },
    { key: '7to30', label: '7-30 days', maxHours: 24 * 30 },
    { key: '30plus', label: '30+ days', maxHours: Infinity },
  ];

  function bucketForAge(hoursOld) {
    var bucket = AGE_BUCKETS.find((b) => hoursOld < b.maxHours);
    return bucket ? bucket.key : AGE_BUCKETS[AGE_BUCKETS.length - 1].key;
  }

  function renderAgeHistogram(items, idPrefix) {
    var chart = document.getElementById(`${idPrefix}-age-chart`);
    var empty = document.getElementById(`${idPrefix}-age-empty`);
    var table = document.getElementById(`${idPrefix}-age-table`);
    var tbody = table.querySelector('tbody');

    if (items.length === 0) {
      chart.hidden = true;
      table.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    var counts = {};
    AGE_BUCKETS.forEach((bucket) => {
      counts[bucket.key] = 0;
    });
    var now = Date.now();
    items.forEach((item) => {
      var hoursOld =
        (now - new Date(item.createdAt).getTime()) / (60 * 60 * 1000);
      counts[bucketForAge(hoursOld)]++;
    });

    var maxCount = Math.max(...AGE_BUCKETS.map((b) => counts[b.key]));
    chart.innerHTML = '';
    tbody.innerHTML = '';

    AGE_BUCKETS.forEach((bucket) => {
      var count = counts[bucket.key];
      var pct = maxCount > 0 ? (count / maxCount) * 100 : 0;

      var row = document.createElement('div');
      row.className = 'age-bar-row';
      row.dataset.ageBucket = bucket.key;
      row.innerHTML = `
        <span class="age-bar-label">${bucket.label}</span>
        <div class="age-bar-track">
          <div class="age-bar-fill" style="width: ${pct}%"></div>
        </div>
        <span class="age-count">${count}</span>
      `;
      chart.appendChild(row);

      var tr = document.createElement('tr');
      tr.innerHTML = `<td>${bucket.label}</td><td class="num">${count}</td>`;
      tbody.appendChild(tr);
    });

    chart.hidden = false;
    table.hidden = false;
  }

  // Status thresholds on remaining%, not forge identity — --gh/--fj
  // don't pass as chart-mark fills (see the CSS comment above this
  // card's rules), and "how healthy is the budget" is the actually
  // useful signal here.
  function rateLimitStatusClass(remaining, limit) {
    var pct = limit > 0 ? remaining / limit : 1;
    if (pct < 0.05) return 'rl-critical';
    if (pct < 0.2) return 'rl-warning';
    return 'rl-good';
  }

  function renderRateLimits(forges) {
    var list = document.getElementById('rate-limit-list');
    list.innerHTML = '';

    forges.forEach((f) => {
      var row = document.createElement('div');
      row.className = 'rate-limit-row';
      row.dataset.forge = f.forge;
      var label = FORGE_LABELS[f.forge] || f.forge;

      if (!f.rateLimit) {
        row.innerHTML = `
          <div class="rate-limit-head">
            <span class="rate-limit-forge">${label}</span>
          </div>
          <p class="rate-limit-note">Not reported by this forge.</p>
        `;
        list.appendChild(row);
        return;
      }

      var rl = f.rateLimit;
      var pct = rl.limit > 0 ? (rl.remaining / rl.limit) * 100 : 0;
      var statusClass = rateLimitStatusClass(rl.remaining, rl.limit);
      var resetTime = new Date(rl.resetsAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });

      row.innerHTML = `
        <div class="rate-limit-head">
          <span class="rate-limit-forge">${label}</span>
          <span class="rate-limit-count">${rl.remaining.toLocaleString()} / ${rl.limit.toLocaleString()} requests</span>
        </div>
        <div class="rate-limit-bar">
          <div class="rate-limit-fill ${statusClass}" style="width: ${pct}%"></div>
        </div>
        <p class="rate-limit-reset">Resets ${resetTime}</p>
      `;
      list.appendChild(row);
    });
  }

  var lastSnapshot = { pullRequests: [], issues: [], forges: [] };

  function renderAll() {
    var prItems = lastSnapshot.pullRequests.filter(prScope.matches);
    var issueItems = lastSnapshot.issues.filter(issueScope.matches);

    renderCIStatus(prItems);
    renderRepoRanking(prItems, 'repo-pr');
    renderRepoRanking(issueItems, 'repo-issue');
    renderAgeHistogram(prItems, 'pr');
    renderAgeHistogram(issueItems, 'issue');
    renderRateLimits(lastSnapshot.forges);
  }

  // Every chart re-renders instantly from the already-fetched snapshot —
  // no refetch on a filter change, so there's no "hold the previous
  // render while reloading" case to handle.
  var prScope = createFilterScope(
    'pr',
    PR_FILTER_COLS,
    true,
    '[data-filter-scope="pr"]',
    renderAll,
  );
  var issueScope = createFilterScope(
    'issue',
    ISSUE_FILTER_COLS,
    false,
    '[data-filter-scope="issue"]',
    renderAll,
    { hideDependencyDashboard: '1' },
  );

  fetch('/api/dashboard', { headers: { Accept: 'application/json' } })
    .then((res) => {
      if (res.status === 401) {
        window.location.href = '/login.html';
        throw new Error('session expired');
      }
      if (!res.ok) throw new Error(`backend answered ${res.status}`);
      return res.json();
    })
    .then((data) => {
      lastSnapshot.pullRequests = data.pullRequests || [];
      lastSnapshot.issues = data.issues || [];
      lastSnapshot.forges = data.forges || [];
      prScope.updateOptions(lastSnapshot.pullRequests);
      issueScope.updateOptions(lastSnapshot.issues);
      renderAll();
    })
    .catch(() => {
      // A transient failure here just leaves the empty states showing —
      // the dashboard page itself is where a real error banner belongs.
    });
})();
