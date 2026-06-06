SHEET SEARCH (Mobile/PWA)
========================

Ye ek HTML/PWA app hai jisme:
- Aap multiple Google Sheet URLs add kar sakte ho (side menu/drawer me list).
- Main screen par sirf Search option aata hai.
- Search karte hi app sheet se fresh data uthati hai (spam avoid ke liye ~20 sec me max 1 refresh).
- Data localStorage me save + cache hota hai.
- Har 5 minute me background me auto-refresh hota rehta hai.

IMPORTANT (Sheet Access)
-----------------------
Is app ka access mode: Public/Published.
1) Google Sheet open karo
2) Share -> General access: "Anyone with the link" (Viewer)
3) OPTIONAL (Recommended): File -> Share -> Publish to web

Permanent default sheet (sab users ke liye)
------------------------------------------
Agar aap chahte ho ki app khulte hi ek fixed sheet pehle se "Added Sheets" me ho,
to `app.js` me `DEFAULT_SHEETS` me apna Google Sheet URL daal do.

Locked single-sheet mode
------------------------
Is project me ab "LOCKED_SINGLE_SHEET_MODE = true" hai:
- User app ke andar se sheet delete/add nahi kar sakta
- Sirf ek hi link (DEFAULT_SHEETS) rahega

Use kaise kare
--------------
1) index.html open karo (best: kisi local server se)
   - Example: VS Code Live Server / python -m http.server / etc.
   - Direct file:// open par service worker (PWA) nahi chalega.
2) App me ☰ menu khol ke "Google Sheet URL" paste karo -> Add
3) Main screen par search box me type karo (starts-with search)

Android App (2 options)
-----------------------
Option A (Simple): PWA Install
- Chrome Android me is page ko open karo
- Menu -> "Add to Home screen" / "Install app"

Option B (Proper APK): Trusted Web Activity (TWA) / Capacitor
- Agar aap APK banana chahte ho to aapko app ko kisi HTTPS hosting par rakhna hoga
  (Netlify, Vercel, GitHub Pages, etc.)
- Phir TWA (Bubblewrap) ya Capacitor se wrap karke APK/AAB ban sakta hai.

Note
----
Agar sheet publish/share sahi nahi hoga, to refresh me error aayega.
Tab name (optional) ka matlab: Google Sheet ke andar wali tab ka naam (e.g. Sheet1).
