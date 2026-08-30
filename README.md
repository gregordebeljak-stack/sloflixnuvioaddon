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
  in straničenje (skip).
- **Meta**: podrobnosti filma/serije, pri serijah vključno s seznamom epizod po
  sezonah (pridobljeno iz `/v1/media/episodes/:showId/:season`).
- **Stream**: razreši neposredno povezavo do videa preko `/v1/media/single/:id`,
  enako kot originalni `server.js` (`resolveMedia`), in doda slovenske podnapise,
  če so na voljo.

Katalog se predpomni za 30 minut, razrešeni pretoki pa za 5 minut (SloFlix viri
lahko po določenem času potečejo).

## 7. Omejitve / stvari, ki jih original ni imel

- Ni proxy/redirect logike za HTTP Range requeste kot `server.js` — Stremio
  predvaja direktno povezavo do vira. Če bi viri zahtevali posebne glave
  (`Referer`/`Origin`), jih je treba dodati v `stream.behaviorHints.proxyHeaders`.
- Ni filtriranja po žanru/letnici/oceni v katalogu — po potrebi dodajte `extra`
  polja v manifest in filter v `defineCatalogHandler`.
- ID-ji filmov/serij so SloFlix-specifični (`sloflix:<id>`), ne IMDb/TMDB, zato
  se ta katalog ne "spoji" s Cinemeto, ampak je samostojen katalog.
