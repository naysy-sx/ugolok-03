# Confidentialité : ce qui est protégé et ce qui ne l'est pas

Nous essayons d'être honnêtes sur ce qu'Ugolok offre réellement, plutôt que de promettre plus qu'il ne fait vraiment. Comprendre les limites de la protection fait aussi partie de la sécurité — le plus dangereux est de croire que quelque chose est protégé alors qu'il ne l'est pas réellement.

## Ce qui est caché même au serveur

- **Le contenu des messages.** Le serveur (relay) par lequel passe la conversation ne voit qu'un ensemble d'octets chiffrés — il ne peut pas lire le texte.
- **Les noms des contacts et des groupes**, les noms des chaînes, leurs règles d'accès.
- **Le contenu des fichiers et pièces jointes** — le serveur de stockage ne voit que le texte chiffré.

## Ce que le serveur (relay) voit tout de même

Ce n'est pas un secret ni une lacune propre à Ugolok — c'est ainsi que fonctionne tout serveur par lequel transite du trafic :

- **Qui interagit avec qui et quand** — les clés publiques de l'expéditeur et du destinataire, les horodatages. Le contenu est caché, mais le fait que « ces deux clés se sont échangé quelque chose à tel moment » est visible.
- **Le volume et la fréquence du trafic.**
- **Le statut en ligne** — quand vous êtes connecté au serveur.
- **Quelles étiquettes opaques de chaînes vous lisez** — le relay lui-même ne sait pas de quelle chaîne il s'agit, mais il voit que la même clé s'intéresse régulièrement à la même étiquette.

Si pour vous il est crucial non seulement « que la conversation ne soit pas lue », mais aussi « qu'on ne voie même pas le fait que je l'utilise » — tenez-en compte dans le choix du serveur et de votre comportement.

## Choses à garder en tête séparément

- **Un appareil déverrouillé, c'est un historique de conversation déverrouillé.** Aucun chiffrement ne protège contre une personne ayant un accès physique à l'application déjà ouverte et déverrouillée.
- **Les chaînes n'ont pas de forward secrecy** (contrairement aux messages privés) — c'est une décision délibérée : une chaîne est par nature plus proche d'une archive de publications que d'une conversation, et est destinée à être consultée à nouveau plus tard.
- **Votre interlocuteur voit aussi ce que vous lui avez envoyé**, et peut le copier, le transférer ou l'enregistrer — le chiffrement protège le canal de transmission, pas ce que le destinataire fait ensuite du message.

## Ce que vous pouvez faire vous-même

- Héberger votre propre serveur si vous ne voulez dépendre même pas des serveurs du projet.
- Utiliser des outils de contournement des blocages au niveau réseau si cela vous concerne — Ugolok ne se présente délibérément pas comme un outil de contournement de la censure (voir la section « À propos du projet »), mais rien ne vous empêche de l'utiliser par-dessus une connexion que vous avez déjà configurée.
