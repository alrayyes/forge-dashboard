// Release history — sourced live from GitHub's public releases API, not
// hand-maintained. Fetched directly from the browser: the endpoint is
// unauthenticated, public, and answers with Access-Control-Allow-Origin:
// * (verified live), so there's nothing for this service's own backend
// to proxy or cache.
(() => {
  var REPO = 'alrayyes/forge-dashboard';

  var statusEl = document.getElementById('status');
  var listEl = document.getElementById('release-list');
  var emptyEl = document.getElementById('release-empty');

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = `status${kind ? ` ${kind}` : ''}`;
  }

  function escapeHTML(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function inline(text) {
    return escapeHTML(text).replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, label, url) =>
        '<a href="' +
        url +
        '" target="_blank" rel="noopener noreferrer">' +
        label +
        '</a>',
    );
  }

  // release-please/goreleaser output, not general Markdown: a leading
  // "## [version](compare-link) (date)" line (dropped — redundant with
  // the version/date this page already shows above it), then
  // "### Features"/"### Bug Fixes" sections of "* text ([#N](url))
  // ([hash](url))" bullets. Narrow to exactly that shape, safe by
  // construction since every piece of text is HTML-escaped before any
  // tag goes around it.
  function renderReleaseNotes(body) {
    var lines = (body || '').split('\n');
    var html = '';
    var inList = false;

    function closeList() {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    }

    lines.forEach((rawLine) => {
      var line = rawLine.trim();
      if (!line || line.indexOf('## ') === 0) return;
      if (line.indexOf('### ') === 0) {
        closeList();
        html += `<h3>${inline(line.slice(4))}</h3>`;
        return;
      }
      if (line.indexOf('* ') === 0) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${inline(line.slice(2))}</li>`;
        return;
      }
      closeList();
      html += `<p>${inline(line)}</p>`;
    });
    closeList();
    return html;
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  function renderReleases(releases) {
    listEl.innerHTML = '';
    emptyEl.hidden = releases.length > 0;

    releases.forEach((r) => {
      var li = document.createElement('li');
      li.className = 'release';

      var head = document.createElement('div');
      head.className = 'release-head';

      var h2 = document.createElement('h2');
      var link = document.createElement('a');
      link.href = r.html_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = r.name || r.tag_name;
      h2.appendChild(link);
      head.appendChild(h2);

      var published = r.published_at || r.created_at;
      var time;
      if (published) {
        time = document.createElement('time');
        time.className = 'release-date';
        time.setAttribute('datetime', published);
        time.textContent = formatDate(published);
        head.appendChild(time);
      }

      li.appendChild(head);

      var notes = document.createElement('div');
      notes.className = 'release-notes';
      notes.innerHTML = renderReleaseNotes(r.body);
      li.appendChild(notes);

      listEl.appendChild(li);
    });
  }

  setStatus('Loading…');
  fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
    .then((res) => {
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      return res.json();
    })
    .then((data) => {
      setStatus('');
      renderReleases(data || []);
    })
    .catch(() => {
      setStatus(
        'Could not load release history from GitHub. See it directly: ',
        'error',
      );
      var link = document.createElement('a');
      link.href = `https://github.com/${REPO}/releases`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `github.com/${REPO}/releases`;
      statusEl.appendChild(link);
    });
})();
