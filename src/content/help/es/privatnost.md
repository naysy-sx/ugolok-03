# Privacidad: qué está protegido y qué no

Intentamos ser honestos sobre lo que Ugolok realmente ofrece, en lugar de prometer más de lo que hay en realidad. Entender los límites de la protección también forma parte de la seguridad — lo más peligroso es pensar que algo está protegido cuando en realidad no lo está.

## Qué está oculto incluso para el servidor

- **El contenido de los mensajes.** El servidor (relay) por el que pasa la conversación solo ve un conjunto cifrado de bytes — no puede leer el texto.
- **Los nombres de contactos y grupos**, los nombres de los canales, sus reglas de acceso.
- **El contenido de archivos y adjuntos** — el servidor de almacenamiento solo ve el texto cifrado.

## Qué puede ver de todos modos el servidor (relay)

Esto no es un secreto ni una carencia propia de Ugolok — así funciona cualquier servidor por el que pasa el tráfico:

- **Quién interactúa con quién y cuándo** — las claves públicas del remitente y del destinatario, las marcas de tiempo. El contenido está oculto, pero el hecho de que «estas dos claves se intercambiaron algo en tal momento» es visible.
- **El volumen y la frecuencia del tráfico.**
- **El estado en línea** — cuándo estás conectado al servidor.
- **Qué etiquetas opacas de canales lees** — el propio relay no sabe de qué canal se trata, pero ve que la misma clave se interesa regularmente por la misma etiqueta.

Si para ti es crítico no solo «que no se lea la conversación», sino «que no se vea el hecho mismo de que la uso» — ten esto en cuenta al elegir servidor y modo de comportamiento.

## Cosas que conviene recordar aparte

- **Un dispositivo desbloqueado es una conversación desbloqueada.** Ningún cifrado protege frente a una persona con acceso físico a la aplicación ya abierta y desbloqueada.
- **Los canales no tienen forward secrecy** (a diferencia de los mensajes privados) — es una decisión deliberada: un canal se parece por naturaleza más a un archivo que a una conversación, y está pensado para que se vuelva a él con el tiempo.
- **El interlocutor también ve lo que le has enviado**, y puede copiarlo, reenviarlo o guardarlo — el cifrado protege el canal de transmisión, no lo que el destinatario haga después con el mensaje.

## Qué puedes hacer tú mismo

- Montar tu propio servidor si no quieres depender ni siquiera de los servidores del proyecto.
- Usar herramientas de elusión de bloqueos a nivel de red si es relevante para ti — Ugolok deliberadamente no se presenta como una herramienta contra la censura (ver la sección «Sobre el proyecto»), pero nada impide usarlo sobre una conexión que ya hayas configurado tú mismo.
