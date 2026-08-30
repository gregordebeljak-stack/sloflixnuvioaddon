# SloFlix Stremio Addon

Neuraden Stremio addon. Prijavi se v svoj lasten SloFlix račun, prikaže katalog filmov/serij kot dva kataloga v Stremiu (in v
Nuvio, glej spodaj) in predvaja pretoke neposredno.

To ni scraper piratskih strani — vedno uporablja vaše lastne SloFlix poverilnice.


## 1. Prijavna stran / nastavitve (uporabniško ime + geslo)

Addon zahteva vaš SloFlix e-mail in geslo — teh **ne vpisujete v kodo**, ampak
preko strani, ki jo Stremio SDK samodejno naredi iz `manifest.config` polj v
`addon.js`:

1. Odprite (https://sloflixnuvio.onrender.com/configure) v brskalniku 
2. Vnesete SloFlix uporabniško ime in geslo.
3. Kliknete **Install** — Stremio/Nuvio odpre in namesti addon.


## 2. Odpravljanje težav: katalog se naloži, video se ne predvaja

To je skoraj vedno eden od teh dveh vzrokov:

1. **Naslov, ki ga vidi Nuvio/Stremio, ni dosegljiv iz vaše naprave** — npr. če
   ročno nastavljen `PUBLIC_URL` kaže na napačen naslov, ali če je addon za
   proxyjem, ki ne pošilja `X-Forwarded-Host`/`X-Forwarded-Proto`. Preverite
   ga tako, da `/play/...` povezavo iz razdelka "Stream" v Stremio/Nuvio
   odprete neposredno v brskalniku na drugi napravi.
2. **SloFlix prijava odpove** (poteklo geslo, spremenjen API) — v tem primeru
   proxy pot vrne HTTP 502 z besedilom napake namesto videa. Preverite loge
   strežnika (`docker compose logs -f` oz. Render "Logs" zavihek).

## 3. Omejitve / stvari, ki jih original ni imel

- Ni filtriranja po žanru/letnici/oceni v katalogu — po potrebi dodajte `extra`
  polja v manifest in filter v `defineCatalogHandler`.
- ID-ji filmov/serij so SloFlix-specifični (`sloflix:<id>`), ne IMDb/TMDB, zato
  se ta katalog ne "spoji" s Cinemeto, ampak je samostojen katalog.
