# Privacidade: o que é protegido e o que não é

Tentamos ser honestos sobre o que o Ugolok realmente oferece, em vez de prometer mais do que ele de fato entrega. Entender os limites da proteção também faz parte da segurança — o mais perigoso é achar que algo está protegido quando na verdade não está.

## O que fica oculto até mesmo do servidor

- **O conteúdo das mensagens.** O servidor (relay) pelo qual a conversa passa só vê um conjunto de bytes criptografados — ele não consegue ler o texto.
- **Nomes de contatos e grupos**, nomes de canais, suas regras de acesso.
- **O conteúdo de arquivos e anexos** — o servidor de armazenamento só vê o texto cifrado.

## O que o servidor (relay) ainda assim vê

Isso não é um segredo nem uma falha específica do Ugolok — é assim que qualquer servidor pelo qual passa tráfego funciona:

- **Quem interage com quem e quando** — as chaves públicas do remetente e do destinatário, os registros de tempo. O conteúdo fica oculto, mas o fato de que "essas duas chaves trocaram algo nesse momento" é visível.
- **Volume e frequência do tráfego.**
- **Status online** — quando você está conectado ao servidor.
- **Quais tags opacas de canais você lê** — o próprio relay não sabe qual é o canal, mas vê que a mesma chave se interessa regularmente pela mesma tag.

Se for crítico para você não apenas "que a conversa não seja lida", mas "que não haja nem sinal visível de que eu uso isso" — leve isso em conta ao escolher o servidor e seu comportamento.

## Coisas que vale lembrar separadamente

- **Um dispositivo desbloqueado é um histórico de conversas desbloqueado.** Nenhuma criptografia protege contra uma pessoa com acesso físico ao aplicativo já aberto e desbloqueado.
- **Canais não têm forward secrecy** (ao contrário das mensagens privadas) — essa é uma decisão deliberada: um canal é, por natureza, mais parecido com um arquivo do que com uma conversa, e serve para ser revisitado ao longo do tempo.
- **A outra pessoa também vê o que você enviou a ela**, e pode copiar, encaminhar ou salvar — a criptografia protege o canal de transmissão, não o que o destinatário faz com a mensagem depois.

## O que você pode fazer por conta própria

- Manter seu próprio servidor, se não quiser depender nem mesmo dos servidores do projeto.
- Usar ferramentas de contorno de bloqueios em nível de rede, se isso for relevante para você — o Ugolok deliberadamente não se posiciona como uma ferramenta de burlar censura (veja a seção "Sobre o projeto"), mas nada impede que você o use sobre uma conexão que já configurou por conta própria.
