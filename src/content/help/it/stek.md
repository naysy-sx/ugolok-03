# Tecnologie e struttura del progetto

Questa pagina è per chi è curioso di guardare «sotto il cofano». Non è necessario capirla per usare l'applicazione.

## Protocollo

Ugolok è costruito su **Nostr** — un protocollo aperto per la messaggistica decentralizzata. L'idea centrale di Nostr è semplice: ogni utente ha una coppia di chiavi (pubblica e privata), i messaggi vengono firmati con la chiave privata e pubblicati su uno o più server (chiamati *relay*). Nessuno rilascia account — l'identità è definita interamente dalla chiave.

## Cifratura

- Le conversazioni private usano **MLS** (Messaging Layer Security) — la stessa classe di protocolli alla base della cifratura nelle grandi app di messaggistica. Offre *forward secrecy*: anche se una chiave dovesse trapelare in futuro, non sarà possibile leggere retroattivamente le vecchie conversazioni.
- Il contenuto dei canali è cifrato con una chiave di canale separata — qui la forward secrecy non viene applicata deliberatamente (un canale è per natura un archivio a cui si torna negli anni, non una conversazione pensata per essere «dimenticata»).
- Anche il database locale sul dispositivo è cifrato — la chiave di cifratura è derivata dalla tua password.
- File e allegati vengono cifrati separatamente prima di essere caricati sul server di archiviazione (Blossom) — il server memorizza solo il testo cifrato.

## Di cosa è fatta l'app

- **Preact** — un motore per l'interfaccia leggero (reattivo, ma molte volte più piccolo di alternative più note).
- **Dexie.js** — un involucro attorno al database integrato nel browser (IndexedDB), dove tutta la tua conversazione viene memorizzata localmente.
- Primitive crittografiche — librerie della famiglia **@noble** (secp256k1, ChaCha20-Poly1305, SHA-256 e altre), l'implementazione di MLS è **ts-mls**.
- L'intera applicazione viene compilata in un unico file html — questo semplifica la distribuzione e gli aggiornamenti.

## Lato server

- **Relay** (server dei messaggi) — utilizza **strfry**, un'implementazione di relay Nostr matura e ampiamente collaudata.
- **Blossom** — un protocollo e server separato per l'archiviazione dei file, legato alle stesse chiavi del resto di Nostr.
- Entrambi i componenti possono essere gestiti da chiunque — vedi la sezione sul server personale nelle impostazioni del profilo.

## Codice sorgente aperto

Il codice del progetto è aperto e sarà completamente consultabile da chiunque su **git.ugolok.tech**.
