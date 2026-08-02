# Contatos e canais

## Como adicionar um contato

O Ugolok não tem números de telefone nem apelidos pelos quais alguém possa "encontrar" você — em vez disso, cada pessoa tem uma chave pública (que começa com `npub1...`). Isso é ao mesmo tempo um endereço e algo que não pode ser falsificado: uma mensagem enviada com essa chave vem garantidamente dela, e não de outra pessoa.

Passos:

1. Peça à pessoa com quem você quer conversar sua chave pública (`npub...`) — ela pode ser copiada na tela "Perfil" e enviada de qualquer forma (por voz, em outro mensageiro, mostrada pessoalmente).
2. Abra a seção "Contatos" → "Adicionar contato" e cole a chave recebida.
3. A pessoa receberá uma solicitação. Ela precisa aceitá-la do lado dela.
4. Após o acordo mútuo, vocês se tornam contatos e podem conversar.

Uma solicitação pode ser cancelada ou recusada a qualquer momento — nada acontece sem o consentimento explícito de ambas as partes.

**Importante:** enquanto vocês não trocarem as chaves por algum canal independente (pessoalmente, por telefone, em outro mensageiro), você não pode ter certeza absoluta de que uma chave realmente pertence à pessoa com quem quer falar — essa é uma regra geral de qualquer sistema baseado em chaves, não uma peculiaridade do Ugolok.

## Como funcionam os grupos de contatos

Todos os seus contatos podem ser organizados em grupos (por exemplo, "Família", "Trabalho", "Amigos") — isso é útil por si só, e também porque o acesso aos seus canais depende diretamente dos grupos (veja abaixo).

## Como funciona o acesso aos canais

Um canal é seu próprio espaço pessoal (algo entre um feed de publicações e um chat em grupo) que você, seu criador, controla.

Ao criar um canal, você escolhe imediatamente **quais dos seus grupos de contatos** poderão vê-lo. Essa é uma decisão de design deliberada do projeto: um estranho não pode "bater à porta" de um canal diretamente — primeiro ele precisa se tornar seu contato e entrar em um dos grupos aos quais você deu acesso.

Para alguns, isso pode parecer uma restrição excessiva — nem sempre se quer adicionar alguém aos contatos antecipadamente só para deixá-lo ler um canal. Escolhemos esse modelo deliberadamente: é mais fácil de entender ("ou eu tenho acesso ou não tenho — e sei exatamente por qual grupo") e não deixa "buracos" acidentais pelos quais o acesso poderia acabar chegando a alguém não pretendido.

Separado do direito de *ler* um canal, existe o direito de *comentar* — mesmo que uma pessoa já tenha acesso de leitura (por meio de um grupo), para comentar ela envia uma solicitação separada, que você aprova. Essa é uma camada adicional, não um substituto da regra de grupos descrita acima.
