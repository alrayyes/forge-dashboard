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

  // ---- cookies ----
  // A cookie, not localStorage: it rides along on the request that renders
  // the page, and it's the one storage mechanism shared identically by
  // this file and theme.js (a separate script, loaded synchronously in
  // <head> on other pages, with no module system to share state through).
  // One year is long enough that "log back in later" always finds it;
  // SameSite=Lax (not Strict, and no Secure — this also has to work over
  // plain http://localhost in local/CI testing) so a link in from outside
  // an already-authenticated tab still carries it.
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

  // ---- persisted per-column filters ----
  // Both boards share one cookie, keyed by idPrefix ('pr'/'issue'), so
  // persisting one board's filters never clobbers the other's.
  var FILTERS_COOKIE = 'forge-board-filters';

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

  function loadPersistedFilters(idPrefix) {
    return loadAllPersistedFilters()[idPrefix] || {};
  }

  function savePersistedFilters(idPrefix, filters) {
    var all = loadAllPersistedFilters();
    all[idPrefix] = filters;
    try {
      setCookie(FILTERS_COOKIE, JSON.stringify(all));
    } catch (_e) {
      /* ignore */
    }
  }

  // ---- theme toggle ----
  (function initTheme() {
    var root = document.documentElement;
    var toggle = document.getElementById('theme-toggle');
    var THEME_COOKIE = 'forge-board-theme';

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

    applyTheme(getCookie(THEME_COOKIE));

    toggle.addEventListener('click', () => {
      var currentlyDark =
        root.getAttribute('data-theme') === 'dark' ||
        (!root.getAttribute('data-theme') && systemPrefersDark());
      var next = currentlyDark ? 'light' : 'dark';
      applyTheme(next);
      setCookie(THEME_COOKIE, next);
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
    // activeLabel (state.filters.label) is always lowercase — set that
    // way by both the chip click below and the Label <select>'s generic
    // .col-filter wiring, which lowercases every filter value uniformly
    // — so the comparison here has to lowercase label.name to match.
    var isActive = label.name.toLowerCase() === activeLabel;
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
    // Forge-qualified and matched exactly, not by substring: the Repo
    // <select>'s options are always a complete "forge:repo" token (never
    // partial text a user typed), and the same repo name can exist under
    // more than one forge — a substring match would resolve one option to
    // both forges' copies at once, with no way to pick just one (#112).
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
    if (filters.created && minutesAgo(item.createdAt) > Number(filters.created))
      return false;
    if (filters.updated && minutesAgo(item.updatedAt) > Number(filters.updated))
      return false;
    if (filters.status && isPR && item.ci !== filters.status) return false;
    if (
      filters.label &&
      !(item.labels || []).some((l) => l.name.toLowerCase() === filters.label)
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
    var section = document.getElementById(containerId).closest('section.board');
    var state = {
      items: [],
      filters: Object.assign({}, loadPersistedFilters(idPrefix)),
      groupBy: null,
      page: 1,
      pageSize: 25,
    };
    var filtersRestoredToControls = false;

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

    // Everything Repo/Author/Label/title-suggestions get built from —
    // all items when no Forge filter is set, only that forge's items once
    // one is. Picking a forge should narrow what the other controls
    // offer, not just what rows show (#112).
    function forgeScopedItems() {
      if (!state.filters.forge) return state.items;
      return state.items.filter((item) => item.forge === state.filters.forge);
    }

    // Distinct, sorted values of getValues(item) across items — what both
    // a filter <select>'s options and a filter <input>'s <datalist>
    // suggestions are populated from. getValues returns either one value
    // (author, title) or an array of them (label — an item can carry
    // several).
    function distinctValues(getValues, items) {
      var seen = {};
      var values = [];
      items.forEach((item) => {
        var vs = getValues(item);
        (Array.isArray(vs) ? vs : [vs]).forEach((v) => {
          if (v && !seen[v]) {
            seen[v] = true;
            values.push(v);
          }
        });
      });
      values.sort();
      return values;
    }

    // Author and label are a small, closed set of values actually on
    // screen at any moment — the same reasoning created/updated/status
    // are already plain <select>s for. The "all" placeholder is the
    // select's own first <option>, written once in the HTML rather than
    // rebuilt here; only the options after it get replaced. Can't just
    // clear+repopulate blindly either way, or a selection survives only
    // until the next item-set refresh (a poll, an SSE push, another
    // filter narrowing what's visible) silently resets it back to "all."
    //
    // col names which state.filters key this select drives — when the
    // previously selected value doesn't survive the rebuild (its option
    // is gone), the underlying filter is cleared too, not just the
    // visible control: otherwise it keeps silently filtering out
    // everything on a value nothing can match, with no visible cause
    // (#112, the same shape of bug #107 fixed for the Label select).
    function populateSelect(select, values, col) {
      if (!select) return;
      var previous = select.value;
      while (select.options.length > 1) select.remove(1);
      values.forEach((v) => {
        var option = document.createElement('option');
        option.value = v;
        option.textContent = v;
        select.appendChild(option);
      });
      if (values.indexOf(previous) !== -1) {
        select.value = previous;
      } else if (previous) {
        select.value = '';
        if (state.filters[col]) {
          state.filters[col] = '';
          savePersistedFilters(idPrefix, state.filters);
        }
      }
    }

    // Repo is forge-qualified ("github:owner/name") rather than bare,
    // since the same repo name can exist under more than one forge —
    // picking one has to resolve to exactly that forge's copy, never
    // both (matchesFilters matches this value exactly, not by
    // substring). Grouped under a heading per forge (<optgroup>, the
    // same display labels group-by-forge's own headings use) only when
    // more than one forge is actually represented among the scoped
    // items — a single forge (one forge configured, or the Forge filter
    // already narrowed to one) has nothing left to disambiguate, so
    // options stay flat. Clears the selection (control and filter) the
    // same way populateSelect does when the previous choice doesn't
    // survive the rebuild.
    function populateRepoSelect(items) {
      var select = document.getElementById(`${idPrefix}-repo-select`);
      var byForge = {};
      var forgeOrder = [];
      var seen = {};
      var previous;
      var stillPresent = false;
      var grouped;
      var parent;
      if (!select) return;
      previous = select.value;

      items.forEach((item) => {
        var value = `${item.forge}:${item.repo}`;
        if (!byForge[item.forge]) {
          byForge[item.forge] = [];
          forgeOrder.push(item.forge);
        }
        if (!seen[value]) {
          seen[value] = true;
          byForge[item.forge].push({ value: value, label: item.repo });
        }
      });
      forgeOrder.sort();
      forgeOrder.forEach((forge) => {
        byForge[forge].sort((a, b) => a.label.localeCompare(b.label));
      });

      // Unlike populateSelect's flat options, a previous population here
      // may have left <optgroup> wrappers behind — select.remove(), like
      // the options collection it acts on, only ever removes <option>
      // elements, never the (possibly now-empty) <optgroup> holding them.
      // Drop every child but the first "All ..." option outright, so
      // switching from grouped to ungrouped (or back) never accumulates
      // stale, empty optgroups.
      Array.from(select.children)
        .slice(1)
        .forEach((child) => {
          child.remove();
        });

      grouped = forgeOrder.length > 1;
      forgeOrder.forEach((forge) => {
        parent = grouped ? document.createElement('optgroup') : select;
        if (grouped) {
          parent.label = FORGE_LABELS[forge] || forge;
          select.appendChild(parent);
        }
        byForge[forge].forEach((entry) => {
          var option = document.createElement('option');
          option.value = entry.value;
          option.textContent = entry.label;
          parent.appendChild(option);
          if (entry.value === previous) stillPresent = true;
        });
      });

      if (stillPresent) {
        select.value = previous;
      } else if (previous) {
        select.value = '';
        if (state.filters.repo) {
          state.filters.repo = '';
          savePersistedFilters(idPrefix, state.filters);
        }
      }
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

    // "Group by forge" is a no-op once the Forge filter already narrows
    // every visible row to one forge — grouping by it would produce
    // exactly one cluster, telling the user nothing a flat list didn't
    // already. Hidden in that case; resets to no grouping if it was the
    // active mode when a forge got picked (#112).
    function updateGroupByOptions() {
      var forgeOption = groupSelect
        ? groupSelect.querySelector('option[value="forge"]')
        : null;
      var forgeFilterActive;
      if (!forgeOption) return;
      forgeFilterActive = Boolean(state.filters.forge);
      forgeOption.hidden = forgeFilterActive;
      if (forgeFilterActive && state.groupBy === 'forge') {
        state.groupBy = null;
        groupSelect.value = '';
      }
    }

    function updateFilterOptions() {
      var scoped = forgeScopedItems();
      populateRepoSelect(scoped);
      populateSelect(
        document.getElementById(`${idPrefix}-author-select`),
        distinctValues((item) => item.author, scoped),
        'author',
      );
      populateDatalist(
        document.getElementById(`${idPrefix}-title-options`),
        distinctValues((item) => item.title, scoped),
      );
      populateSelect(
        document.getElementById(`${idPrefix}-label-select`),
        distinctValues(
          (item) => (item.labels || []).map((l) => l.name),
          scoped,
        ),
        'label',
      );
      updateGroupByOptions();
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
      savePersistedFilters(idPrefix, state.filters);
      render();
      return next;
    }

    // Restores each visible .col-filter control to match the filters just
    // loaded from the cookie. Only meaningful once real items exist:
    // repo/author/label are dynamic <select>s populated from what's on
    // screen, and setting a <select>'s value to one it has no matching
    // <option> for yet is silently dropped rather than queued — the same
    // trap handleLabelClick works around. Runs once, right after the
    // first setItems — a later refresh must never repeat it, or it would
    // stomp the title filter back to its lowercase canonical form (what
    // state.filters holds) over whatever case the user is mid-typing.
    function syncControlsToFilters() {
      if (!section) return;
      section.querySelectorAll('.col-filter').forEach((c) => {
        var value = state.filters[c.dataset.col];
        var option;
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

    // Each board filters its own labels independently — a click here
    // never touches the other board's state. Keeps the Label select's
    // displayed value in sync, the same pattern handleStatusClick uses
    // for the CI-status select — a chip is one way to set this filter,
    // the select is the other, and either always reflects what's
    // actually active regardless of which one drove the change.
    function handleLabelClick(label) {
      // state.filters.label is always lowercase (matchesFilters and
      // labelChip's active check both expect that, matching the Label
      // <select>'s own generic .col-filter wiring, which lowercases
      // uniformly) — but a real <option>'s value keeps its real case,
      // so select.value can't just be assigned next directly; the
      // browser only accepts an exact (case-sensitive) option value,
      // silently clearing the selection on any case mismatch otherwise.
      var next = toggleFilter('label', label.toLowerCase());
      var select = document.getElementById(`${idPrefix}-label-select`);
      var option;
      if (select) {
        option = Array.from(select.options).find(
          (o) => o.value.toLowerCase() === next,
        );
        select.value = option ? option.value : '';
      }
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
        if (!filtersRestoredToControls) {
          filtersRestoredToControls = true;
          syncControlsToFilters();
        }
        render();
      },
      setFilter: (col, value) => {
        state.filters[col] = value;
        state.page = 1;
        // Repo/Author/Label options (and "Group by forge") are scoped to
        // the active forge, so a forge change has to re-narrow them right
        // away rather than waiting for the next poll's setItems (#112).
        if (col === 'forge') updateFilterOptions();
        savePersistedFilters(idPrefix, state.filters);
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
  function rateLimitChip(rl) {
    var resetTime = new Date(rl.resetsAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    return el(
      'span',
      `forge-health-ratelimit${rl.remaining === 0 ? ' exhausted' : ''}`,
      `${rl.remaining}/${rl.limit} requests · resets ${resetTime}`,
    );
  }

  function renderForgeHealth(forges) {
    var container = document.getElementById('forge-health');
    container.innerHTML = '';
    forges.forEach((f) => {
      var item = el('div', 'forge-health-item');
      var chip = el('span', `forge-health${f.reachable ? '' : ' unreachable'}`);
      chip.appendChild(el('span', 'pulse-dot'));
      var label =
        (FORGE_LABELS[f.forge] || f.forge) +
        (f.reachable ? ' reachable' : ' unreachable');
      chip.appendChild(document.createTextNode(label));
      item.appendChild(chip);
      // The reason has to be real text, not just chip.title — a hover
      // tooltip never reaches a touch device and isn't reliably announced
      // by a screen reader either.
      if (!f.reachable && f.error) {
        chip.title = f.error;
        item.appendChild(el('span', 'forge-health-error', f.error));
      }
      // Shown whenever this forge reports one, reachable or not — the
      // point is seeing the budget before it's already the reason
      // something looks unreachable, not just explaining it after.
      if (f.rateLimit) item.appendChild(rateLimitChip(f.rateLimit));
      container.appendChild(item);
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
    var failingCount = prs.filter((p) => p.ci === 'failure').length;
    document.getElementById('stat-failing').textContent = String(failingCount);
    // Red only once there's actually something failing — zero is good
    // news, not a tile that reads as an alarm nobody needs to act on —
    // and green, not just neutral, since zero failing is itself the
    // positive signal a CI status tile exists to show.
    statFailingTile.classList.toggle('critical', failingCount > 0);
    statFailingTile.classList.toggle('ok', failingCount === 0);
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
