# Tecnología y estructura del proyecto

Esta página es para quienes tienen curiosidad por mirar «bajo el capó». No hace falta entenderla para usar la aplicación.

## Protocolo

Ugolok está construido sobre **Nostr** — un protocolo abierto para mensajería descentralizada. La idea central de Nostr es simple: cada usuario tiene un par de claves (pública y privada), los mensajes se firman con la clave privada y se publican en uno o varios servidores (llamados *relays*). Nadie emite cuentas — la identidad la define por completo la clave.

## Cifrado

- Las conversaciones privadas usan **MLS** (Messaging Layer Security) — la misma clase de protocolos que está detrás del cifrado en los grandes mensajeros. Ofrece *forward secrecy*: aunque una clave se filtre en el futuro, no será posible leer retroactivamente conversaciones antiguas.
- El contenido de los canales se cifra con una clave de canal aparte — aquí el forward secrecy se omite deliberadamente (un canal es por naturaleza un archivo al que se vuelve durante años, no una conversación pensada para «olvidarse»).
- La base de datos local del dispositivo también está cifrada — la clave de cifrado se deriva de tu contraseña.
- Los archivos y adjuntos se cifran por separado antes de subirse al servidor de almacenamiento (Blossom) — el servidor solo guarda el texto cifrado.

## De qué está hecha la aplicación

- **Preact** — un motor de interfaz ligero (reactivo, pero muchas veces más pequeño que alternativas más conocidas).
- **Dexie.js** — una envoltura sobre la base de datos integrada del navegador (IndexedDB), donde se guarda toda tu conversación localmente.
- Primitivas criptográficas — bibliotecas de la familia **@noble** (secp256k1, ChaCha20-Poly1305, SHA-256 y otras), la implementación de MLS es **ts-mls**.
- Toda la aplicación se compila en un único archivo html — así es más fácil de desplegar y actualizar.

## Parte de servidor

- **Relay** (servidor de mensajes) — se usa **strfry**, una implementación de relay de Nostr madura y ampliamente probada.
- **Blossom** — un protocolo y servidor aparte para almacenar archivos, vinculado a las mismas claves que el resto de Nostr.
- Ambos componentes puede montarlos cualquiera por su cuenta — ver la sección de servidor propio en los ajustes del perfil.

## Código abierto

El código del proyecto es abierto y estará totalmente disponible para que cualquiera lo estudie en **git.ugolok.tech**.
