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

  var state = { repos: [], page: 1, pageSize: 25 };

  function setPage(page) {
    state.page = page;
    render();
  }

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

  function render() {
    var empty = document.getElementById('webhooks-empty');
    var table = document.getElementById('webhooks-table');

    if (!state.repos.length) {
      empty.hidden = false;
      table.hidden = true;
      document.getElementById('webhooks-pagination').hidden = true;
      return;
    }
    empty.hidden = true;
    table.hidden = false;

    var totalPages = Math.max(
      1,
      Math.ceil(state.repos.length / state.pageSize),
    );
    if (state.page > totalPages) state.page = totalPages;
    var start = (state.page - 1) * state.pageSize;
    var pageItems = state.repos.slice(start, start + state.pageSize);

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
      var link;
      if (!repo.hasWebhook) {
        link = el('a', '', 'Add a webhook');
        link.href = '/settings.html#webhooks';
        actionTd.appendChild(link);
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
      state.repos = (data.repos || [])
        .slice()
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
      render();
    })
    .catch(() => {
      // A transient failure here just leaves the empty state showing —
      // the dashboard page itself is where a real error banner belongs.
    });
})();
