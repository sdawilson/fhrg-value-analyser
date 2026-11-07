# Moving Value Analyser to a Magic Container

About 45 minutes, in seven parts. Each part ends with something you can check. Nothing here needs a command line.

The toolkit keeps using the same storage and the same database, so nothing is copied and nothing is lost. The old Edge Script keeps running until Part 7, so members aren't affected until then, and you can go back at any point.

Keep a private note open as you go (in your password manager, ideally). **Never put the values in a document, email or chat.**

> **Don't press "Regenerate Tokens" in Bunny Database.** It cancels the tokens of every database in the account, which would stop the website and the other tools signing anyone in. "Generate Tokens" is the safe one, and it's the only one you need.

---

## Part 1. Merge the pull request

1. In GitHub, open **sdawilson/fhrg-value-analyser → Pull requests**, open the pull request, and click **Merge**.
2. Open the **Actions** tab. A run called **Build and deploy** starts by itself. Wait for the green tick (about 3 minutes).
3. On the repository's main page, under **Packages** on the right, open `fhrg-value-analyser`. Choose **Package settings → Change visibility → Public**. The image holds no keys or passwords, so it's safe to make public, and bunny.net can then fetch it without a GitHub password.

✔ **Check:** the `fhrg-value-analyser` package page shows a tag called `latest`.

---

## Part 2. Gather the settings

In bunny.net, open **Edge Scripting**, then the Value Analyser script, then its environment settings. Note the values of these, if they're there:

- `STORAGE_ZONE`
- `STORAGE_HOST`
- `ROOT_FOLDER`
- `SITE_ADMINS`
- `KEEP_VERSIONS`, `MIN_PEERS` and `MAX_UPLOAD_MB`

You also need two secrets:

- **STORAGE_ACCESS_KEY:** open **Storage**, then that storage zone, then **FTP & API Access**, and copy the main **Password**. Not the read-only one, because the toolkit saves files.
- **SESSION_SECRET:** in your password manager, generate a new random password, **64 characters, letters and numbers only**. Don't reuse the website's. This is the one deliberate change: the toolkit stops sharing a secret with the website.

---

## Part 3. The container

1. In bunny.net, go to **Magic Containers → + Add App**.
2. **Image:** `ghcr.io/sdawilson/fhrg-value-analyser`, tag `latest`.
3. **Endpoints:** add one, **+ CDN**: name `value-analyser`, container port **8080**.
4. **Persistent volumes:** none.
5. **Environment variables:** choose **Raw editor** and paste these lines, with your values after each `=`. Leave a line out if it wasn't set on the script, apart from the first four.

```
STORAGE_ZONE=
STORAGE_ACCESS_KEY=
SESSION_SECRET=
SITE_ADMINS=s.wilson@provingservices.co.uk
STORAGE_HOST=
ROOT_FOLDER=
KEEP_VERSIONS=
MIN_PEERS=
MAX_UPLOAD_MB=
```

6. **App name:** `fhrg-value-analyser`. **Region:** London (or the nearest UK region offered).
7. Click **Deploy**.
8. After it starts, open **Regions and Scaling** and set it to **exactly one instance** (minimum 1, maximum 1).

It will say two settings are missing until Part 4. That's expected.

---

## Part 4. The database

1. In bunny.net, open **Database**, then the FHRG website's database, then **Access**.
2. Click **Generate Tokens**. It adds new tokens and leaves the existing ones working. Don't click Regenerate Tokens.
3. Click **Add Secrets to Magic Container App** and choose `fhrg-value-analyser`. This sets `BUNNY_DATABASE_URL` and `BUNNY_DATABASE_AUTH_TOKEN` for you.
4. If the app doesn't restart by itself, open it and click **Update Container**.

✔ **Check:** open the endpoint's address (bunny.net shows it) and add `/health`. It should say `{"ok":true}`. In **Logs**, the toolkit says `all required settings are present`.

If the log says **required settings missing**, bunny.net may have dropped that setting because of an invisible character copied into its *name*. Delete the row, add it again with **+ Add New Variable**, **typing the name by hand**, and click **Update Container**.

---

## Part 5. Automatic updates

From now on, every change Claude makes reaches the container by itself.

1. In Magic Containers, open the app. Note its **App ID** and the container's name.
2. In GitHub, open **sdawilson/fhrg-value-analyser → Settings → Secrets and variables → Actions**:
   - under **Variables**, add `APP_ID` (the App ID) and `CONTAINER_NAME` (the container's name)
   - under **Secrets**, add `BUNNYNET_API_KEY` (your bunny.net account API key: the same one Clarion uses)

✔ **Check:** in the **Actions** tab, open **Build and deploy → Run workflow**. It ends with a green tick, including the step **Update the app on Magic Containers**.

---

## Part 6. A first try, on the container's own address

This uses your real data, and the old address is still working alongside it.

1. Open the endpoint's address and sign in with your FHRG email and password.
2. Check that your assessments are listed, and open one.
3. On **Templates**, check that the FHRG templates are there.
4. Make a new assessment called `Container test`, answer a factor or two, and click **Save**.
5. Reload the page. Your answers should still be there.
6. Under **More**, download the `.va2` file.
7. Open **Admin**. The set-up checks should show no problems.
8. Delete `Container test`.

If anything looks wrong, stop here and tell Claude. Nothing has changed for members.

---

## Part 7. The address

Choose a quiet time. The toolkit may be unavailable for a few minutes while this takes effect. Everyone will need to sign in again once.

1. In **CDN**, open the old pull zone (the one named after the script) **→ Hostnames**, and remove `value-analyser.fhrg.co.uk`.
2. Open the container endpoint's pull zone **→ Hostnames**, and add `value-analyser.fhrg.co.uk`.
3. Where fhrg.co.uk's DNS is managed, change the `value-analyser` **CNAME** record to point to the new pull zone's `b-cdn.net` address (bunny.net shows the exact value).
4. Back in the new pull zone, click to verify and issue the free certificate, then turn on **Force SSL**.

✔ **Check:**
- https://value-analyser.fhrg.co.uk/health says `{"ok":true}`.
- Sign in at https://value-analyser.fhrg.co.uk and open an assessment.

Tell Claude when you've done step 3, and it can check that the record has changed.

---

## Going back, and tidying up

**To go back:** reverse Part 7. Move the hostname back to the old pull zone and put the CNAME record back. The script and the container use the same storage and database, so anything saved on either is kept.

**After a week with no problems:** delete the old Edge Script and its pull zone, and delete `index.html` from the storage folder. The page now travels in the container.

---

## From now on

- **Updates:** Claude makes each change on GitHub as a pull request. You read the summary and click **Merge**; it's live about five minutes later.
- **Keep it to exactly one instance** (Regions and Scaling: minimum 1, maximum 1).
- **Type setting names by hand** when you add one, then click **Update Container**.
- **Leave the pull zone's caching settings as they are.** The toolkit tells it not to keep private pages; an override could make it keep them.
- **FHRG templates:** add them on the Templates page, or put `.vt2` files in the storage folder `templates/fhrg/`, then open **Admin → Templates**. Ending a file's name in `(Default)` makes it the default for its type. A file with the same name replaces the template, and the toolkit reads it next time it's opened.
- **Which level a template is for:** open the template, then tick the levels under **Where it can be used**.
- **Services:** templates and assessments are for a service, Highways to start with. Add the FHRG's other services under **Admin → Templates → Services**. An authority can also add its own when it copies a template.
- **A template for another service or level:** on the Templates page, choose **Copy**, pick the service and levels, and tick **Move it** to hide the original once the copy is saved. Check the list of names it changed, then tailor and save.
- **The function templates:** the FHRG's 30 function templates (value for money and carbon for each standard function) are added like any FHRG template: upload the `.vt2` files to `value-analyser/templates/fhrg/` in the storage zone, then open **Admin → Templates**, which picks them up. Each says which function it's for, so it's offered only there.
- **The organisation map:** each authority's map starts itself the first time someone opens **Organisation**: the authority, a Highways service and the 15 standard highways functions. Anyone from the authority can add, rename, weight and reorder items and fill in their facts; only the lead, or whoever added an item, can remove it. The FHRG's seven standard facts are set in the toolkit; an authority adds its own on the map. Clicking an item shows its assessments: open one, start one there (only templates set for that level and service are offered), put one you have there, or take one off. For an assessment to go on a function or process, its template's levels must include that level (set in the template editor). The FHRG's function templates are for function and process level.
- **The demonstration:** anyone can open `/demo` without an account. It uses Northbridge, a fictional authority, runs in the browser and saves nothing. To turn it off, add a variable `DEMO` set to `off` and click **Update Container**.

---

## If something isn't right

- **"The toolkit is not set up yet":** the page names the missing setting. Add it and click **Update Container**.
- **Saving fails with a storage message:** `STORAGE_ACCESS_KEY` may be the read-only password.
- **Saving fails with a database message:** the database token may be read-only. Repeat Part 4.
- **"The toolkit's database has no FHRG accounts yet":** Part 4 was done on a different database. It must be the FHRG website's.
- **No assessments appear after signing in:** `ROOT_FOLDER` or `STORAGE_ZONE` may differ from the script's, or it's the wrong database.
