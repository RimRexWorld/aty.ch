# aty.ch

Verkaufsseite für den Pajero. Statisch, auf GitHub Pages, Ziel des QR-Codes
auf dem gedruckten Aushang.

Der Inhalt kommt vollständig aus `content/car.json` und den Bildern in
`photos/`. Alles andere ist Werkzeug.

---

## Warum GitHub Pages und nicht der Cluster

Die Seite wird von Fremden in Australien auf Mobildaten geöffnet. Zürich↔Sydney
sind ~280 ms RTT: TCP + TLS + Request ergeben rund **840 ms bis zum ersten
Byte**, bevor ein Pixel da ist, und derselbe RTT bremst danach den TCP-Slow-Start
beim Laden der Fotos. Ein CDN mit Standort Sydney liegt bei ~60 ms.

Die Blur-up-Technik unten kauft 200–400 ms wahrgenommene Ladezeit. Der
Auslieferungsort kauft 3–5 Sekunden. Deshalb Pages.

---

## Loslegen

```bash
nix develop -c ./build.sh --serve     # baut dist/ und serviert auf :8080
```

Ohne Nix: Node 22, `magick`, `cwebp`, `avifenc` auf dem PATH, dann
`./build.sh`.

Der erste Build kodiert alle Fotos (ein bis zwei Minuten). Danach greift der
Cache in `.cache/` — ein Textänderung baut in Millisekunden, ein neues Foto
kostet nur dieses eine Foto.

---

## Inhalt pflegen

### Die Fakten

Alles in **`content/car.json`**. Felder auf `null` sind noch nicht ausgefüllt.
Der Build rendert die lokal als gelbe `missing`-Marker, damit du siehst, was
fehlt — und **bricht mit `--strict` ab**, was die CI fährt. Eine veröffentlichte
Seite mit `missing` beim Preis ist schlimmer als gar keine Seite.

Noch offen, Stand jetzt: Preis, Kilometerstand, Getriebe, Hubraum, Sitze,
Farbe, Rego-Staat und -Ablauf, letzter Service, kürzlich ersetzt, bekannte
Mängel, verfügbar ab, Standort, Name, Telefonnummer und die drei Absätze der
persönlichen Notiz.

### Die Fotos

Dateien nach `photos/` legen. Die Reihenfolge auf der Seite ist die
Dateinamen-Reihenfolge — deshalb die Zahlen-Präfixe. **Das erste Foto ist das
Hero-Bild und die Vorschau beim Teilen in WhatsApp.**

Der nächste Build trägt neue Dateien automatisch in `content/photos.json` mit
`alt: null` ein; dort kommt der Alt-Text rein.

Originale in voller Auflösung hineinlegen, nicht vorskalieren — der Build
erzeugt alle Grössen selbst und kann nur verkleinern.

> **Die aktuellen Fotos sind Platzhalter**, aus dem Flyer-PDF extrahiert
> (1600 px). Auf mehreren ist das **Kennzeichen lesbar** — vor dem ersten Push
> maskieren oder durch maskierte Originale ersetzen.

### Kennzeichen maskieren

```bash
nix develop -c node tools/mask.mjs --check     # ganzes Bild, 5%-Raster, Box rot
nix develop -c node tools/mask.mjs --preview   # Zoom auf jede Box
nix develop -c node tools/mask.mjs --apply     # weisse Balken reinschreiben
```

Boxen stehen in `content/masks.json` als `[x, y, breite, höhe]`, **Anteile von
0 bis 1**, Ursprung oben links. Anteile statt Pixel, damit ein höher
aufgelöstes Original derselben Aufnahme dieselben Zahlen behält.

Der Ablauf ist `--check`, Zahlen korrigieren, wiederholen, bis jeder Balken
sein Schild vollständig deckt — dann `--apply`. Die `--check`-Ansicht legt das
5 %-Raster in absoluten Bildanteilen über das ganze Foto, die Zahlen lassen
sich also direkt ablesen und zurückschreiben.

Maskiert wird **destruktiv**, weil `photos/` in ein öffentliches Repo geht.
Eine Maskierung erst beim Build würde das unmaskierte Original in Git
veröffentlichen und den Zweck genau verfehlen. Das unberührte Bild liegt in
`.originals/` (gitignored), und jeder Lauf rechnet von dort neu — eine Box
lässt sich also korrigieren und erneut anwenden, ohne dass sich Balken
stapeln.

**Stand:**

- **Fertig, von Hand ausserhalb dieses Werkzeugs maskiert:** 01, 03, 04, 05,
  06, 08, 10. Diese haben *keinen* Eintrag in `masks.json` mehr — ein neuer
  Eintrag würde einen zweiten Balken auf ein bereits maskiertes Bild malen.
- **Noch offen, Boxen sitzen noch nicht:** 07, 09, 11, 14, 15. Darunter 09
  mit dem am besten lesbaren Schild des Satzes.
- **Kein Kennzeichen im Bild:** 02, 12, 13, 16. Nach dem Fotowechsel neu
  prüfen.

Solange die fünf offenen nicht maskiert sind, darf `photos/` **nicht**
committet werden.

---

## Wie die Bilder laden

Pro Foto entstehen AVIF, WebP und JPEG in bis zu vier Breiten, plus ein 24 px
breites WebP, das **als Data-URI direkt im HTML** steht.

Beim Laden passiert dann:

1. Der `<figure>`-Wrapper trägt Seitenverhältnis, Dominantfarbe und das
   Mini-Bild als Inline-Style. Das Layout steht also fest, bevor ein einziges
   Bild-Byte angefragt wurde — kein Umspringen, nie ein weisses Loch.
2. CSS skaliert das 24-px-Bild hoch und legt `blur(18px)` darüber. Das ist der
   verpixelte Vorschauzustand, kostet **null zusätzliche Requests** und für
   alle 16 Fotos zusammen 4,8 kB.
3. Sobald das echte Bild dekodiert ist, setzt ein Listener `data-loaded` auf
   den Wrapper und das scharfe Bild blendet in 0,45 s über die Unschärfe.

Der Listener hängt in der **Capture-Phase** am `window`: `load` von `<img>`
steigt nicht auf, und ein Bild aus dem Cache kann fertig sein, bevor das Script
überhaupt geparst ist — dafür gibt es zusätzlich den `DOMContentLoaded`-Sweep.
Ohne beides bliebe ein gecachtes Bild unsichtbar. Ohne JS zeigt ein
`<noscript>`-Block alles sofort scharf.

Was ein Besucher wirklich lädt:

| | |
|---|---|
| HTML inkl. CSS und aller Mini-Bilder | 10 kB gzipped |
| Zwei Webfonts (Subset) | 48 kB |
| Hero-Bild AVIF @800 | 21 kB |
| **Above the fold** | **~79 kB** |

Die Galerie lädt `lazy` beim Scrollen nach, `app.js` ist `defer`.

---

## Deploy

Push auf `main` → `.github/workflows/pages.yml` → Pages.

Die CI baut mit demselben Nix-Dev-Shell wie du lokal. Nicht aus Prinzip: die
Encoder-Version steckt in jedem ausgelieferten Byte, und `apt-get install
imagemagick` driftet mit jedem Ubuntu-Update.

### Einmalig einzurichten

1. **Repo → Settings → Pages → Source: „GitHub Actions"**. Ohne das läuft der
   Workflow und deployt ins Leere.
2. **DNS bei Infomaniak** für die Apex-Domain `aty.ch` — vier A-Records:

   ```
   185.199.108.153
   185.199.109.153
   185.199.110.153
   185.199.111.153
   ```

   Dazu AAAA, wenn du IPv6 willst:

   ```
   2606:50c0:8000::153   2606:50c0:8001::153
   2606:50c0:8002::153   2606:50c0:8003::153
   ```

   `www.aty.ch` als CNAME auf `rimrexworld.github.io.`, falls gewünscht.
   `public/CNAME` enthält bereits `aty.ch`, das Zertifikat macht GitHub
   automatisch — nach dem DNS-Setup in den Pages-Settings noch „Enforce HTTPS"
   anhaken.
3. Zone ist bereits bei Infomaniak (`ns11`/`ns12`), A-Record existiert noch
   nicht. Erst nach dem Setzen kann GitHub das Zertifikat ausstellen.

### QR-Code für den Aushang

```bash
nix develop -c ./tools/qr.sh
```

Schreibt `print/qr-aty-ch.svg` und `.png` mit Fehlerkorrektur H. Mindestens
2 cm breit drucken und **den Ausdruck** testen, nicht den Bildschirm.

---

## Struktur

```
content/car.json       Alle Fakten. Die einzige Datei, die du normalerweise anfasst.
content/photos.json    Alt-Texte pro Foto.
photos/                Originale. Dateiname bestimmt die Reihenfolge.
src/styles.css         Wird ins HTML inlined.
src/app.js             Nur die Lightbox, defer geladen.
src/fonts/             Subgesetzte woff2, committed.
tools/build.mjs        Bildpipeline + HTML-Rendering. Keine Dependencies.
tools/fonts.sh         Erzeugt die Webfonts neu. Läuft praktisch nie.
tools/qr.sh            QR-Code für den Flyer.
```

Die Palette (`#f5f1ea` Creme, `#1b1a17` Tinte, `#a4441f` Rost) ist aus den
Farboperatoren des Flyer-PDFs ausgelesen, nicht nachempfunden — die Seite soll
aussehen wie das Papier in der Hand des Scannenden.

### Schutz gegen versehentliches Committen

`tools/hooks/pre-commit` verweigert jeden Commit, der ein Foto enthält, das
noch einen Eintrag in `content/masks.json` hat — also eines, dessen Kennzeichen
nachweislich noch sichtbar ist. Ein unmaskiertes Schild in einem öffentlichen
Repo lässt sich nicht zurücknehmen: auch wenn ein späterer Commit die Datei
ersetzt, bleibt der ursprüngliche Blob dauerhaft abrufbar.

Nach einem frischen `git clone` einmalig aktivieren:

```bash
git config core.hooksPath tools/hooks
```
