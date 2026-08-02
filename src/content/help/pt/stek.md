# Tecnologia e estrutura do projeto

Esta página é para quem tem curiosidade de olhar "por baixo do capô". Não é preciso entendê-la para usar o aplicativo.

## Protocolo

O Ugolok é construído sobre o **Nostr** — um protocolo aberto para mensagens descentralizadas. A ideia central do Nostr é simples: cada usuário tem um par de chaves (pública e privada), as mensagens são assinadas com a chave privada e publicadas em um ou mais servidores (chamados de *relays*). Ninguém emite contas — a identidade é definida inteiramente pela chave.

## Criptografia

- As conversas privadas usam **MLS** (Messaging Layer Security) — a mesma classe de protocolo que serve de base para a criptografia dos grandes mensageiros. Ele oferece *forward secrecy*: mesmo que uma chave vaze no futuro, não será possível ler conversas antigas retroativamente.
- O conteúdo dos canais é criptografado com uma chave de canal separada — o forward secrecy é deliberadamente não aplicado aqui (um canal é, por natureza, um arquivo ao qual se retorna ao longo dos anos, não uma conversa feita para ser "esquecida").
- O banco de dados local no dispositivo também é criptografado — a chave de criptografia é derivada da sua senha.
- Arquivos e anexos são criptografados separadamente antes de serem enviados ao servidor de armazenamento (Blossom) — o servidor só armazena o texto cifrado.

## Do que o aplicativo é feito

- **Preact** — um motor de interface leve (reativo, mas muitas vezes menor que alternativas mais conhecidas).
- **Dexie.js** — uma camada sobre o banco de dados embutido no navegador (IndexedDB), onde toda a sua conversa é armazenada localmente.
- Primitivas criptográficas — bibliotecas da família **@noble** (secp256k1, ChaCha20-Poly1305, SHA-256 e outras), a implementação de MLS é a **ts-mls**.
- Todo o aplicativo é compilado em um único arquivo html — o que simplifica a implantação e atualização.

## Lado do servidor

- **Relay** (servidor de mensagens) — usa o **strfry**, uma implementação de relay Nostr madura e amplamente testada.
- **Blossom** — um protocolo e servidor separado para armazenamento de arquivos, vinculado às mesmas chaves que o resto do Nostr.
- Ambos os componentes podem ser hospedados por qualquer pessoa — veja a seção sobre servidor próprio nas configurações do perfil.

## Código aberto

O código do projeto é aberto e ficará totalmente disponível para qualquer pessoa estudar em **git.ugolok.tech**.
