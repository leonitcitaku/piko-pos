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

**Tested for real:**

- The server, with 31 automated tests (`npm test`): repeated sends, two waiters on one table, six devices at once, printer
  off and LATE tickets, COPY reprints, cancelling part of a line, split bills, on the house, discount, sold out, move, merge,
  floats, payouts, settlement, day close, backup, restore and upload, catch up mode, clock guard, PIN rules and lockout,
  idle logins, staff lockdown, period reports, staff profiles, the floor plan, the shift slip.
- The installer and the desktop app, on a Windows 10 laptop (build 10240): install, first start, port 80, the firewall
  rule, start with the PC, crash recovery of the built in server, surviving a hard power off with data intact.
- The web app in a browser at phone and PC size, by touch and by keyboard: login, ordering, paying, the manager tabs,
  the floor plan editor.
- Network printing against a fake printer that misbehaves on purpose (drops the connection, reports no paper), and on
  paper through `tools/escpos-to-paper.py`, which turns tickets into pages for an ordinary office printer.

**Not tested, because the hardware was not there:**

- A real thermal printer: paper width, the cut, double width text, and whether it answers the paper status request.
- Printing to a Windows printer by name (Settings, "Printer installed on this PC"). The error path is tested, real output is not.
- The floor plan editor by finger on a touch screen. It was driven with a mouse.
- The "keep this PC always on" switch changing Windows power settings. Reading them is tested.

## Install at the cafe

1. Copy `Cafe POS Setup x.y.z.exe` to a USB stick and run it on the cafe PC. Windows shows "Windows protected your PC"
   because the installer is unsigned: More info, then Run anyway.
2. Click through, say Yes to the Windows prompt, leave "Run Cafe POS" ticked.
3. Create the owner (6 digit PIN), then staff in Manager, Staff (4 digits for waiters and bartenders, 6 for managers).
4. In Manager, System: print the QR code for the phones, and turn on "Keep this PC always on".
5. In the router, reserve the PC's address (the System tab shows the IP and MAC to use) so the link never changes.

Press F1 in the app for every keyboard shortcut.

## Build the Windows installer

On any machine with internet, a Mac included:

```
npm install
npm install --save-dev electron electron-builder
npm run dist
```

The build is pinned to **x64** on the command line. Without that, electron-builder follows the
machine it runs on, so building on an Apple Silicon Mac quietly produced a Windows **ARM64** app
around an x64 `node.exe`. Do not remove the `--x64`.

`npm run dist` builds the web app, downloads the pinned Node into `vendor/node/node.exe`, and produces the installer in `release/`.
Inside the installer the server lives in `resources/pos`, not `resources/app`: Electron treats `resources/app` as the application
itself and would load it instead of the asar.
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

- **Waiter, bartender:** the tables only: take orders, take payment. They see no cash totals, sessions or reports.
- **Manager:** everything above plus the day, settlement, payouts, tickets, reports, menu names, tables, printer settings.
- **Owner:** everything, plus prices, staff and PINs, other settings, and wiping test data.
