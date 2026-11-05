# Taskly Status

Public status page for [Taskly](https://tasklypro.app): **https://status.tasklypro.app**

Runs entirely on GitHub (Actions + Pages), independent of Taskly's own servers,
so it stays up and keeps alerting during an outage.

## How it works

- `.github/workflows/monitor.yml` probes every component in `config.json` every
  5 minutes (3 attempts, 15 s apart, before something counts as down).
- Results go to `status.json` on the `data` branch (a single commit that is
  force-pushed on each run). It holds 90 days of daily uptime plus 48 hours of
  individual checks.
- `site/` is the static page (deployed by `pages.yml`). It reads
  `status.json` from raw.githubusercontent.com and refreshes every minute.
- When something goes **down**, the monitor opens an incident issue (labels
  `incident`, `auto`, `component:*`), locks it, and emails `ALERT_EMAIL`. When
  everything is **back**, it posts "Resolved", closes the issue and emails again.

## Posting incidents and updates

Incidents are GitHub issues labelled `incident`, and they appear on the page within a minute.

- **Update an incident:** comment on its issue. Start with a bold status word,
  e.g. `**Identified** — A database migration is slow; rolling back.`
- **Manual incident:** open an issue with the labels `incident`, `major` or
  `minor`, and one or more `component:<id>` labels (`web`, `api`, `ipad`,
  `mcp`, `website`). Close it when it's resolved.
- **Planned maintenance:** use the labels `incident` and `maintenance`.

Only comments and issues from repo owners and collaborators are shown.

## Adding a component

Add an entry to `config.json` with `id`, `name`, `description`, `url` and
`expect` (an HTTP code), plus optionally `contains` (a required body substring)
and `headers`.

## Local preview

```sh
cd site && python3 -m http.server 8791
# open http://127.0.0.1:8791/  (add ?theme=light or ?theme=dark)
```

## Secrets

- `SMTP_PASSWORD`: the password for `info@tasklypro.app`, used for alert emails.
