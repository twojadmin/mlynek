// Konfiguracja gry online (Firebase Realtime Database).
// Wpisz adres swojej bazy z konsoli Firebase: Realtime Database → zakładka „Dane”,
// adres jest nad drzewem danych, np.:
//   https://mlynek-12345-default-rtdb.europe-west1.firebasedatabase.app
// Ten adres nie jest tajny – dostęp do danych ograniczają reguły z pliku database.rules.json.
window.MLYNEK_FIREBASE = window.MLYNEK_FIREBASE || {
  databaseURL: 'https://mlynek-57b4f-default-rtdb.europe-west1.firebasedatabase.app',
  // Klucz aplikacji internetowej z konsoli Firebase (Ustawienia projektu → Twoje aplikacje).
  // Potrzebny tylko w panelu administratora (admin.html). Nie jest tajny.
  apiKey: '',
};
