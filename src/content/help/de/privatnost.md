# Datenschutz: was geschützt ist und was nicht

Wir versuchen ehrlich darüber zu sein, was Ugolok tatsächlich bietet, statt mehr zu versprechen, als tatsächlich vorhanden ist. Die Grenzen des Schutzes zu verstehen, ist ebenfalls Teil der Sicherheit — am gefährlichsten ist die Annahme, etwas sei geschützt, obwohl es das gar nicht ist.

## Was selbst vor dem Server verborgen bleibt

- **Der Nachrichteninhalt.** Der Server (Relay), über den das Gespräch läuft, sieht nur eine verschlüsselte Bytefolge — er kann den Text nicht lesen.
- **Namen von Kontakten und Gruppen**, Kanalnamen, deren Zugriffsregeln.
- **Der Inhalt von Dateien und Anhängen** — der Speicherserver sieht nur den Chiffretext.

## Was der Server (Relay) trotzdem sieht

Das ist kein Geheimnis und kein spezifischer Mangel von Ugolok — so funktioniert jeder Server, über den Datenverkehr läuft:

- **Wer mit wem interagiert und wann** — die öffentlichen Schlüssel von Absender und Empfänger, Zeitstempel. Der Inhalt ist verborgen, aber die Tatsache, dass „diese beiden Schlüssel sich zu einer bestimmten Zeit etwas übermittelt haben“, ist sichtbar.
- **Umfang und Häufigkeit des Datenverkehrs.**
- **Online-Status** — wann Sie mit dem Server verbunden sind.
- **Welche undurchsichtigen Kanal-Tags Sie lesen** — das Relay selbst weiß nicht, um welchen Kanal es sich handelt, sieht aber, dass sich derselbe Schlüssel regelmäßig für dasselbe Tag interessiert.

Wenn Ihnen nicht nur wichtig ist, „dass das Gespräch nicht gelesen wird“, sondern auch, „dass nicht einmal sichtbar ist, dass ich das überhaupt nutze“ — berücksichtigen Sie das bei der Serverwahl und Ihrem Verhalten.

## Was man sich separat merken sollte

- **Ein entsperrtes Gerät bedeutet entsperrte Gesprächsverläufe.** Keine Verschlüsselung schützt vor einer Person mit physischem Zugriff auf die bereits geöffnete und entsperrte App.
- **Kanäle haben keine Forward Secrecy** (im Gegensatz zu privaten Nachrichten) — das ist eine bewusste Entscheidung: Ein Kanal ähnelt seiner Natur nach eher einem Archiv als einem Gespräch und ist dafür gedacht, dass man zu alten Einträgen zurückkehrt.
- **Der Gesprächspartner sieht ebenfalls, was Sie ihm geschickt haben**, und kann es kopieren, weiterleiten oder speichern — die Verschlüsselung schützt den Übertragungsweg, nicht das, was der Empfänger anschließend mit der Nachricht macht.

## Was Sie selbst tun können

- Einen eigenen Server betreiben, wenn Sie nicht einmal von den Servern des Projekts abhängig sein wollen.
- Werkzeuge zur Umgehung von Sperren auf Netzwerkebene nutzen, falls das für Sie relevant ist — Ugolok versteht sich bewusst nicht als Werkzeug zur Zensurumgehung (siehe Abschnitt „Über das Projekt“), aber nichts hindert Sie daran, es über eine bereits von Ihnen eingerichtete Verbindung zu nutzen.
