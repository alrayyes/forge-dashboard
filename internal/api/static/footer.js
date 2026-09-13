// Shared by every page's footer (index/settings/admin/login/releases) —
// fetches the running server's own version once and links it to the
// matching GitHub release, so a person can tell what's actually deployed
// without shelling into the box. Public and unauthenticated, same as
// /api/version itself, so this works on the pre-login page too. Also
// links to the in-app release history page, next to the version, unless
// already on it.
(() => {
  var target = document.getElementById('footer-version');
  if (!target) return;

  function addReleaseHistoryLink() {
    if (window.location.pathname === '/releases.html') return;
    var link = document.createElement('a');
    link.href = '/releases.html';
    link.textContent = 'Release history';
    target.appendChild(document.createTextNode(' · '));
    target.appendChild(link);
  }

  fetch('/api/version', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data?.version) return;

      var link;
      if (data.version === 'dev') {
        target.textContent = '· dev build';
      } else {
        link = document.createElement('a');
        link.href =
          'https://github.com/alrayyes/forge-dashboard/releases/tag/v' +
          data.version;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'mono';
        link.textContent = `v${data.version}`;

        target.appendChild(document.createTextNode('· '));
        target.appendChild(link);
      }

      addReleaseHistoryLink();
    })
    .catch(() => {
      /* a transient failure here isn't worth showing anything for */
    });
})();
