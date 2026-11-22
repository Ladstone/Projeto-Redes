# Bolsa de Valores Fictícia — Protocolo BVF/1.0

Projeto do 2º EE de Redes: um servidor que simula uma bolsa de valores com
empresas inventadas e um cliente que negocia ações por um protocolo de texto
próprio sobre TCP.

O servidor muda os preços a cada 5 segundos (passeio aleatório) e, de vez em
quando, publica uma **notícia** que faz uma ação subir ou despencar. Vários
clientes podem jogar ao mesmo tempo e competir no ranking.

**Nenhum framework:** só os módulos `socket` e `threading` da biblioteca
padrão do Python.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `protocolo.py` | A parte de rede compartilhada: envia e recebe linhas por TCP com `send()`/`recv()` e monta/lê as respostas com código |
| `servidor.py` | A lógica da bolsa (no topo) e o socket servidor: `socket → bind → listen → accept` (no final) |
| `cliente.py` | O socket cliente: `socket → connect → send/recv → close` |

## Como rodar

Requer Python 3.8+.

```bash
python servidor.py            # porta 5000 (ou: python servidor.py 6000)
python cliente.py             # conecta em 127.0.0.1:5000
python cliente.py 192.168.0.10 5000   # outra máquina da rede
python cliente.py --debug     # mostra os bytes de cada send()/recv()
```

## Como funciona a parte de rede

```
        SERVIDOR                                CLIENTE
   1. socket()                             1. socket()
   2. bind(0.0.0.0, 5000)
   3. listen()
   4. accept()  ... espera ...  <──────    2. connect(IP, 5000)
      (TCP faz o handshake SYN / SYN-ACK / ACK)
      accept() devolve um socket NOVO
      só para esse cliente → nova thread
   5. send("100 BOLSA ...")    ──────>        recv()
      recv()                   <──────     3. send("BUY CAFE3 10")
      send("201 COMPROU ...")  ──────>        recv()
            ...                                 ...
      recv()                   <──────        send("BYE")
      send("221 ATÉ LOGO")     ──────>        recv()
   6. close()                              4. close()
```

**Por que um buffer?** O TCP entrega um *fluxo de bytes*, não mensagens.
Dois `send()` podem chegar juntos num único `recv()`, e uma mensagem pode
chegar picada em vários. Por isso o protocolo define que cada mensagem termina
em `\r\n`. O receptor acumula bytes num buffer e só processa uma linha quando
o `\r\n` dela chega. Rodando com `--debug` dá para ver isso acontecendo: o
servidor manda a lista de ações linha por linha e o cliente recebe várias
linhas num mesmo `recv()`.

**Por que threads?** `accept()` e `recv()` *bloqueiam* (o programa fica parado
esperando). Se o servidor atendesse todo mundo numa única thread, um cliente
parado no prompt travaria todos os outros. Com uma thread por cliente, cada
conversa espera sozinha. Os dados compartilhados (preços e carteiras) são
protegidos por um `threading.Lock`.

Exemplo de sessão:

```
[100] BOLSA DE VALORES FICTÍCIA - BVF/1.0. DIGITE HELP
> HELLO ana
[200] BEM-VINDO, ana! SALDO: R$ 10.000,00
> BUY CAFE3 100
[201] COMPROU 100 CAFE3 A R$ 25,00 (TOTAL R$ 2.500,00). SALDO: R$ 7.500,00
> SELL CAFE3 500
[403] ERRO VOCÊ SÓ TEM 100 AÇÕES DE CAFE3
```

## Especificação do protocolo

- Transporte: **TCP**, porta padrão **5000**.
- Codificação: **UTF-8**, cada mensagem é uma linha terminada em `\r\n`.
- Comandos não diferenciam maiúsculas de minúsculas (`buy cafe3 10` funciona).
- Ao conectar, o servidor envia a saudação `100`.

### Formato das respostas

Toda resposta começa com um código de 3 dígitos (inspirado em SMTP/FTP):

```
CCC texto                 resposta de uma linha
CCC-linha 1               resposta de várias linhas: o hífen indica
CCC-linha 2               que ainda vem mais coisa; a última linha
CCC última linha          usa espaço depois do código
```

### Comandos

| Comando | Parâmetros | Precisa HELLO? | Sucesso | Erros possíveis |
|---|---|---|---|---|
| `HELLO` | `<apelido>` | — | `200` | `405`, `406`, `409` |
| `LIST` | — | não | `210` (várias linhas) | — |
| `QUOTE` | `<ticker>` | não | `211` (várias linhas) | `404`, `405` |
| `BUY` | `<ticker> <qtd>` | sim | `201` | `401`, `402`, `404`, `405` |
| `SELL` | `<ticker> <qtd>` | sim | `202` | `401`, `403`, `404`, `405` |
| `PORTFOLIO` | — | sim | `212` (várias linhas) | `401` |
| `RANKING` | — | não | `213` (várias linhas) | — |
| `NEWS` | — | não | `214` (várias linhas) | — |
| `HELP` | — | não | `215` (várias linhas) | — |
| `BYE` | — | não | `221` e o servidor fecha a conexão | — |

### Códigos de resposta

| Código | Significado |
|---|---|
| `100` | Saudação ao conectar |
| `200` | Identificação aceita |
| `201` | Compra realizada |
| `202` | Venda realizada |
| `210`–`215` | Respostas de consulta (lista, cotação, carteira, ranking, notícias, ajuda) |
| `221` | Encerramento da conexão |
| `400` | Comando vazio ou desconhecido |
| `401` | É preciso se identificar com `HELLO` antes |
| `402` | Saldo insuficiente |
| `403` | Quantidade de ações insuficiente para vender |
| `404` | Ação (ticker) não encontrada |
| `405` | Parâmetros inválidos |
| `406` | Cliente já identificado |
| `409` | Apelido já em uso por outra conexão |

Faixas: `1xx` informativo, `2xx` sucesso, `4xx` erro do cliente.

## Regras do jogo

- Cada investidor começa com **R$ 10.000,00**.
- Preços variam a cada 5 s; notícias mexem 8–20% numa ação.
- Patrimônio = saldo + valor atual das ações. O `RANKING` ordena por patrimônio.
- Se o cliente cair e voltar com o mesmo apelido, recupera a carteira
  (enquanto o servidor estiver rodando).

## Ações disponíveis

| Ticker | Empresa | Preço inicial |
|---|---|---|
| CAFE3 | Café do Campus S.A. | R$ 25,00 |
| PAOQ4 | Pão de Queijo Holding | R$ 12,50 |
| REDE3 | RedesNet Telecom | R$ 48,00 |
| BUGS4 | Bugs & Cia Software | R$ 8,75 |
| ROBO3 | Robôs do Nordeste | R$ 33,20 |
| SONO3 | Sono Profundo Colchões | R$ 19,90 |
