(() => {
  var FORGE_LABELS = Filters.FORGE_LABELS;
  var FORGE_CLASSES = { github: 'gh', forgejo: 'fj' };

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function repoCell(repo) {
    var wrap = el('span', 'repo');
    var badge = el('span', `forge-badge ${FORGE_CLASSES[repo.forge]}`);
    badge.appendChild(el('span', 'dot'));
    badge.appendChild(
      document.createTextNode(FORGE_LABELS[repo.forge] || repo.forge),
    );
    wrap.appendChild(badge);
    return wrap;
  }

  function setStatus(message, kind) {
    var statusEl = document.getElementById('webhooks-status');
    statusEl.textContent = message || '';
    statusEl.className = `status${kind ? ` ${kind}` : ''}`;
  }

  var state = {
    repos: [],
    forges: [],
    page: 1,
    pageSize: 25,
    filters: { forge: '', repo: '', status: '' },
    sort: { key: 'fullName', dir: 'asc' },
  };

  function forgeRateLimit(forge) {
    var f = state.forges.find((f) => f.forge === forge);
    return f?.rateLimit;
  }

  function resetTimeLabel(iso) {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // reactiveLockReason maps a failed /api/webhooks/ensure response to a
  // reason worth locking the button over, or null for anything retrying
  // might fix (a genuine outage, say) — the two status codes
  // clientErrorStatus (internal/api/webhook_ensure.go) hands back for a
  // cause a click can't do anything about.
  function reactiveLockReason(status) {
    if (status === 403)
      return 'Missing permission — check your token in Settings.';
    if (status === 429)
      return 'Rate limit exceeded — try again once it resets.';
    return null;
  }

  var lockedReasonCounter = 0;

  // lockedButton renders the same button, visually, but aria-disabled
  // rather than natively disabled — a native disabled attribute drops a
  // control from the tab order, which would hide the reason from a
  // keyboard or screen-reader user entirely. The reason is real, visible
  // text wired up with aria-describedby, not a title-only tooltip, for
  // the same reason the forge-health error on the home page uses a
  // <details> disclosure instead of one.
  function lockedButton(reasonText) {
    var wrap = el('span', 'webhook-locked');
    var button = el('button', '', 'Add a webhook');
    button.type = 'button';
    button.setAttribute('aria-disabled', 'true');
    var reasonId = `webhook-locked-reason-${lockedReasonCounter++}`;
    button.setAttribute('aria-describedby', reasonId);
    wrap.appendChild(button);
    var reason = el('span', 'webhook-locked-reason', reasonText);
    reason.id = reasonId;
    wrap.appendChild(reason);
    return wrap;
  }

  function setPage(page) {
    state.page = page;
    render();
  }

  // filteredRepos applies every active filter as an AND — narrower with
  // each one, matching the main dashboard's own filter-bar behavior.
  function filteredRepos() {
    return state.repos.filter((r) => {
      if (state.filters.forge && r.forge !== state.filters.forge) {
        return false;
      }
      if (
        state.filters.repo &&
        !r.fullName.toLowerCase().includes(state.filters.repo.toLowerCase())
      ) {
        return false;
      }
      if (state.filters.status === 'confirmed' && !r.hasWebhook) {
        return false;
      }
      if (state.filters.status === 'pending' && r.hasWebhook) {
        return false;
      }
      return true;
    });
  }

  function sortValue(repo, key) {
    if (key === 'hasWebhook') return repo.hasWebhook ? 1 : 0;
    return repo[key];
  }

  function sortedRepos(repos) {
    var key = state.sort.key;
    var dir = state.sort.dir === 'desc' ? -1 : 1;
    return repos.slice().sort((a, b) => {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  // updateSortIndicators keeps every header's aria-sort and arrow in
  // sync with state.sort — the one column currently driving order gets
  // an arrow and a real ascending/descending value; every other header
  // goes back to "none" rather than lying about being sorted too.
  function updateSortIndicators() {
    document.querySelectorAll('.sort-button').forEach((button) => {
      var th = button.closest('th');
      var arrow = button.querySelector('.sort-arrow');
      if (button.dataset.sortKey === state.sort.key) {
        th.setAttribute(
          'aria-sort',
          state.sort.dir === 'desc' ? 'descending' : 'ascending',
        );
        arrow.textContent = state.sort.dir === 'desc' ? '▼' : '▲';
      } else {
        th.setAttribute('aria-sort', 'none');
        arrow.textContent = '';
      }
    });
  }

  document.querySelectorAll('.sort-button').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.sort.key === button.dataset.sortKey) {
        state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sort.key = button.dataset.sortKey;
        state.sort.dir = 'asc';
      }
      updateSortIndicators();
      state.page = 1;
      render();
    });
  });

  document.querySelectorAll('.webhooks-filter').forEach((input) => {
    var eventName = input.type === 'text' ? 'input' : 'change';
    input.addEventListener(eventName, () => {
      state.filters[input.dataset.filter] = input.value;
      state.page = 1;
      render();
    });
  });

  function renderPagination(totalPages) {
    var wrap = document.getElementById('webhooks-pagination');
    var needed = totalPages > 1;
    wrap.hidden = !needed;
    if (!needed) return;

    var pages = document.getElementById('webhooks-pagination-pages');
    pages.innerHTML = '';

    var prev = el('button', 'pagination-nav', 'Previous');
    prev.type = 'button';
    prev.disabled = state.page <= 1;
    prev.addEventListener('click', () => setPage(state.page - 1));
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
        (
          (page) => () =>
            setPage(page)
        )(p),
      );
      pages.appendChild(button);
    }

    var next = el('button', 'pagination-nav', 'Next');
    next.type = 'button';
    next.disabled = state.page >= totalPages;
    next.addEventListener('click', () => setPage(state.page + 1));
    pages.appendChild(next);
  }

  // addWebhookButton is a real <button>, not a styled link — its own
  // click drives the create/fix-up call, so it needs the keyboard
  // activation and focus behaviour a link would have to fake.
  function addWebhookButton(repo) {
    var rl = forgeRateLimit(repo.forge);
    if (rl && rl.remaining === 0) {
      return lockedButton(
        `Rate limit exhausted · resets ${resetTimeLabel(rl.resetsAt)}`,
      );
    }

    var button = el('button', '', 'Add a webhook');
    button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Adding…';
      setStatus(`Adding a webhook for ${repo.fullName}…`);

      fetch('/api/webhooks/ensure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ forge: repo.forge, fullName: repo.fullName }),
      })
        .then((res) => {
          if (res.status === 401) {
            window.location.href = '/login.html';
            throw new Error('session expired');
          }
          if (res.status === 204) return null;
          return res.json().then((body) => {
            var err = new Error(
              body?.error || `backend answered ${res.status}`,
            );
            err.status = res.status;
            throw err;
          });
        })
        .then(() => {
          repo.hasWebhook = true;
          setStatus(`Webhook added for ${repo.fullName}.`);
          render();
        })
        .catch((err) => {
          setStatus(
            `Couldn't add a webhook for ${repo.fullName}: ${err.message}`,
            'error',
          );
          var lockReason = reactiveLockReason(err.status);
          if (lockReason) {
            button.replaceWith(lockedButton(lockReason));
            return;
          }
          button.disabled = false;
          button.textContent = 'Add a webhook';
        });
    });
    return button;
  }

  function render() {
    var empty = document.getElementById('webhooks-empty');
    var table = document.getElementById('webhooks-table');
    var filterBar = document.getElementById('webhooks-filter-bar');
    var noResults = document.getElementById('webhooks-no-results');

    if (!state.repos.length) {
      empty.hidden = false;
      filterBar.hidden = true;
      table.hidden = true;
      noResults.hidden = true;
      document.getElementById('webhooks-pagination').hidden = true;
      return;
    }
    empty.hidden = true;
    filterBar.hidden = false;

    var visible = sortedRepos(filteredRepos());

    if (!visible.length) {
      table.hidden = true;
      noResults.hidden = false;
      document.getElementById('webhooks-pagination').hidden = true;
      return;
    }
    noResults.hidden = true;
    table.hidden = false;

    var totalPages = Math.max(1, Math.ceil(visible.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    var start = (state.page - 1) * state.pageSize;
    var pageItems = visible.slice(start, start + state.pageSize);

    var tbody = document.getElementById('webhooks-rows');
    tbody.innerHTML = '';
    pageItems.forEach((repo) => {
      var tr = document.createElement('tr');

      var forgeTd = document.createElement('td');
      forgeTd.appendChild(repoCell(repo));
      tr.appendChild(forgeTd);

      tr.appendChild(el('td', '', repo.fullName));

      var statusTd = el(
        'td',
        repo.hasWebhook ? 'status-confirmed' : 'status-pending',
        repo.hasWebhook ? 'Confirmed' : 'Not yet',
      );
      tr.appendChild(statusTd);

      var actionTd = document.createElement('td');
      actionTd.className = 'action';
      if (!repo.hasWebhook) {
        actionTd.appendChild(addWebhookButton(repo));
      }
      tr.appendChild(actionTd);

      tbody.appendChild(tr);
    });

    renderPagination(totalPages);
  }

  var pageSizeSelect = document.getElementById('webhooks-page-size');
  pageSizeSelect.addEventListener('change', () => {
    state.pageSize = Number(pageSizeSelect.value) || 25;
    state.page = 1;
    render();
  });

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
      state.repos = data.repos || [];
      state.forges = data.forges || [];
      updateSortIndicators();
      render();
    })
    .catch(() => {
      // A transient failure here just leaves the empty state showing —
      // the dashboard page itself is where a real error banner belongs.
    });
})();
