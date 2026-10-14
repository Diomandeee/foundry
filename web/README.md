# web/ — board UI notes

The decision board is served by `workers/api` (`GET /`, live on staging and
production). There is no separate frontend build; this directory holds no
code. The machine history feed behind external views is `GET /history.json`.
