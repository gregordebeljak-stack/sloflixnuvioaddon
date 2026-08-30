# SloFlix Stremio Addon

Neuraden Stremio addon, zgrajen iz logike projekta **JellySloFlix**: prijavi se v vaš
lasten SloFlix račun, prikaže katalog filmov/serij kot dva kataloga v Stremiu (in v
Nuvio, glej spodaj) in predvaja pretoke neposredno (brez vmesnega .strm/Jellyfin koraka).

To ni scraper piratskih strani — vedno uporablja vaše lastne SloFlix poverilnice,
enako kot je to počel originalni JellySloFlix bridge.

## 1. Lokalni zagon (za test)

```bash
cd sloflix-addon
npm install
npm start
```

Addon posluša na `http://127.0.0.1:7860` (spremenljivka okolja `PORT`).

## 2. Prijavna stran / nastavitve (uporabniško ime + geslo)

Addon zahteva vaš SloFlix e-mail in geslo — teh **ne vpisujete v kodo**, ampak
preko strani, ki jo Stremio SDK samodejno naredi iz `manifest.config` polj v
`addon.js`:

1. Odprite `<naslov-addona>/configure` v brskalniku (npr. `http://127.0.0.1:7860/configure`,
   ali kasneje javni naslov z Renderja, glej spodaj).
2. Vnesete SloFlix uporabniško ime in geslo.
3. Kliknete **Install** — Stremio/Nuvio odpre in namesti addon s temi poverilnicami,
   zakodiranimi v URL-ju addona (npr. `https://.../%7B%22username%22...%7D/manifest.json`).

Ker je `behaviorHints.configurable: true`, bo Stremio (in Nuvio, glej točko 5) ob
addonu prikazal **ikonico z zobnikom / nastavitve**, ki uporabnika pripelje nazaj
točno na to prijavno stran — tudi če jo kasneje želite spremeniti.

Če addon gostite javno (Render, VPS ...), poverilnice vsakega uporabnika ostanejo
zakodirane v njegovem lastnem addon URL-ju in se ne delijo med uporabniki.

## 3. Objava na GitHub + brezplačno gostovanje (Render.com)

GitHub sam po sebi **ne more poganjati** Node.js strežnika (GitHub Pages je samo
za statične strani) — za to potrebujete gostovanje, ki bere kodo iz vašega GitHub
repozitorija in jo požene. Trenutno najbolj enostavna brezplačna možnost brez
kreditne kartice je **Render.com** (repo že vsebuje `render.yaml`, torej gre
za "one click" deploy).

### 3a. Naložite kodo na GitHub

```bash
cd sloflix-addon
git init
git add .
git commit -m "SloFlix Stremio addon"
git branch -M main
git remote add origin https://github.com/VAŠE-UPORABNIŠKO-IME/sloflix-addon.git
git push -u origin main
```

(Prej na github.com ustvarite prazen repozitorij z imenom npr. `sloflix-addon`.)

### 3b. Povežite repo z Render

1. Pojdite na [render.com](https://render.com) in se prijavite z GitHub računom.
2. **New +** → **Blueprint** (ali **Web Service**) → izberite svoj `sloflix-addon` repo.
   Render bo prebral `render.yaml` in samodejno nastavil build/start ukaze.
3. Plan: **Free**. Kliknite **Deploy**.
4. Po nekaj minutah dobite javni naslov, npr. `https://sloflix-addon.onrender.com`.

Opomba: brezplačni Render plan po ~15 min neaktivnosti "zaspi" in se ob prvi naslednji
zahtevi znova zbudi (par sekund zamika) — za osebno uporabo je to čisto v redu.

### 3c. Namestitev v Stremio/Nuvio z javnim naslovom

Odprite `https://sloflix-addon.onrender.com/configure`, vnesite SloFlix
uporabniško ime/geslo in kliknite Install (ali v Stremio/Nuvio ročno dodajte
`https://sloflix-addon.onrender.com/manifest.json`, nato izpolnite nastavitve
preko ikonice z zobnikom).

## 4. Docker (alternativa Renderju, za lasten strežnik/NAS/VPS)

```bash
docker compose up -d --build
```

Nato v Stremio/Nuvio vnesite `http://VAŠ_SERVER_IP:7860/configure`
(pri lastnem gostovanju IP ni SloFlix-ov IP, ampak IP naprave, kjer addon teče —
če gledate od zunaj domačega omrežja, potrebujete port forwarding ali Render/VPS
iz točke 3).

## 5. Namestitev v Nuvio

Nuvio (aplikacija) po prenovi govori isti "addon" protokol kot Stremio — addon
manifest naloži enako kot npr. Torrentio ali AIOStreams, brez prilagoditev.
V Nuviu torej:

1. Dodajte addon preko `.../manifest.json` (lokalno, ali javni Render naslov iz točke 3).
2. Ker manifest vsebuje `config` polja in `configurable: true`, bi moral Nuvio
   ob addonu pokazati ikonico za nastavitve, ki vodi na isto `/configure`
   prijavno stran kot v Stremiu.

Če vaša različica Nuvia addona z `config` poljem ne ponudi nastavitvenega gumba
samodejno, kot obhod odprete `/configure` neposredno v brskalniku, izpolnite
prijavo, kliknete Install in kopirate nastali `stremio://.../manifest.json` link
(zamenjajte `stremio://` z `https://`) ročno v Nuvio.

Ločeno, v mapi `nuvio-provider/` je še best-effort "plugin" v starem Nuvio
formatu (TMDB → naslov → SloFlix iskanje) — ta ni potreben, če addon iz zgornjih
točk deluje, in je manj zanesljiv, ker SloFlix nima TMDB povezave.

## 6. Kaj addon naredi

- **Katalog**: `SloFlix Filmi` in `SloFlix Serije`, s podporo za iskanje (search)
  in straničenje (skip). Poleg tega še dva ožja kataloga, filtrirana po
  SloFlix žanrskem tagu (isti tag kot v filtru "Filtriraj in razvrsti" na
  sloflix.com): `SloFlix Slovenski filmi` (žanr `Slovenski`) in
  `SloFlix SLOSiNH (risanke in risani filmi)` (žanr `SLOSiNH`).
- **Meta**: podrobnosti filma/serije, pri serijah vključno s seznamom epizod po
  sezonah (pridobljeno iz `/v1/media/episodes/:showId/:season`).
- **Stream / kakovost**: ob odprtju naslova addon takoj razreši **vse**
  razpoložljive vire pri SloFlix in jih razvrsti od najboljše do najslabše
  zaznane kakovosti (iz oznak/URL-jev, npr. `1080p`, `720p`, `4K` ...), nato pa
  jih vrne kot ločene možnosti (`SloFlix - 1080p`, `SloFlix - 720p`, ...) z
  najboljšo na vrhu, da je privzeto izbrana. Ta razrešitev se hkrati
  predpomni, zato je dejanski zagon predvajanja (`/:config/play/:id/:kakovost`)
  praktično takojšen (brez ponovnega klica SloFlix API-ja tik pred play-om).
- Addon vrne povezavo do svoje **lastne proxy poti** `/:config/play/:id`,
  ki dejanski video pretoči naprej z dodanimi glavami
  `Referer`/`Origin: https://player.sloflix.com/`. Te glave SloFlix CDN
  zahteva za predvajanje — Stremio/Nuvio jih sam ne more poslati, zato jih
  original ni pošiljal playerju direktno, ampak je imel enak proxy korak.
  Proxy podpira tudi `Range` zahteve (previjanje/seek) in sledi HTTP redirectom.
  Za hitrost proxy uporablja trajne (keep-alive) HTTP/HTTPS povezave do SloFlix
  CDN-ja (manj TLS rokovanj pri vsakem seek-u) in ne zahteva kompresije za
  video (`Accept-Encoding: identity`), kar prihrani nepotreben CPU/latenco na
  obeh straneh.

Katalog se predpomni za 30 minut, razrešeni pretoki (SloFlix source URL, ne
sam video) pa za 5 minut (SloFlix viri lahko po določenem času potečejo).

### Javni naslov za `/play/` povezave

Addon mora vedeti svoj **javni** naslov, da lahko sestavi `/play/` povezave, ki
jih dobi Stremio/Nuvio. Ta naslov se **samodejno zazna iz vsake dohodne
zahteve** (protokol/host, vključno z `X-Forwarded-Proto`/`X-Forwarded-Host` za
gostovanje za reverse proxyjem), zato deluje ne glede na to, kje addon gostuje
— Render, VPS, Docker, ngrok/tunnel ipd. — brez ročne nastavitve.

Če je vaša postavitev nenavadna (npr. addon vidi drug Host header, kot je
njegov dejanski javni naslov) lahko samodetekcijo še vedno ročno preglasite s
spremenljivko okolja `PUBLIC_URL`, npr. `PUBLIC_URL=https://vasa-domena.si` —
to ni več potrebno v običajnih primerih.

## 7. Odpravljanje težav: katalog se naloži, video se ne predvaja

To je skoraj vedno eden od teh dveh vzrokov:

1. **Naslov, ki ga vidi Nuvio/Stremio, ni dosegljiv iz vaše naprave** — npr. če
   ročno nastavljen `PUBLIC_URL` kaže na napačen naslov, ali če je addon za
   proxyjem, ki ne pošilja `X-Forwarded-Host`/`X-Forwarded-Proto`. Preverite
   ga tako, da `/play/...` povezavo iz razdelka "Stream" v Stremio/Nuvio
   odprete neposredno v brskalniku na drugi napravi.
2. **SloFlix prijava odpove** (poteklo geslo, spremenjen API) — v tem primeru
   proxy pot vrne HTTP 502 z besedilom napake namesto videa. Preverite loge
   strežnika (`docker compose logs -f` oz. Render "Logs" zavihek).

## 8. Omejitve / stvari, ki jih original ni imel

- Ni filtriranja po žanru/letnici/oceni v katalogu — po potrebi dodajte `extra`
  polja v manifest in filter v `defineCatalogHandler`.
- ID-ji filmov/serij so SloFlix-specifični (`sloflix:<id>`), ne IMDb/TMDB, zato
  se ta katalog ne "spoji" s Cinemeto, ampak je samostojen katalog.
