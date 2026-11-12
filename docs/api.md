# API reference

Interactive docs: `http://127.0.0.1:8000/docs` (Swagger) or `/redoc`. Machine-readable spec: [`openapi.json`](openapi.json), generated from the running app.

Authentication: `POST /api/auth/login` returns a bearer token; send `Authorization: Bearer <token>`. Server-sent event endpoints (`/api/events`, `/api/runs/{id}/stream`) and file links also accept `?access_token=` because browsers cannot set headers on EventSource or links. Worker agents use their own agent token on `/api/agent/*`.

File paths in requests are *virtual paths*: `<data-root>:<relative/path>`.

### auth

- `DELETE /api/auth/invites/{invite_id}`
- `DELETE /api/auth/requests/{user_id}`
- `DELETE /api/auth/users/{user_id}`
- `GET    /api/auth/account-settings`
- `GET    /api/auth/audit`
- `GET    /api/auth/invites`
- `GET    /api/auth/invites/check`
- `GET    /api/auth/me`
- `GET    /api/auth/requests`
- `GET    /api/auth/setup`
- `GET    /api/auth/signup`
- `GET    /api/auth/users`
- `POST   /api/auth/invites`
- `POST   /api/auth/invites/accept`
- `POST   /api/auth/login`
- `POST   /api/auth/password`
- `POST   /api/auth/request-account`
- `POST   /api/auth/requests/{user_id}/approve`
- `POST   /api/auth/setup`
- `POST   /api/auth/users`
- `PUT    /api/auth/account-settings`

### pipelines

- `DELETE /api/pipelines/{pid}`
- `DELETE /api/pipelines/{pid}/presets/{preset_id}`
- `GET    /api/pipeline-schemas/{pid}`
- `GET    /api/pipelines`
- `GET    /api/pipelines/{pid}`
- `GET    /api/pipelines/{pid}/files`
- `GET    /api/pipelines/{pid}/files/content`
- `GET    /api/pipelines/{pid}/history`
- `GET    /api/pipelines/{pid}/map`
- `GET    /api/pipelines/{pid}/presets`
- `PATCH  /api/pipelines/{pid}`
- `POST   /api/pipeline-schemas/{pid}/author`
- `POST   /api/pipeline-schemas/{pid}/export`
- `POST   /api/pipeline-schemas/{pid}/validate`
- `POST   /api/pipeline-versions/{version_id}/pin`
- `POST   /api/pipelines/import/git`
- `POST   /api/pipelines/import/local`
- `POST   /api/pipelines/{pid}/duplicate`
- `POST   /api/pipelines/{pid}/files`
- `POST   /api/pipelines/{pid}/fork`
- `POST   /api/pipelines/{pid}/presets`
- `POST   /api/pipelines/{pid}/versions/update`

### experiments

- `DELETE /api/experiments/{eid}`
- `DELETE /api/samples/{sid}`
- `GET    /api/experiments`
- `GET    /api/experiments/{eid}`
- `GET    /api/experiments/{eid}/export`
- `PATCH  /api/samples/{sid}`
- `POST   /api/experiments`
- `POST   /api/experiments/detect-pairs`
- `POST   /api/experiments/{eid}/duplicate`
- `POST   /api/experiments/{eid}/import-samplesheet`
- `POST   /api/experiments/{eid}/samples`
- `POST   /api/experiments/{eid}/samplesheet`
- `POST   /api/experiments/{eid}/validate`
- `PUT    /api/experiments/{eid}`
- `PUT    /api/experiments/{eid}/samples`

### data

- `DELETE /api/datasets/roots/{name}`
- `GET    /api/datasets`
- `GET    /api/datasets/browse`
- `GET    /api/datasets/download`
- `GET    /api/datasets/preview`
- `GET    /api/datasets/roots`
- `GET    /api/datasets/roots/check`
- `GET    /api/datasets/roots/folders`
- `GET    /api/datasets/search`
- `PATCH  /api/datasets/roots/{name}`
- `POST   /api/datasets`
- `POST   /api/datasets/mkdir`
- `POST   /api/datasets/roots`
- `POST   /api/datasets/roots/folders`

### explore

- `GET    /api/explore/columns`
- `GET    /api/explore/de`
- `GET    /api/explore/de/export`
- `GET    /api/explore/hubs`
- `GET    /api/explore/info`
- `GET    /api/explore/raw`
- `GET    /api/explore/table`
- `HEAD   /api/explore/raw`
- `POST   /api/explore/de/save`

### projects

- `DELETE /api/projects/{pid}`
- `DELETE /api/projects/{pid}/items/{item_id}`
- `GET    /api/projects`
- `GET    /api/projects/{pid}`
- `PATCH  /api/projects/{pid}`
- `POST   /api/projects`
- `POST   /api/projects/{pid}/items`

### runs

- `GET    /api/jobs`
- `GET    /api/runs`
- `GET    /api/runs/{rid}`
- `GET    /api/runs/{rid}/files/{name}`
- `GET    /api/runs/{rid}/log`
- `GET    /api/runs/{rid}/stream`
- `POST   /api/runs`
- `POST   /api/runs/{rid}/cancel`
- `POST   /api/runs/{rid}/resume`

### results

- `GET    /api/results`
- `GET    /api/results/{rid}`
- `GET    /api/results/{rid}/file`

### cluster

- `DELETE /api/discovery/tokens/{tid}`
- `GET    /api/allocations/presets`
- `GET    /api/discovery/config`
- `GET    /api/discovery/ssh-key`
- `GET    /api/discovery/tokens`
- `GET    /api/nodes`
- `GET    /api/nodes/{nid}`
- `GET    /api/nodes/{nid}/condor-config`
- `GET    /api/nodes/{nid}/metrics`
- `GET    /api/nodes/{nid}/ssh-enroll`
- `PATCH  /api/nodes/{nid}`
- `POST   /api/allocations/apply-preset`
- `POST   /api/allocations/placement`
- `POST   /api/discovery/scan`
- `POST   /api/discovery/ssh-key`
- `POST   /api/discovery/tokens`
- `POST   /api/nodes/manual`
- `POST   /api/nodes/{nid}/ssh-enroll`
- `POST   /api/nodes/{nid}/transition`
- `PUT    /api/allocations/{nid}`

### agent

- `GET    /api/agent/speedtest`
- `POST   /api/agent/discovery-report`
- `POST   /api/agent/enroll`
- `POST   /api/agent/heartbeat`
- `POST   /api/agent/speedtest`

### studio

- `DELETE /api/studio/modules/{mid}`
- `DELETE /api/studio/workflows/{wid}`
- `GET    /api/studio/module-skeleton`
- `GET    /api/studio/module-templates/{key}`
- `GET    /api/studio/modules`
- `GET    /api/studio/modules/{mid}/export`
- `GET    /api/studio/tools/check`
- `GET    /api/studio/tools/scan`
- `GET    /api/studio/workflows`
- `GET    /api/studio/workflows/{wid}`
- `POST   /api/studio/compile`
- `POST   /api/studio/export`
- `POST   /api/studio/modules`
- `POST   /api/studio/modules/check`
- `POST   /api/studio/validate`
- `POST   /api/studio/workflows`
- `POST   /api/studio/workflows/{wid}/publish`
- `PUT    /api/studio/modules/{mid}`
- `PUT    /api/studio/modules/{mid}/visibility`
- `PUT    /api/studio/workflows/{wid}`
- `PUT    /api/studio/workflows/{wid}/visibility`

### assistant

- `DELETE /api/assistant/history/{rid}`
- `GET    /api/assistant/history`
- `GET    /api/assistant/history/{rid}`
- `GET    /api/assistant/status`
- `POST   /api/assistant/ask`
- `POST   /api/assistant/build`
- `POST   /api/assistant/draft-module`
- `POST   /api/assistant/history/{rid}/saved`
- `POST   /api/assistant/review`
- `POST   /api/assistant/test`
- `PUT    /api/assistant/config`

### references

- `GET    /api/references/browser-genome`
- `GET    /api/references/genomes`
- `GET    /api/references/resolve`
- `GET    /api/references/status`
- `POST   /api/references/suggest`
- `PUT    /api/references/config`

### system

- `GET    /api/activity`
- `GET    /api/dashboard`
- `GET    /api/events`
- `GET    /api/health`
- `GET    /api/settings`
- `POST   /api/settings/refresh-tools`
- `PUT    /api/settings/ui`
