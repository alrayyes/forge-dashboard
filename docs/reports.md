# Reports

Every push to `main` that passes CI publishes the generated reports at
<https://apis.ryankes.eu/forge-dashboard/reports/>:

- [Test results](https://apis.ryankes.eu/forge-dashboard/reports/tests/), the
  JUnit XML of the Go tests (`unit.xml`) and the Playwright journeys
  (`e2e.xml`).
- [Coverage](https://apis.ryankes.eu/forge-dashboard/reports/coverage/), an
  HTML view plus `coverage.xml` (Cobertura) and the native Go `coverage.out`.
- [Lighthouse](https://apis.ryankes.eu/forge-dashboard/reports/lighthouse/),
  one report (and its JSON) for the login page and for each signed-in page,
  under fixed names such as `login.report.html` and `home.report.json` that
  don't change between deploys. Only each page's representative run is kept.
  `lighthouse/report.html` and `report.json` stay as the first page's run.
