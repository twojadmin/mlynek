# Młynek

Gra w młynka (Nine Men's Morris) w przeglądarce – jeden plik HTML, bez instalacji.

**Tryby gry**
- 👥 **Dwóch graczy** na jednym urządzeniu
- 🤖 **Gra z komputerem** – poziom łatwy / średni / trudny, grasz białymi lub czarnymi
- 🌐 **Gra online** – jeden gracz tworzy pokój i wysyła link, drugi go otwiera

## Jak działa gra online na GitHub Pages

GitHub Pages hostuje tylko pliki statyczne, więc nie ma tam serwera gry. Zamiast tego
przeglądarki graczy łączą się **bezpośrednio ze sobą (WebRTC)** za pomocą biblioteki
[PeerJS](https://peerjs.com/):

1. Gospodarz klika „Utwórz pokój” – dostaje kod (np. `k7m2qx`) i link `…/?pokoj=k7m2qx`.
2. Publiczny, darmowy serwer PeerJS (`0.peerjs.com`) służy tylko do „przedstawienia”
   przeglądarek sobie nawzajem.
3. Potem ruchy idą bezpośrednio między graczami. Po każdym ruchu wysyłany jest cały
   stan planszy, więc obie strony zawsze widzą to samo.
4. Odświeżenie strony nie kończy gry – gość łączy się ponownie, a gospodarz odtwarza
   partię z pamięci przeglądarki. Po każdej partii kolory się zamieniają.

Biblioteka PeerJS jest dołączona w `vendor/` (licencja MIT), więc strona nie zależy od CDN.

> Uwaga: w rzadkich przypadkach (bardzo restrykcyjne sieci firmowe / niektórzy operatorzy
> komórkowi) bezpośrednie połączenie może się nie udać – wtedy pomaga zmiana sieci, np. na Wi‑Fi.

## Publikacja na GitHub Pages

Settings → Pages → *Build and deployment* → Source: **Deploy from a branch** →
Branch: `main`, folder `/ (root)` → Save. Po chwili gra będzie pod adresem
`https://<użytkownik>.github.io/mlynek/`.

## Pliki

- `index.html` – interfejs, rysowanie planszy, tryb online
- `engine.js` – zasady gry i AI (negamax z cięciami alfa‑beta, iteracyjne pogłębianie)
- `vendor/peerjs.min.js` – PeerJS 1.5.4
