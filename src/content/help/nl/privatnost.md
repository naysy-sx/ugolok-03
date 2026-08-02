# Privacy: wat wel en niet beschermd is

We proberen eerlijk te zijn over wat Ugolok werkelijk biedt, in plaats van meer te beloven dan er echt is. Het begrijpen van de grenzen van bescherming is ook onderdeel van veiligheid — het gevaarlijkst is te denken dat iets beschermd is terwijl dat in werkelijkheid niet zo is.

## Wat zelfs voor de server verborgen blijft

- **De inhoud van berichten.** De server (relay) waar het gesprek doorheen gaat, ziet alleen een versleutelde reeks bytes — hij kan de tekst niet lezen.
- **Namen van contacten en groepen**, kanaalnamen, hun toegangsregels.
- **De inhoud van bestanden en bijlagen** — de opslagserver ziet alleen de versleutelde tekst.

## Wat de server (relay) wel ziet

Dit is geen geheim en geen tekortkoming specifiek van Ugolok — zo werkt elke server waar verkeer doorheen gaat:

- **Wie met wie communiceert en wanneer** — de publieke sleutels van afzender en ontvanger, tijdstempels. De inhoud is verborgen, maar het feit dat "deze twee sleutels op dat moment iets hebben uitgewisseld" is zichtbaar.
- **Omvang en frequentie van het verkeer.**
- **Onlinestatus** — wanneer je verbonden bent met de server.
- **Welke ondoorzichtige kanaaltags je leest** — de relay zelf weet niet om welk kanaal het gaat, maar ziet dat dezelfde sleutel regelmatig geïnteresseerd is in dezelfde tag.

Als het voor jou cruciaal is niet alleen "dat het gesprek niet wordt gelezen", maar ook "dat zelfs niet zichtbaar is dat ik dit überhaupt gebruik" — houd hier rekening mee bij het kiezen van een server en je gedrag.

## Dingen om apart te onthouden

- **Een ontgrendeld apparaat betekent ontgrendelde gespreksgeschiedenis.** Geen enkele versleuteling beschermt tegen iemand met fysieke toegang tot de al geopende en ontgrendelde app.
- **Kanalen hebben geen forward secrecy** (in tegenstelling tot privéberichten) — dit is een bewuste keuze: een kanaal lijkt van nature meer op een archief dan op een gesprek, en is bedoeld om later opnieuw te worden bekeken.
- **De ander ziet ook wat je hem hebt gestuurd**, en kan het kopiëren, doorsturen of opslaan — versleuteling beschermt het transmissiekanaal, niet wat de ontvanger daarna met het bericht doet.

## Wat je zelf kunt doen

- Je eigen server draaien als je niet eens van de servers van het project afhankelijk wilt zijn.
- Netwerkniveau-tools voor het omzeilen van blokkades gebruiken als dat voor jou relevant is — Ugolok wordt bewust niet gepositioneerd als een tool voor het omzeilen van censuur zelf (zie de sectie "Over het project"), maar niets weerhoudt je ervan het te gebruiken bovenop een verbinding die je al zelf hebt ingesteld.
