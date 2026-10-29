# Młynek

Gra w młynka (Nine Men's Morris) w przeglądarce – jeden plik HTML, bez instalacji.

**Tryby gry**
- 👥 **Dwóch graczy** na jednym urządzeniu
- 🤖 **Gra z komputerem** – poziom łatwy / średni / trudny, grasz białymi lub czarnymi
- 🌐 **Gra online** – jeden gracz tworzy pokój i wysyła link, drugi go otwiera

## Jak działa gra online na GitHub Pages

GitHub Pages hostuje tylko pliki statyczne, więc nie ma tam serwera gry. Ruchy są przesyłane
przez **darmowe, publiczne serwery wiadomości MQTT** (HiveMQ i EMQX), z którymi przeglądarka
łączy się przez WebSocket:

1. Gospodarz klika „Utwórz pokój” – dostaje link `…/?pokoj=k7m2qx`, który wysyła znajomemu.
2. Obie przeglądarki subskrybują temat `mlynek-pl/v1/<kod-pokoju>/`. Po każdym ruchu
   publikowany jest cały stan planszy.
3. Stan jest zapamiętywany na serwerze (*retained*), więc odświeżenie strony, wyjście
   z aplikacji czy chwilowy brak zasięgu nie kończą gry – po powrocie partia się odtwarza.
   Można nawet wykonać ruch, gdy przeciwnik jest offline – zobaczy go po powrocie.
4. Gra łączy się z dwoma serwerami naraz; jeśli jeden nie działa, wystarczy drugi.
5. Po każdej partii kolory się zamieniają.

W przeciwieństwie do połączeń bezpośrednich (WebRTC) nie ma problemu z sieciami komórkowymi
ani firmowymi – potrzebny jest tylko zwykły dostęp do internetu.

Uwaga: publiczne serwery MQTT są otwarte – kto znałby kod pokoju, mógłby podejrzeć grę.
Kod jest losowy, więc w praktyce nie ma to znaczenia.

Biblioteka [MQTT.js](https://github.com/mqttjs/MQTT.js) jest dołączona w `vendor/` (licencja MIT).

## Publikacja na GitHub Pages

Settings → Pages → *Build and deployment* → Source: **Deploy from a branch** →
Branch: `main`, folder `/ (root)` → Save. Po chwili gra będzie pod adresem
`https://<użytkownik>.github.io/mlynek/`.

## Pliki

- `index.html` – interfejs, rysowanie planszy, tryb online
- `engine.js` – zasady gry i AI (negamax z cięciami alfa‑beta, iteracyjne pogłębianie)
- `vendor/mqtt.min.js` – MQTT.js 5.10.1
