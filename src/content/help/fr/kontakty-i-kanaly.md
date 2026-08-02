# Contacts et chaînes

## Comment ajouter un contact

Ugolok n'a ni numéro de téléphone ni pseudonyme permettant de vous « trouver » — chaque personne dispose à la place d'une clé publique (elle commence par `npub1...`). C'est à la fois une adresse et quelque chose qui ne peut pas être falsifié : un message envoyé avec cette clé provient forcément d'elle, et de personne d'autre.

Marche à suivre :

1. Demandez à la personne avec qui vous voulez échanger sa clé publique (`npub...`) — elle peut être copiée depuis l'écran « Profil » et transmise par n'importe quel moyen (à voix haute, via une autre messagerie, montrée en personne).
2. Ouvrez la section « Contacts » → « Ajouter un contact » et collez la clé reçue.
3. La personne recevra une demande. Elle doit l'accepter de son côté.
4. Après accord mutuel, vous devenez contacts et pouvez échanger.

Une demande peut être annulée ou refusée à tout moment — rien ne se produit sans le consentement explicite des deux parties.

**Important :** tant que vous n'avez pas échangé vos clés par un canal indépendant (en personne, par téléphone, dans une autre messagerie), vous ne pouvez pas être totalement certain qu'une clé appartient réellement à la personne avec qui vous voulez communiquer — c'est une règle générale pour tout système basé sur des clés, pas une particularité d'Ugolok.

## Comment fonctionnent les groupes de contacts

Tous vos contacts peuvent être organisés en groupes (par exemple « Famille », « Travail », « Amis ») — c'est utile en soi, et aussi parce que l'accès à vos chaînes dépend directement des groupes (voir ci-dessous).

## Comment fonctionne l'accès aux chaînes

Une chaîne est votre propre espace personnel (quelque chose entre un fil de publications et une discussion de groupe) que vous, son créateur, contrôlez.

Lorsque vous créez une chaîne, vous choisissez immédiatement **lesquels de vos groupes de contacts** pourront la voir. C'est un choix de conception délibéré du projet : un inconnu ne peut pas « frapper » directement à la porte d'une chaîne — il doit d'abord devenir votre contact et se retrouver dans l'un des groupes auxquels vous avez donné accès.

Cela peut sembler à certains une restriction excessive — on n'a pas toujours envie d'ajouter quelqu'un à ses contacts à l'avance juste pour lui laisser lire une chaîne. Nous avons délibérément choisi ce modèle : il est plus simple à comprendre (« soit j'ai accès, soit non — et je sais exactement par quel groupe ») et ne laisse pas de « trous » accidentels par lesquels l'accès pourrait aboutir chez quelqu'un d'imprévu.

Distinct du droit de *lire* une chaîne, il existe le droit de *commenter* — même si une personne a déjà un accès en lecture (via un groupe), pour commenter, elle envoie une demande séparée que vous approuvez. C'est une strate supplémentaire, pas un remplacement de la règle des groupes décrite ci-dessus.
