# Connecting real mail, calendars and tasks

Bouncer runs on demo data until you connect something. Each connector below takes 5 to 10 minutes to set up.

**How your data moves**

- **Gmail, Google Calendar, Google Tasks, Outlook and Microsoft To Do** go straight from Google or Microsoft to your browser tab. Our server never sees the mail or the OAuth token.
- **Tokens stay in memory only.** They are never written to localStorage and never sent to our server, so reloading the page signs you out. That is deliberate.
- **Every scope is read-only.** Bouncer never sends, changes or deletes anything.
- **Claude sees only short item text.** The only data that reaches our server's `/api/score` (Claude) is the short text of each item: subject, sender and snippet.
- **ICS links and Todoist go through a small proxy.** Calendar servers and Todoist block direct browser calls (CORS), so these pass through `/api/ics` and `/api/todoist`. The proxy forwards them without storing or logging anything. An uploaded `.ics` file never leaves your browser.

You need these two values in the environment. Neither is a secret, because both are sent to every browser.

| Variable           | Where it comes from                    |
|--------------------|----------------------------------------|
| `GOOGLE_CLIENT_ID` | Google Cloud, section 1 below          |
| `MS_CLIENT_ID`     | Microsoft Entra, section 2 below       |

- **Locally:** put them in a `.env` file in the repo root, for example `GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com`. Then restart with `npm start`.
- **On Vercel:** go to Project, then Settings, then Environment Variables. Add both variables and redeploy.

If a variable is missing, its button shows "Needs setup: see docs/CONNECTORS_SETUP.md".

Throughout this guide, `https://<app>.vercel.app` stands for your **production** Vercel domain. Preview URLs change with every deploy, so don't use them.

---

## 1. Google: Gmail, Google Calendar and Google Tasks

1. **Create a project**
   1. Open <https://console.cloud.google.com/> and sign in with the Google account you will demo with.
   2. Click the project picker in the top bar, then **New project**.
   3. Name it `Bouncer`, then click **Create**.
   4. Make sure the picker now shows **Bouncer**.
2. **Enable the three APIs**
   1. Open the menu (☰), then **APIs & Services**, then **Library**.
   2. Search for **Gmail API**, open it and click **Enable**.
   3. Do the same for **Google Calendar API** and **Google Tasks API**.

   If you skip one, Bouncer later shows "The ... API is not enabled". It names the API you need to enable.
3. **Branding** (the consent screen)
   1. Open the menu (☰), then **Google Auth Platform**. You can also type "Google Auth Platform" in the search bar.
   2. Click **Get started**.
   3. Under **App information**, set the App name to `Bouncer` and pick your own email as the User support email. Click **Next**.
   4. Under **Audience**, choose **External** and click **Next**.
   5. Under **Contact information**, enter your email and click **Next**.
   6. Tick the agreement, then click **Continue** and **Create**.
4. **Audience: add test users** (do not skip this)
   1. In Google Auth Platform, click **Audience**.
   2. Leave the Publishing status as **Testing**.
   3. Under **Test users**, click **+ Add users** and enter every Google address that will sign in: yours, your teammates' and the demo account's. Then click **Save**.
   4. **Only test users can sign in.** Anyone else gets "Error 403: access_denied".
5. **Data Access: the scopes**
   1. Click **Data Access**, then **Add or remove scopes**.
   2. Paste these three into **Manually add scopes**. Alternatively, filter for each one and tick it.
      ```
      https://www.googleapis.com/auth/gmail.readonly
      https://www.googleapis.com/auth/calendar.readonly
      https://www.googleapis.com/auth/tasks.readonly
      ```
   3. Click **Add to table**, then **Update**, then **Save**.

   Gmail read-only is a "restricted" scope. That's fine in Testing mode. Google's verification review only applies if you publish the app to everyone.
6. **Clients: the Web client ID**
   1. Click **Clients**, then **+ Create client**.
   2. Set the Application type to **Web application** and the Name to `Bouncer web`.
   3. Under **Authorized JavaScript origins**, click **+ Add URI** twice and enter:
      - `http://localhost:3000`
      - `https://<app>.vercel.app`

      Use no trailing slash and no path.
   4. Leave **Authorized redirect URIs** empty. The token popup doesn't need one.
   5. Click **Create**, then copy the **Client ID**. It ends in `.apps.googleusercontent.com`.
7. **Set `GOOGLE_CLIENT_ID`** in `.env` and in your Vercel environment variables, then restart or redeploy.

**What signing in looks like:**

1. Click **Connect Gmail + Google Calendar** and pick your account.
2. Google shows **"Google hasn't verified this app"**. That's expected in Testing mode. Click **Advanced**, then **Go to Bouncer (unsafe)**, then **Continue**.
3. Tick **all three** checkboxes on the consent screen. If you untick one, Bouncer skips that source and tells you.

**Troubleshooting:**

| What you see | What to do |
|---|---|
| `origin_mismatch` or "not a valid origin" | Add the exact origin from your address bar under Authorized JavaScript origins. New origins can take up to 5 minutes to start working. |
| `access_denied` | The account isn't a test user. Add it under Audience, then Test users. |
| "The popup was blocked" | Allow popups for the site in the address bar, then click Connect again. |
| "Sign-in expired" | Tokens last about 1 hour. Click Connect again. |

---

## 2. Microsoft: Outlook / Microsoft 365 (mail, calendar, To Do)

1. **Create the app registration**
   1. Open <https://entra.microsoft.com/>, then **Identity** (or **Entra ID**), then **App registrations**, then **+ New registration**.
   2. You can also get there from portal.azure.com: Microsoft Entra ID, then App registrations.
2. **Fill in the registration form**
   1. **Name:** `Bouncer`
   2. **Supported account types:** choose **"Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)"**.
   3. **Redirect URI:** set the platform dropdown to **Single-page application (SPA)** and the URI to `http://localhost:3000`.
   4. Click **Register**.
3. **Add the production redirect URI**
   1. Open **Authentication** in the left menu.
   2. Under **Single-page application**, click **Add URI** and enter `https://<app>.vercel.app`.
   3. Leave both "Implicit grant" checkboxes **unticked**. MSAL uses the authorization code flow with PKCE.
   4. Click **Save**.

   Both URIs must be the bare origin: no path and no trailing slash. The sign-in popup returns to the app page, and the page passes the result back to the main window and closes the popup.
4. **API permissions**
   1. Click **+ Add a permission**, then **Microsoft Graph**, then **Delegated permissions**.
   2. Tick **Mail.Read**, **Calendars.Read** and **Tasks.Read** (for Microsoft To Do). **User.Read** is already listed.
   3. Click **Add permissions**.

   You do **not** need "Grant admin consent" for personal accounts. Each user consents for themselves on first sign-in.
5. **Copy the client ID.** Open **Overview** and copy the **Application (client) ID**, which is a GUID. Set it as `MS_CLIENT_ID` in `.env` and on Vercel, then restart or redeploy.

**What signing in looks like:**

1. Click **Connect Outlook** and sign in.
2. Accept the permissions screen: read your mail, read your calendars, read your tasks, and sign you in.

**Good to know:**

- **School and work tenants are often locked down.** Two things can go wrong:
  - **The tenant may block app registration.** The New registration button is disabled, or you get "You do not have access". In that case, register the app under a personal account or another tenant. Personal Outlook.com accounts can still *sign in* to an app registered elsewhere.
  - **The tenant may require admin consent.** Sign-in stops at "Need admin approval" or `AADSTS65001`/`AADSTS90094`. Ask IT to approve, or demo with a personal Outlook.com account.
- **The portal may say your account isn't in a directory.** If so, create a free Microsoft Entra tenant first, for example by signing up for a free Azure account. App registrations themselves cost nothing.
- **`AADSTS50011` (redirect URI mismatch)** means the origin in your address bar isn't listed under Authentication, then Single-page application.
- **To Do is best-effort.** If it fails, mail and calendar still load and the status line says "To Do skipped".

---

## 3. Any calendar by ICS link (or .ics file)

Paste the link into **ICS calendar link** and click **Connect**. Bouncer shows what is left of today. `webcal://` links work too.

**ICS links are secrets.** Anyone with the link can read the calendar. Bouncer doesn't store the link, and the proxy never logs it.

**Google Calendar**

1. Open calendar.google.com.
2. Click the gear (⚙), then **Settings**.
3. In the left column under **Settings for my calendars**, click your calendar.
4. Scroll to **Integrate calendar** and copy **Secret address in iCal format**. It ends in `/basic.ics`.
5. Do *not* use the "Public URL", which is a web page.
6. Some Google Workspace admins hide the secret address. If yours is missing, use Connect Gmail + Google Calendar instead.

**Outlook.com / Outlook on the web**

1. Click the gear (⚙), then **Calendar**, then **Shared calendars**.
2. Under **Publish a calendar**, pick the calendar and choose **Can view all details**.
3. Click **Publish** and copy the **ICS** link, not the HTML one.

**iCloud**

1. On icloud.com/calendar, or in the Calendar app on iPhone or Mac, open the share options for the calendar. On iPhone, tap the (i) next to the calendar.
2. Turn on **Public Calendar** and copy the link. It starts with `webcal://`.
3. Note that this makes the calendar readable by anyone with the link.

**Fastmail**

1. Go to **Settings**, then **Calendars**.
2. Click the calendar, then **Edit & share** (or **Sharing**).
3. Enable public sharing or publishing with **full event details**, then copy the iCalendar (`.ics`) URL.

**Proton Calendar**

1. Go to **Settings**, then **Calendars**, then pick the calendar.
2. Click **Share**, then **Share with anyone**.
3. Create a link with **Full view** and copy it.

**Offline alternative.** Export an `.ics` file from any calendar app and pick it with **upload .ics**. The file is read entirely in your browser.

**What the ICS reader handles:**

- time zones (including Outlook's Windows zone names)
- all-day events
- cancelled events and excluded dates
- simple daily and weekly repeats

More complex repeats, such as "second Monday of the month", appear only on their first date.

---

## 4. Todoist

1. Open todoist.com (or the app) and click your avatar.
2. Go to **Settings**, then **Integrations**, then **Developer**.
3. Under **API token**, click **Copy API token**.
4. Paste it into **Todoist API token** and click **Connect Todoist**.

The token is sent once in a request header to `/api/todoist`, which forwards it to Todoist's API v1 (`https://api.todoist.com/api/v1/tasks`). It is never stored or logged, and the input field clears after connecting.

To revoke it, use **Issue a new API token** on the same page.

---

## Demo-day tips

- **Sign in about 10 minutes before you go on stage.** Access tokens last about **1 hour**.
- **Don't reload the page after connecting.** Tokens live in memory only, so a reload signs you out by design. If it happens, just click Connect again.
- **Allow popups for both origins ahead of time.** Do this for `localhost:3000` and your Vercel domain.
- **Google is in Testing mode, so only test users can sign in.** Add the demo account, plus any judge who wants to try it, under Audience, then Test users.
- **Expect the "Google hasn't verified this app" screen.** Know the clicks: Advanced, then Go to Bouncer, then Continue.
- **For Microsoft, demo with a personal Outlook.com account.** Work and school tenants may need admin consent.
- **Check both origins.** Make sure the deployed domain is listed in the Google client (JavaScript origins) *and* in the Entra app (SPA redirect URIs). This is the most common demo-day failure.
- **Use a demo mailbox on the projector.** Real inbox subjects will be on a big screen.
- **Keep a fallback ready.** Have a `.ics` export on the laptop and know where **Reset demo** is, in case the venue Wi-Fi blocks OAuth popups.
