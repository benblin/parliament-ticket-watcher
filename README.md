# Parliament ticket watcher

Checks the Hungarian Parliament visit on [jegymester.hu](https://jegymester.hu/production/480000/hungarian-parliament-building-parliament-visit)
for open slots on 22, 23 and 27 December 2026 and sends a Telegram message as soon as one appears.

- Runs on GitHub Actions: each run checks every 3 minutes for 50 minutes, then starts the next run. A 30-minute cron restarts the chain if it ever stops.
- Opens the page in a headless browser, picks each date in the calendar, and reads the slot status the page shows.
- Stops by itself after 27 December 2026.
- `state.json` remembers which slots were already announced, so you get one message per opening.

## Setup
1. Create a Telegram bot with @BotFather and press **Start** on it.
2. Add the bot token as the repository secret `TELEGRAM_BOT_TOKEN`.
3. Run the workflow once by hand with **test_alert** ticked to check you get the message.

Change the dates with the `DATES` env var (`2026-12-22,2026-12-23,2026-12-27` by default).
