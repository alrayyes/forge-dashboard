(() => {
  // Same order and labels app.js's own CI_LABELS uses, so "Passing" here
  // means the same thing it means on the dashboard's own CI-failing tile.
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

  function renderAgeHistogram(pullRequests) {
    var chart = document.getElementById('pr-age-chart');
    var empty = document.getElementById('pr-age-empty');
    var table = document.getElementById('pr-age-table');
    var tbody = table.querySelector('tbody');

    if (pullRequests.length === 0) {
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
    pullRequests.forEach((p) => {
      var hoursOld = (now - new Date(p.createdAt).getTime()) / (60 * 60 * 1000);
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
      renderCIStatus(data.pullRequests || []);
      renderRepoRanking(data.pullRequests || [], 'repo-pr');
      renderRepoRanking(data.issues || [], 'repo-issue');
      renderAgeHistogram(data.pullRequests || []);
    })
    .catch(() => {
      // A transient failure here just leaves the empty state showing —
      // the dashboard page itself is where a real error banner belongs.
    });
})();
