# Privacy: cosa è protetto e cosa no

Cerchiamo di essere onesti su ciò che Ugolok offre realmente, invece di promettere più di quanto effettivamente faccia. Capire i limiti della protezione fa anch'esso parte della sicurezza — la cosa più pericolosa è pensare che qualcosa sia protetto quando in realtà non lo è.

## Cosa è nascosto perfino al server

- **Il contenuto dei messaggi.** Il server (relay) attraverso cui passa la conversazione vede solo un insieme di byte cifrati — non può leggere il testo.
- **I nomi di contatti e gruppi**, i nomi dei canali, le loro regole di accesso.
- **Il contenuto di file e allegati** — il server di archiviazione vede solo il testo cifrato.

## Cosa vede comunque il server (relay)

Questo non è un segreto né una carenza specifica di Ugolok — è così che funziona qualsiasi server attraverso cui passa il traffico:

- **Chi interagisce con chi e quando** — le chiavi pubbliche del mittente e del destinatario, i timestamp. Il contenuto è nascosto, ma il fatto che «queste due chiavi si sono scambiate qualcosa in quel momento» è visibile.
- **Volume e frequenza del traffico.**
- **Stato online** — quando sei connesso al server.
- **Quali tag opachi dei canali leggi** — il relay stesso non sa di quale canale si tratti, ma vede che la stessa chiave si interessa regolarmente allo stesso tag.

Se per te è fondamentale non solo «che la conversazione non venga letta», ma «che non si veda nemmeno il fatto che la uso» — tienine conto nella scelta del server e nel tuo comportamento.

## Cose da tenere a mente separatamente

- **Un dispositivo sbloccato è una cronologia delle conversazioni sbloccata.** Nessuna cifratura protegge da una persona con accesso fisico all'app già aperta e sbloccata.
- **I canali non hanno forward secrecy** (a differenza dei messaggi privati) — è una decisione deliberata: un canale è per natura più vicino a un archivio che a una conversazione, ed è pensato per essere riconsultato nel tempo.
- **Anche l'interlocutore vede ciò che gli hai inviato**, e può copiarlo, inoltrarlo o salvarlo — la cifratura protegge il canale di trasmissione, non ciò che il destinatario fa in seguito con il messaggio.

## Cosa puoi fare tu stesso

- Avviare un tuo server personale, se non vuoi dipendere nemmeno dai server del progetto.
- Usare strumenti di elusione dei blocchi a livello di rete, se per te è rilevante — Ugolok non si presenta deliberatamente come uno strumento anticensura (vedi la sezione «Informazioni sul progetto»), ma nulla ti impedisce di usarlo sopra una connessione che hai già configurato.
