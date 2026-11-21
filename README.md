# piko.pos

A POS that lives on one Windows PC in the cafe. It is used straight from that PC, or from phones over the cafe Wi-Fi.
No cloud, no monthly fee, and it keeps working when the internet is down.

## Run it now (any computer with Node 22.16 or newer)

```
npm start
```

Then open the address it prints. The first screen asks you to create the owner account.
The web app is already built in `web/dist`, and the server has no dependencies, so there is nothing to install.

For development on a fixed port: `npm run dev` (port 8080). Data goes to `./data`. Delete that folder to start fresh.

To see bar tickets without a printer: Manager, Settings, Printer, "Save to files (testing)". Tickets appear in `data/tickets`.

## What is tested and what is not

**Tested here, for real:**

- The server, with 22 automated tests (`npm test`). They cover the plan's test list: repeated sends, two waiters on one table,
  six devices at once, printer off and LATE tickets, COPY reprints, skipping a ticket, the 2 minute cancel window, split bills,
  on the house, discount, sold out, move, merge, moving items, floats, payouts, settlement during service, day close rules,
  backup and restore, catch up mode, restart with logins intact, clock guard, PIN lockout, QR code, owner reset.
- The web app, driven in a real Chrome at phone size and PC size: first run, login, ordering, extras and notes, sending,
  split payment with change, the shared PC returning to the name list, and every manager tab.

**Written but NOT tested, because it needs Windows and real hardware:**

- `desktop/` (the Electron shell: window, tray, start with Windows, quit with PIN) and the installer config.
- Printing to a real thermal printer. Network printing was tested against a fake printer on port 9100.
  The Windows USB mode (writing to a shared printer) has never touched a real printer.
- Paper out detection. It depends on the printer answering a status request, and many cheap ones do not.

Treat those three as the first things to check on a real Windows PC with the real printer.

## Build the Windows installer

On a Windows PC with internet:

```
npm install
npm install --save-dev electron electron-builder
npm run dist
```

`npm run dist` builds the web app, downloads the pinned Node into `vendor/node/node.exe`, and produces the installer in `release/`.
The app icon (`desktop/icon.ico`) and tray icon (`desktop/tray.png`) are included. Replace them with your own design any time.
The exe is unsigned, so Windows SmartScreen will warn on first run: More info, then Run anyway.

To try the desktop shell without building an installer: `npx electron desktop/main.cjs`.

## Where things are

```
server/src/index.js        entry: http server, static files, port 80 with 8080 as fallback
server/src/routes.js       every API route
server/src/services/       orders, day and sessions, reports, backup, events, audit
server/src/print/          print queue, ESC/POS tickets, printer drivers (network, Windows share, file)
server/src/fiscal/         the fiscal hook. Off. A real driver plugs in here later
server/src/util/qr.js      QR code generator, no dependencies
server/test/               the automated tests
web/src/                   React app: Floor.jsx (tables, order, pay), Manager.jsx, main.jsx (login, shell), i18n.js
web/styles.css             all styling
desktop/                   Electron shell and installer script
scripts/build.mjs          builds web/dist with esbuild
```

On Windows the installed app keeps its data in `C:\ProgramData\CafePOS`: `pos.db`, `backups/`, `server.log`.

## Differences from the build plan

- The server uses only what ships with Node (no Fastify). Zero dependencies makes the installer simpler.
- Styling is plain CSS, not Tailwind. The web app is bundled with esbuild, not Vite.
- Reports export as CSV. For PDF, use Print and choose "Save as PDF".
- Ticket text is plain ASCII (ë prints as e, ç as c), so it prints correctly on any thermal printer.
- A day left open for more than 20 hours shows a warning. It does not offer to close by itself.
- Login order and Albanian wording were written without a native speaker. All Albanian text is in `web/src/i18n.js`. Please review it.

## Printer setup

- **Network printer:** Settings, Printer, "Network printer", then the printer's address and port 9100. Press Test print.
- **USB printer:** install it in Windows, share it (Printer properties, Sharing, give it a short name like `POS80`),
  then choose "USB printer shared in Windows" and enter that share name.
- The printer is for internal bar tickets only. Never hand a ticket to a customer as a receipt.

## Roles

- **Waiter, bartender:** take orders, take payment, see their own session. A bartender can also mark items sold out.
- **Manager:** everything above plus the day, settlement, payouts, tickets, reports, menu names, tables, printer settings.
- **Owner:** everything, plus prices, staff and PINs, other settings, and wiping test data.
