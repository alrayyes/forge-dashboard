// Shared filter state and matching, loaded by both the main dashboard
// (app.js) and Insights (insights.js) — the one place their filter
// behavior is implemented instead of two independently maintained copies.
// A plain global, not an ES module: every other script in this project is
// a plain <script src> tag with no import/export, and this stays
// consistent with that rather than introducing the first module here
// (see design.md's "extract shared logic into one plain script" decision).
var Filters = (() => {
  var FORGE_LABELS = { github: 'GitHub', forgejo: 'Forgejo' };
  var DEPENDENCY_DASHBOARD_TITLE = 'Dependency Dashboard';
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

  // One shared object (forge/repo/label/author/title/created/updated/
  // groupBy) plus two board-owned extras with no equivalent on the other
  // entity type — see design.md's "one shared filter object, plus two
  // board-owned extra fields" decision. An older {pr:{...}, issue:{...}}
  // cookie from before this shape simply matches none of these keys and
  // reads back as defaults: a one-time silent reset, not a migration to
  // write and later delete.
  function defaultState() {
    return {
      shared: {},
      pr: {},
      issue: { hideDependencyDashboard: '1' },
    };
  }

  function loadState() {
    var raw = getCookie(FILTERS_COOKIE);
    var state = defaultState();
    var parsed;
    if (!raw) return state;
    try {
      parsed = JSON.parse(raw);
    } catch (_e) {
      return state;
    }
    if (!parsed || typeof parsed !== 'object') return state;
    if (parsed.shared && typeof parsed.shared === 'object')
      Object.assign(state.shared, parsed.shared);
    if (parsed.pr && typeof parsed.pr === 'object')
      Object.assign(state.pr, parsed.pr);
    if (parsed.issue && typeof parsed.issue === 'object')
      Object.assign(state.issue, parsed.issue);
    return state;
  }

  function saveState(state) {
    try {
      setCookie(FILTERS_COOKIE, JSON.stringify(state));
    } catch (_e) {
      /* ignore */
    }
  }

  function minutesAgo(iso) {
    return Math.max(
      0,
      Math.round((Date.now() - new Date(iso).getTime()) / 60000),
    );
  }

  // shared carries the fields that apply to both pull requests and
  // issues; extra carries whichever board-owned field applies to this
  // item's own entity type (status for a pull request,
  // hideDependencyDashboard for an issue) — the caller passes only the
  // one relevant to isPR.
  function matchesFilters(item, isPR, shared, extra) {
    var repoKey = `${item.forge}:${item.repo}`.toLowerCase();
    if (shared.forge && item.forge !== shared.forge) return false;
    if (shared.repo && repoKey !== shared.repo) return false;
    if (shared.title && item.title.toLowerCase().indexOf(shared.title) === -1)
      return false;
    if (
      shared.author &&
      (item.author || '').toLowerCase().indexOf(shared.author) === -1
    )
      return false;
    if (shared.created && minutesAgo(item.createdAt) > Number(shared.created))
      return false;
    if (shared.updated && minutesAgo(item.updatedAt) > Number(shared.updated))
      return false;
    if (
      shared.label &&
      !(item.labels || []).some((l) => l.name.toLowerCase() === shared.label)
    )
      return false;
    if (isPR && extra?.status && item.ci !== extra.status) return false;
    // Renovate's one permanently-open, constantly-rewritten housekeeping
    // issue per repo — never a pull request, so this only ever matches
    // on the issues board. Exact title match: that's the fixed title
    // Renovate itself always uses.
    if (
      !isPR &&
      extra?.hideDependencyDashboard &&
      item.title.trim() === DEPENDENCY_DASHBOARD_TITLE
    )
      return false;
    return true;
  }

  // Distinct, sorted values of getValues(item) across items — what both
  // a filter <select>'s options and a filter <input>'s <datalist>
  // suggestions are populated from. getValues returns either one value
  // or an array of them (label — an item can carry several).
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

  // Rebuilds select's options (after its fixed first "All ..." option,
  // written once in the HTML) from values, keeping previous selected if
  // it's still among them. Returns true when previous was stale and got
  // cleared — the caller's own signal to clear the underlying filter
  // state too, not just the visible control, or it keeps silently
  // filtering out everything on a value nothing can match, with no
  // visible cause.
  function populateSelect(select, values, previous) {
    if (!select) return false;
    while (select.options.length > 1) select.remove(1);
    values.forEach((v) => {
      var option = document.createElement('option');
      option.value = v;
      option.textContent = v;
      select.appendChild(option);
    });
    if (values.indexOf(previous) !== -1) {
      select.value = previous;
      return false;
    }
    select.value = '';
    return Boolean(previous);
  }

  // Title is the one column that's genuinely open-ended free text — the
  // datalist only adds suggestions from what's on screen, it doesn't
  // restrict what can still be typed and substring-matched.
  function populateDatalist(datalist, values) {
    if (!datalist) return;
    datalist.innerHTML = '';
    values.forEach((v) => {
      var option = document.createElement('option');
      option.value = v;
      datalist.appendChild(option);
    });
  }

  // Repo is forge-qualified ("github:owner/name") rather than bare, since
  // the same repo name can exist under more than one forge — picking one
  // has to resolve to exactly that forge's copy, never both
  // (matchesFilters matches this value exactly, not by substring).
  // Grouped under a heading per forge (<optgroup>) only when more than
  // one forge is actually represented among items — a single forge has
  // nothing left to disambiguate, so options stay flat. Returns true when
  // the previously selected repo went stale, the same signal
  // populateSelect gives.
  function populateRepoSelect(select, items) {
    var byForge = {};
    var forgeOrder = [];
    var seen = {};
    var previous;
    var stillPresent = false;
    var grouped;
    var parent;
    if (!select) return false;
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
      return false;
    }
    select.value = '';
    return Boolean(previous);
  }

  return {
    FORGE_LABELS: FORGE_LABELS,
    DEPENDENCY_DASHBOARD_TITLE: DEPENDENCY_DASHBOARD_TITLE,
    loadState: loadState,
    saveState: saveState,
    minutesAgo: minutesAgo,
    matchesFilters: matchesFilters,
    distinctValues: distinctValues,
    populateSelect: populateSelect,
    populateDatalist: populateDatalist,
    populateRepoSelect: populateRepoSelect,
  };
})();
