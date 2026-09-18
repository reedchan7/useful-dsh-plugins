# @reedchan7/dsh-cost

English | [中文](README_CN.md)

Estimated DeepSeek API cost in DSH's stats row under the composer: the current session, the current
turn, and today across every project on this machine.

## What it shows

| Where            | What                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stats row pill   | `¥ Cost ¥9.68` — today across every project, on the same line as the shipped turn, speed, token and cache figures; the tooltip and the panel carry the session and turn                                                                 |
| Panel (click it) | Today's hourly chart, session totals, cache-hit share, current turn, per-turn bars, per-model breakdown, cost composition, rate period with a countdown to the next change, the account-level (all devices) section, and the scope note |

The plugin registers on `conversation.composer.dock` — the ambient row under the composer where DSH
renders its own stats pills — so the theme, font size and language all follow the GUI without
touching the shipped UI. That slot draws one row per registered entry and the shipped stats row
declares no child slot, so the entry renders the pill into the shipped row itself, keyed on the
`data-composer-stats` marker DSH's composer already carries, and renders it in its own row if that
marker is ever absent. Like the shipped pills, it appears once the session has billed a token.

## Install

```sh
# from this checkout (development)
make install

# or from a pinned tag, without publishing to npm
make install PLUGIN='github:reedchan7/useful-dsh-plugins#v0.1.0'
```

Restart `dsh web` and hard-refresh the browser. Restarting alone does not rebuild: a change under
`src/` reaches the browser only after `make build` (or `make reinstall`, which builds and links).

## Pricing model

- **Two published price books.** CNY and USD are independent published lists; the plugin never
  converts between them. Which one prices your figures is the account's choice, set on the plugin's
  composition row (`- id: dsh-cost` with `config: { currency: USD }`); the host prices with it and
  both routes report it, so the browser half never assumes one.
- **Peak and off-peak.** The provider's windows are 09:00–12:00 and 14:00–18:00 Beijing time on
  weekdays, at twice the off-peak rate. Weekends bill at the off-peak rate all day. The panel shows
  the current period and a countdown to the next change **in your local time**.
- **Price generations.** Rates changed on 2026-08-17 (peak/off-peak introduced) and 2026-09-10
  (V4.1-Flash prices). Each usage sample is priced with the generation in force at the sample's own
  timestamp, so a session that spans a price change keeps its historical rates.
- **Unknown models are reported, not billed at zero.** A model missing from the price book shows as
  "unpriced" and turns the pill amber, because a silent zero is a cost display that lies. The day
  total carries its own unpriced list as well: it covers sessions you never opened, so a total that
  is short by one of them has to say so.
- **The cost composition is priced per attempt**, with each attempt's own model and billing period,
  so "what you paid for" adds up to the session total above it.
- Every figure is an **estimate** derived from provider-reported token usage, not a bill. The price
  list carries the date it was captured, and re-verifying it against the published pricing page is a
  release step (see the header comment in `lib/cost-core/src/pricing.ts`).

## Account-level usage (all devices)

The figures above are computed from this machine's session logs — they cannot see the account being
used on your other devices, while the invoice covers all of them. With a platform token configured,
the panel gains an **Account · all devices** section: the settled cost of the billed day (Beijing
time, matching the invoice), token totals, and the data's timestamp, straight from the platform's
own usage endpoints (`platform.deepseek.com/api/v0/usage/by_api_key/{amount,cost}`). These are the
platform's actuals, not estimates, and they settle with a delay — expect them to differ from the
machine-level figures, with the difference being your other devices.

Setup: open the cost panel and the account section walks you through it — on any device signed in
to <https://platform.deepseek.com/usage> (the DSH machine itself needs no browser session), run the
console snippet it shows, paste the result into the panel, and save. The host validates the token
against the platform before persisting it to `$DSH_HOME/dsh-cost-platform-token` (mode `0600`;
writing that file by hand also works, and is the way in for a headless host). The token is the web
console's session token — the `sk-` API key is rejected by these endpoints — and it never leaves the
host: the routes report figures and status codes only. The platform is asked at most once every five
minutes, in the background; a failed refresh keeps the last good figures and names the failure.

## Scope and limitations

- **Today** covers every project on this machine and includes finished sessions. Three sources are merged: the live
  session registry (turns that have not reached disk yet); a draining set of sessions the registry
  already dropped whose checkpoint flush has not landed yet — the store buffers a session's events
  and writes them at a checkpoint, so the on-disk log can lag the end of a session by an hour or
  more, and these sessions keep counting from the fold that watched them until the log demonstrably
  covers it; and the durable session store under `$DSH_HOME/sessions`, which is read per project
  directory, decompressed, folded, and cached by modification time. The day boundary follows your
  timezone.
- A session that is only open in the browser and no longer live in the host process reports
  `not-live` for its session detail; the day total is unaffected.
- A session log this build cannot read is **counted and shown** in the panel footer rather than
  skipped in silence.
- The machine-level total is priced with the published list, so it is an estimate: the provider's
  own billing view remains the authority, and the account-level section is that view.

## Routes

Both routes are exact paths on the DSH host and reject anything that is not a loopback request:

| Route                                          | Returns                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /api/dsh-cost/summary?session=&tz=&lang=` | Session, turn, and today totals with per-turn, per-model and composition breakdowns, plus the account-level block |
| `GET /api/dsh-cost/config`                     | The price book in force, the billed timezone, and the peak windows                                                |

`currency=CNY|USD` overrides the configured book for one request.

## Development

```sh
make build          # emit plugins/dsh-cost/lib/{index.js,client.js}
make test           # library tests plus the client-bundle contract test
make reinstall      # re-link after a rebuild, then restart dsh web
```
