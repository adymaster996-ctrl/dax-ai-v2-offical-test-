# Dax AI v1 — installable AI chat powered by Gemini

A mobile-friendly, installable chat app with accounts, guest mode and saved chats, powered by Google Gemini (free tier works for chat).

## Requirements

- Node.js 20 or newer
- A free Gemini API key from https://aistudio.google.com/

## Run locally

1. Unzip the project.
2. Copy `.env.example` to `.env` and add your `GEMINI_API_KEY` and a long random `SESSION_SECRET`.
3. Run `npm install`, then `npm start`.
4. Open `http://localhost:3000`.

## Features

- **Accounts and guests:** Log in, Sign up, or Continue as guest. Guests get `GUEST_DAILY_LIMIT` messages a day, accounts get `USER_DAILY_LIMIT`. Passwords are hashed.
- **Saved chats:** accounts save chats on the server (they follow you across devices); guests save them in that browser.
- **Installable:** works as an app on phones and computers (see below).
- **Response styles:** Balanced, Casual, Detailed, Concise.
- **Google Search grounding** for current facts (turn off with `GEMINI_GROUNDING=false` if your model doesn't support it).

## Install it as an app (PWA)

Browsers only allow installing from **HTTPS** (or `localhost`), so deploy it first.

- **Android / Chrome / Edge / desktop:** open the site, then tap **Install app** in the sidebar (or the browser's install icon).
- **iPhone / iPad:** open the site in Safari, tap Share, then **Add to Home Screen**.
- **APK for Android:** once the site is live on HTTPS, paste its link into https://www.pwabuilder.com/ and download the Android package.

## Free tier notes

- Google's free tier has its own daily and per-minute caps, and they can change. When they're hit, the app shows a friendly "try again in a few minutes" message. Keep the daily limits in `.env` modest.
- On the free tier, Google may use your prompts to improve its products, so don't put anything private into the app.

## Deploy

Deploy to a Node.js host that supports environment variables (Render, Railway, Fly.io). Set `GEMINI_API_KEY` and `SESSION_SECRET` in the host's dashboard.

Accounts and chats are stored in `DATA_DIR` (`data/` by default). Many free hosts wipe the disk on restart, so use a persistent disk and point `DATA_DIR` at it, or accounts and chats will disappear. Daily limits are kept in memory and reset on restart.

AI output may be incorrect. Verify important facts and calculations.
