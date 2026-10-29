# Młynek

Gra w młynka (Nine Men's Morris) w przeglądarce – jeden plik HTML, bez instalacji.

**Tryby gry**
- 👥 **Dwóch graczy** na jednym urządzeniu
- 🤖 **Gra z komputerem** – poziom łatwy / średni / trudny, grasz białymi lub czarnymi
- 🌐 **Gra online** – jeden gracz tworzy pokój i wysyła link, drugi go otwiera

## Jak działa gra online

GitHub Pages hostuje tylko pliki statyczne, więc stan gry jest przechowywany w bazie
**Firebase Realtime Database** (Google, darmowy plan „Spark”):

1. Gospodarz klika „Utwórz pokój” – dostaje link `…/?pokoj=k7m2qx`, który wysyła znajomemu.
2. Obie przeglądarki czytają i zapisują `rooms/<kod-pokoju>` w bazie. Po każdym ruchu
   zapisywany jest cały stan planszy, a baza od razu powiadamia drugiego gracza.
3. Baza pamięta stan, więc odświeżenie strony czy chwilowy brak zasięgu nie kończą gry.
   Widać też, czy przeciwnik jest online.
4. Gdy gospodarz wyjdzie przez „Menu”, dane pokoju są usuwane z bazy.
5. Po każdej partii kolory się zamieniają.

Reguły bazy (`database.rules.json`) pozwalają czytać i zapisywać tylko pojedynczy pokój
o znanym kodzie, w ściśle określonym formacie i rozmiarze – nie da się przejrzeć listy
pokojów ani zapisać w bazie innych danych.

## Konfiguracja Firebase (jednorazowo, ok. 10 minut)

1. Wejdź na <https://console.firebase.google.com> i utwórz projekt (np. „mlynek”).
   Google Analytics możesz wyłączyć – gra go nie używa.
2. W menu po lewej wybierz **Realtime Database** → **Utwórz bazę danych**.
   - Lokalizacja: **Belgia (europe-west1)** – dane zostaną w UE (tak opisuje to polityka prywatności).
   - Tryb: **zablokowany** (locked mode).
3. W zakładce **Reguły** zastąp treść zawartością pliku `database.rules.json` i kliknij **Opublikuj**.
4. W zakładce **Dane** skopiuj adres bazy, np.
   `https://mlynek-12345-default-rtdb.europe-west1.firebasedatabase.app`,
   i wpisz go w `firebase-config.js` w polu `databaseURL`.

Nie trzeba rejestrować aplikacji, podawać karty płatniczej ani klucza API. Adres bazy nie jest
tajny – bezpieczeństwo zapewniają reguły.

Limity darmowego planu: 100 jednoczesnych połączeń (ok. 50 gier naraz), 1 GB danych,
10 GB transferu miesięcznie. Pokój zajmuje ok. 0,5 KB.

**Sprzątanie:** pokoje porzucone bez wyjścia przez „Menu” zostają w bazie. Nie zawierają
danych osobowych, ale warto co jakiś czas (np. raz w miesiącu) usunąć je w konsoli:
Realtime Database → Dane → najedź na `rooms` → kosz. Usunie to też trwające gry.

## Testowanie lokalne

`firebase.json` konfiguruje emulator bazy (`npx firebase-tools emulators:start --only database`,
port 9100). Stronę można skierować na emulator, ustawiając przed `firebase-config.js`:
`window.MLYNEK_FIREBASE = { databaseURL: 'https://demo-mlynek-default-rtdb.firebaseio.com', emulator: { host: '127.0.0.1', port: 9100 } }`.

## Publikacja na GitHub Pages

Settings → Pages → *Build and deployment* → Source: **Deploy from a branch** →
Branch: `main`, folder `/ (root)` → Save. Po chwili gra będzie pod adresem
`https://<użytkownik>.github.io/mlynek/`.

## Pliki

- `index.html` – interfejs, rysowanie planszy, tryb online
- `prawne.html` – regulamin, polityka prywatności (RODO), licencje
- `engine.js` – zasady gry i AI (negamax z cięciami alfa‑beta, iteracyjne pogłębianie)
- `firebase-config.js` – adres bazy Firebase
- `database.rules.json` – reguły bezpieczeństwa bazy
- `vendor/firebase-db.min.js` – Firebase JS SDK 11.10.0 (tylko baza danych, licencja Apache 2.0),
  zbudowany przez `tools/firebase-bundle` z wyłączonym zapisem „heartbeat” w przeglądarce
