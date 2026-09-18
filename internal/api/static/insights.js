(() => {
  var FORGE_LABELS = Filters.FORGE_LABELS;

  // ---- shared filter state — the same cookie/object app.js reads and
  // writes, not a separate preference store: filtering to a repo here or
  // on the main dashboard is one choice, not two independent ones. Only
  // sharedState.shared (forge/repo/label/author/title) and
  // sharedState.issue.hideDependencyDashboard apply here — created,
  // updated, and CI status are masked out below since each already has
  // its own chart on this page, and group-by never applied to Insights at
  // all (it's a row-layout choice with no equivalent for a chart). ----
  var sharedState = Filters.loadState();

  // Never lets created/updated leak into a chart just because the main
  // dashboard's own board has a value stored for them — see design.md's
  // "Insights keeps masking fields it doesn't display" decision.
  function chartFilters() {
    return Object.assign({}, sharedState.shared, { created: '', updated: '' });
  }

  var CI_STATES = [
    { key: 'success', label: 'Passing', className: 'ci-good' },
    { key: 'failure', label: 'Failing', className: 'ci-critical' },
    { key: 'pending', label: 'Running', className: 'ci-warning' },
    { key: 'none', label: 'No checks', className: 'ci-neutral' },
  ];

  function renderCIStatus(pullRequests) {
    var chart = document.getElementById('ci-status-chart');
    var empty = document.getElementById('ci-status-empty');
    var table = document.getElementById('ci-status-table');
    var tbody = table.querySelector('tbody');

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
  var sharedControlsRestored = false;

  // #353: the same cross-device reconciliation app.js's own copy of this
  // does — see its comment for the full reasoning. Insights and the main
  // dashboard share the one saved filter state, so this page has to pull
  // it too rather than only ever seeing whatever the cookie already has.
  Filters.loadStateFromServer().then((got) => {
    if (got) Filters.applyServerState(sharedState, got);
    if (sharedControlsRestored) {
      updateSharedFilterOptions();
      syncSharedControlsToState();
      renderAll();
    }
  });

  // Every chart re-renders instantly from the already-fetched snapshot —
  // no refetch on a filter change, so there's no "hold the previous
  // render while reloading" case to handle.
  function renderAll() {
    var filters = chartFilters();
    var prItems = lastSnapshot.pullRequests.filter((item) =>
      Filters.matchesFilters(item, true, filters, undefined),
    );
    var issueItems = lastSnapshot.issues.filter((item) =>
      Filters.matchesFilters(item, false, filters, sharedState.issue),
    );

    renderCIStatus(prItems);
    renderRepoRanking(prItems, 'repo-pr');
    renderRepoRanking(issueItems, 'repo-issue');
    renderAgeHistogram(prItems, 'pr');
    renderAgeHistogram(issueItems, 'issue');
    renderRateLimits(lastSnapshot.forges);
  }

  function forgeScopedItems() {
    var items = lastSnapshot.pullRequests.concat(lastSnapshot.issues);
    if (!sharedState.shared.forge) return items;
    return items.filter((item) => item.forge === sharedState.shared.forge);
  }

  function updateSharedFilterOptions() {
    var scoped = forgeScopedItems();
    var staleRepo = Filters.populateRepoSelect(
      document.getElementById('shared-repo-select'),
      scoped,
    );
    var staleAuthor = Filters.populateSelect(
      document.getElementById('shared-author-select'),
      Filters.distinctValues((item) => item.author, scoped),
      sharedState.shared.author,
    );
    Filters.populateDatalist(
      document.getElementById('shared-title-options'),
      Filters.distinctValues((item) => item.title, scoped),
    );
    var staleLabel = Filters.populateSelect(
      document.getElementById('shared-label-select'),
      Filters.distinctValues(
        (item) => (item.labels || []).map((l) => l.name),
        scoped,
      ),
      sharedState.shared.label,
    );
    if (staleRepo) sharedState.shared.repo = '';
    if (staleAuthor) sharedState.shared.author = '';
    if (staleLabel) sharedState.shared.label = '';
    if (staleRepo || staleAuthor || staleLabel) Filters.saveState(sharedState);
  }

  function syncSharedControlsToState() {
    var bar = document.querySelector('.filter-bar');
    if (!bar) return;
    bar.querySelectorAll('.col-filter').forEach((c) => {
      var value = sharedState.shared[c.dataset.col];
      var option;
      if (c.type === 'radio') {
        c.checked = c.value === (value || '');
        return;
      }
      if (!value) return;
      if (c.tagName === 'SELECT') {
        option = Array.from(c.options).find(
          (o) => o.value.toLowerCase() === value,
        );
        if (option) c.value = option.value;
      } else {
        c.value = value;
      }
    });
  }

  document.querySelectorAll('.filter-bar .col-filter').forEach((c) => {
    var apply = () => {
      var value = c.type === 'radio' ? c.value : c.value.trim().toLowerCase();
      sharedState.shared[c.dataset.col] = value;
      if (c.dataset.col === 'forge') updateSharedFilterOptions();
      Filters.saveState(sharedState, c.dataset.col);
      renderAll();
    };
    c.addEventListener('input', apply);
    c.addEventListener('change', apply);
  });

  // hideDependencyDashboard has no equivalent on the pull requests side,
  // so it's wired locally here rather than through the shared bar's
  // generic .col-filter loop above — the same reason app.js wires it
  // locally on the issues board instead.
  var hideDependencyDashboardCheckbox = document.getElementById(
    'issue-hide-dependency-dashboard',
  );
  if (hideDependencyDashboardCheckbox) {
    hideDependencyDashboardCheckbox.checked =
      sharedState.issue.hideDependencyDashboard === '1';
    hideDependencyDashboardCheckbox.addEventListener('change', () => {
      sharedState.issue.hideDependencyDashboard =
        hideDependencyDashboardCheckbox.checked ? '1' : '';
      Filters.saveState(sharedState);
      renderAll();
    });
  }

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
      updateSharedFilterOptions();
      if (!sharedControlsRestored) {
        sharedControlsRestored = true;
        syncSharedControlsToState();
      }
      renderAll();
    })
    .catch(() => {
      // A transient failure here just leaves the empty states showing —
      // the dashboard page itself is where a real error banner belongs.
    });
})();
