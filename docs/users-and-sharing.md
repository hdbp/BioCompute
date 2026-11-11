# Users and sharing

Every person gets their own account. The first administrator is created at first run; administrators add
others in **Settings → Users** as:

* **viewer**: can browse results;
* **scientist**: can build and run;
* **admin**: also manages users, data folders and computers.

## Getting an account

* **First run:** the very first visitor creates the administrator account (see *First run* in
  `docs/deployment.md`).
* **Request an account** (sign-in page): a newcomer picks a username and password and can add a note
  (who they are). The account cannot sign in until an administrator approves it in **Settings → Users** and
  chooses a role, or declines it. Admins also see a dashboard alert for waiting requests. Turn the link off there
  if only invited people should get in.
* **Invite links** (Settings → Users): pick a role and how long the link stays valid (1 to 30 days). The link
  works once; whoever opens it chooses their username and password and is signed in immediately. Only a hash of
  the link is stored, open links can be revoked, and used ones show who joined. Set `BIOCOMPUTE_PUBLIC_URL`
  (e.g. `http://lab-ws.tailnet-name.ts.net:8045`) so links use an address others can reach, not `localhost`.
* **Created by an administrator** (Settings → Users → *Add user*, or `python -m app.cli reset-password <name> --create`):
  you set the initial password and pass it on; the person can change it in Settings → Preferences.

There is no open sign-up: every account is either approved, invited or created by an administrator.

## Your own pipelines

Each pipeline, Studio workflow and custom module has an **owner** (who created, imported or published it) and
a **visibility**:

| | Who sees it | Who can change or delete it |
|---|---|---|
| **Private** (default for anything you create) | you and administrators | you and administrators |
| **Shared with the lab** | everyone with an account: they can open, run and copy it | you and administrators |
| No owner (nf-core catalog, bundled examples, items from before this feature) | everyone | scientists, as before |

* **Pipelines → Mine** shows only yours. Cards show *Private*, *Shared with the lab* or *Shared by alice*.
* **Share or unshare:**
  * *Share with lab* / *Make private* on the pipeline page or the Studio toolbar.
  * In the module library, the people icon on your own modules.
* **Studio workflows:** sharing one also shares the private modules it uses (others could not open it otherwise)
  and the pipeline published from it.
* **Someone else's shared pipeline:**
  * *Make my own copy* on its page gives you a private copy you can change.
  * In Studio their workflow opens **read-only**, and *Save a copy* saves your changes as your own workflow.
* **Importing:** you choose *Only me* or *Everyone in the lab*. A private install of a catalog pipeline leaves the
  catalog entry in place for others.
* **Favorites** (stars) and saved Studio drafts are per person. Parameter presets on a shared pipeline belong to whoever saved them.

Runs, results, experiments and data folders are shared by the lab as before. The audit log (Settings, admins)
records who shared or unshared what.
