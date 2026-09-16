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

  // addWebhookButton is a real <button>, not a styled link — its own
  // click drives the create/fix-up call, so it needs the keyboard
  // activation and focus behaviour a link would have to fake.
  function addWebhookButton(repo) {
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
            throw new Error(body?.error || `backend answered ${res.status}`);
          });
        })
        .then(() => {
          repo.hasWebhook = true;
          setStatus(`Webhook added for ${repo.fullName}.`);
          render();
        })
        .catch((err) => {
          button.disabled = false;
          button.textContent = 'Add a webhook';
          setStatus(
            `Couldn't add a webhook for ${repo.fullName}: ${err.message}`,
            'error',
          );
        });
    });
    return button;
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
