"""
Servidor da Bolsa de Valores Fictícia (protocolo BVF/1.0).

Uso:  python servidor.py [porta] [--debug]     (porta padrão: 5000)

O arquivo tem duas partes bem separadas:

  * LÓGICA DO JOGO: ações, preços, carteiras e os comandos (HELLO, BUY...).
    Cada comando recebe argumentos e devolve (código, linhas); ele não sabe
    nada de rede.

  * REDE (no final do arquivo): o ciclo de vida de um socket SERVIDOR TCP:

        1. socket()   cria o socket
        2. bind()     associa o socket a um IP e uma porta
        3. listen()   passa a aceitar pedidos de conexão
        4. accept()   espera um cliente e cria um socket NOVO só para ele
        5. recv/send  conversa com esse cliente
        6. close()    encerra a conversa

    Cada cliente é atendido em uma thread própria, para que vários possam
    jogar ao mesmo tempo. Outra thread atualiza os preços das ações.
"""

import random
import socket
import sys
import threading
import time

import protocolo

argumentos = [a for a in sys.argv[1:] if a != "--debug"]
protocolo.DEBUG = "--debug" in sys.argv

HOST = "0.0.0.0"   # 0.0.0.0 = aceitar conexões em qualquer placa de rede da máquina
PORTA = int(argumentos[0]) if argumentos else protocolo.PORTA_PADRAO
SALDO_INICIAL = 10_000.00
INTERVALO_PRECOS = 5      # segundos entre atualizações de preço
CHANCE_NOTICIA = 0.25     # chance de sair uma notícia a cada atualização
PRECO_MINIMO = 0.50

# ticker -> dados da empresa
ACOES = {
    "CAFE3": {"nome": "Café do Campus S.A.",       "preco": 25.00},
    "PAOQ4": {"nome": "Pão de Queijo Holding",     "preco": 12.50},
    "REDE3": {"nome": "RedesNet Telecom",          "preco": 48.00},
    "BUGS4": {"nome": "Bugs & Cia Software",       "preco": 8.75},
    "ROBO3": {"nome": "Robôs do Nordeste",         "preco": 33.20},
    "SONO3": {"nome": "Sono Profundo Colchões",    "preco": 19.90},
}
HISTORICO_MAX = 120       # pontos guardados por ação (120 x 5 s = 10 minutos)


def passo_aleatorio(preco):
    """Um "tique" do mercado: o preço anda um pouquinho para cima ou para baixo."""
    return max(PRECO_MINIMO, round(preco * (1 + random.gauss(0, 0.02)), 2))


# Inventa 5 minutos de pregão anteriores, para os gráficos já começarem com dados.
_agora = time.time()
for dados in ACOES.values():
    dados["abertura"] = dados["preco"]
    dados["historico"] = []          # lista de (hora "hh:mm:ss", preço)
    for i in range(60, 0, -1):
        hora = time.strftime("%H:%M:%S", time.localtime(_agora - i * INTERVALO_PRECOS))
        dados["historico"].append((hora, dados["preco"]))
        dados["preco"] = passo_aleatorio(dados["preco"])
    dados["historico"].append((time.strftime("%H:%M:%S"), dados["preco"]))

NOTICIAS_BOAS = [
    "{nome} anuncia lucro recorde!",
    "{nome} fecha parceria com a NASA",
    "Professor elogia {nome} em sala de aula",
    "{nome} lança produto que viraliza nas redes",
]
NOTICIAS_RUINS = [
    "{nome} é investigada por usar o Wi-Fi do vizinho",
    "CEO da {nome} esquece a senha do servidor",
    "{nome} sofre ataque de DDoS",
    "Estagiário da {nome} roda 'rm -rf /' em produção",
]

jogadores = {}        # nome -> {"saldo": float, "carteira": {ticker: qtd}}
conectados = set()    # nomes com sessão ativa no momento
noticias = []         # lista de strings "[hh:mm:ss] texto"
negociacoes = []      # lista de strings "[hh:mm:ss] ana COMPROU 10 CAFE3 A R$ 25,00"
trava = threading.Lock()


# ---------------------------------------------------------------- utilidades

def brl(valor):
    """Formata um número como dinheiro: 1234.5 -> 'R$ 1.234,50'."""
    texto = f"{valor:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {texto}"


def resposta(codigo, linhas):
    """Padroniza o retorno dos comandos: (código, lista de linhas).
    Quem transforma isso em bytes na rede é protocolo.enviar_resposta()."""
    if isinstance(linhas, str):
        linhas = [linhas]
    return codigo, linhas


def patrimonio(jogador):
    total = jogador["saldo"]
    for ticker, qtd in jogador["carteira"].items():
        total += qtd * ACOES[ticker]["preco"]
    return total


def variacao(atual, base):
    return (atual - base) / base * 100


# --------------------------------------------------------- mercado (thread)

def atualizar_mercado():
    while True:
        time.sleep(INTERVALO_PRECOS)
        with trava:
            for dados in ACOES.values():
                dados["preco"] = passo_aleatorio(dados["preco"])

            if random.random() < CHANCE_NOTICIA:
                ticker = random.choice(list(ACOES))
                dados = ACOES[ticker]
                if random.random() < 0.5:
                    fator = 1 + random.uniform(0.08, 0.20)
                    modelo = random.choice(NOTICIAS_BOAS)
                else:
                    fator = 1 - random.uniform(0.08, 0.20)
                    modelo = random.choice(NOTICIAS_RUINS)
                dados["preco"] = max(PRECO_MINIMO, round(dados["preco"] * fator, 2))
                texto = modelo.format(nome=dados["nome"])
                sinal = "+" if fator > 1 else ""
                noticias.append(f"[{time.strftime('%H:%M:%S')}] {texto} "
                                f"({ticker} {sinal}{(fator - 1) * 100:.1f}%)")
                del noticias[:-20]   # guarda só as 20 mais recentes
                print("NOTÍCIA:", noticias[-1])

            hora = time.strftime("%H:%M:%S")
            for dados in ACOES.values():
                dados["historico"].append((hora, dados["preco"]))
                del dados["historico"][:-HISTORICO_MAX]


# ------------------------------------------------------------ comandos

AJUDA = [
    "COMANDOS DISPONÍVEIS:",
    "HELLO <apelido>        entra no jogo (obrigatório para negociar)",
    "LIST                   lista todas as ações e preços",
    "QUOTE <ticker>         mostra detalhes de uma ação",
    "HISTORY <ticker>       histórico de preços (últimos 10 minutos)",
    "BUY <ticker> <qtd>     compra ações",
    "SELL <ticker> <qtd>    vende ações",
    "PORTFOLIO              mostra seu saldo e suas ações",
    "RANKING                classificação dos investidores",
    "NEWS                   últimas notícias do mercado",
    "TRADES                 últimas compras e vendas de todos os jogadores",
    "HELP                   mostra esta ajuda",
    "BYE                    encerra a conexão",
]


def cmd_hello(sessao, args):
    if sessao["nome"]:
        return resposta(406, f"VOCÊ JÁ ESTÁ IDENTIFICADO COMO {sessao['nome']}")
    if len(args) != 1 or not args[0].isalnum() or len(args[0]) > 15:
        return resposta(405, "USO: HELLO <apelido> (só letras/números, até 15 caracteres)")
    nome = args[0]
    with trava:
        if nome in conectados:
            return resposta(409, f"O APELIDO {nome} JÁ ESTÁ EM USO")
        novo = nome not in jogadores
        if novo:
            jogadores[nome] = {"saldo": SALDO_INICIAL, "carteira": {}}
        conectados.add(nome)
        saldo = jogadores[nome]["saldo"]
    sessao["nome"] = nome
    msg = "BEM-VINDO" if novo else "BEM-VINDO DE VOLTA"
    return resposta(200, f"{msg}, {nome}! SALDO: {brl(saldo)}")


def cmd_list(sessao, args):
    linhas = ["TICKER  PREÇO         VAR.DIA   EMPRESA"]
    with trava:
        for ticker, d in ACOES.items():
            var = variacao(d["preco"], d["abertura"])
            linhas.append(f"{ticker:<7} {brl(d['preco']):<13} {var:+6.2f}%   {d['nome']}")
    return resposta(210, linhas)


def cmd_quote(sessao, args):
    if len(args) != 1:
        return resposta(405, "USO: QUOTE <ticker>")
    ticker = args[0].upper()
    with trava:
        if ticker not in ACOES:
            return resposta(404, f"AÇÃO {ticker} NÃO ENCONTRADA")
        d = ACOES[ticker]
        linhas = [
            f"{ticker} - {d['nome']}",
            f"PREÇO ATUAL: {brl(d['preco'])}",
            f"ABERTURA:    {brl(d['abertura'])}",
            f"VARIAÇÃO:    {variacao(d['preco'], d['abertura']):+.2f}%",
        ]
    return resposta(211, linhas)


def cmd_history(sessao, args):
    if len(args) != 1:
        return resposta(405, "USO: HISTORY <ticker>")
    ticker = args[0].upper()
    with trava:
        if ticker not in ACOES:
            return resposta(404, f"AÇÃO {ticker} NÃO ENCONTRADA")
        pontos = list(ACOES[ticker]["historico"])
    linhas = [f"{ticker} {len(pontos)} PONTOS"]
    linhas += [f"{hora} {brl(preco)}" for hora, preco in pontos]
    return resposta(216, linhas)


def ler_ordem(args, comando):
    """Valida '<ticker> <qtd>'. Devolve (ticker, qtd, None) ou (None, None, erro)."""
    if len(args) != 2:
        return None, None, resposta(405, f"USO: {comando} <ticker> <qtd>")
    ticker = args[0].upper()
    if ticker not in ACOES:
        return None, None, resposta(404, f"AÇÃO {ticker} NÃO ENCONTRADA")
    if not args[1].isdigit() or int(args[1]) <= 0:
        return None, None, resposta(405, "A QUANTIDADE DEVE SER UM INTEIRO POSITIVO")
    return ticker, int(args[1]), None


def registrar_negociacao(nome, verbo, qtd, ticker, preco):
    """Guarda a negociação para o comando TRADES. Chamar com a trava já pega."""
    texto = f"[{time.strftime('%H:%M:%S')}] {nome} {verbo} {qtd} {ticker} A {brl(preco)}"
    negociacoes.append(texto)
    del negociacoes[:-30]          # guarda só as 30 mais recentes
    print("NEGOCIAÇÃO:", texto)


def cmd_buy(sessao, args):
    ticker, qtd, erro = ler_ordem(args, "BUY")
    if erro:
        return erro
    with trava:
        jogador = jogadores[sessao["nome"]]
        preco = ACOES[ticker]["preco"]
        custo = round(preco * qtd, 2)
        if custo > jogador["saldo"]:
            return resposta(402, f"SALDO INSUFICIENTE: CUSTA {brl(custo)}, "
                                 f"VOCÊ TEM {brl(jogador['saldo'])}")
        jogador["saldo"] = round(jogador["saldo"] - custo, 2)
        jogador["carteira"][ticker] = jogador["carteira"].get(ticker, 0) + qtd
        saldo = jogador["saldo"]
        registrar_negociacao(sessao["nome"], "COMPROU", qtd, ticker, preco)
    return resposta(201, f"COMPROU {qtd} {ticker} A {brl(preco)} "
                         f"(TOTAL {brl(custo)}). SALDO: {brl(saldo)}")


def cmd_sell(sessao, args):
    ticker, qtd, erro = ler_ordem(args, "SELL")
    if erro:
        return erro
    with trava:
        jogador = jogadores[sessao["nome"]]
        tem = jogador["carteira"].get(ticker, 0)
        if qtd > tem:
            return resposta(403, f"VOCÊ SÓ TEM {tem} AÇÕES DE {ticker}")
        preco = ACOES[ticker]["preco"]
        valor = round(preco * qtd, 2)
        jogador["saldo"] = round(jogador["saldo"] + valor, 2)
        jogador["carteira"][ticker] = tem - qtd
        if jogador["carteira"][ticker] == 0:
            del jogador["carteira"][ticker]
        saldo = jogador["saldo"]
        registrar_negociacao(sessao["nome"], "VENDEU", qtd, ticker, preco)
    return resposta(202, f"VENDEU {qtd} {ticker} A {brl(preco)} "
                         f"(TOTAL {brl(valor)}). SALDO: {brl(saldo)}")


def cmd_portfolio(sessao, args):
    with trava:
        jogador = jogadores[sessao["nome"]]
        linhas = [f"CARTEIRA DE {sessao['nome']}", f"SALDO EM CAIXA: {brl(jogador['saldo'])}"]
        if not jogador["carteira"]:
            linhas.append("(nenhuma ação ainda - use BUY)")
        for ticker, qtd in jogador["carteira"].items():
            preco = ACOES[ticker]["preco"]
            linhas.append(f"{ticker:<7} {qtd:>5} x {brl(preco):<12} = {brl(qtd * preco)}")
        total = patrimonio(jogador)
        linhas.append(f"PATRIMÔNIO TOTAL: {brl(total)} "
                      f"({variacao(total, SALDO_INICIAL):+.2f}%)")
    return resposta(212, linhas)


def cmd_ranking(sessao, args):
    with trava:
        lista = sorted(((patrimonio(j), nome) for nome, j in jogadores.items()), reverse=True)
    if not lista:
        return resposta(213, "NINGUÉM ESTÁ JOGANDO AINDA")
    linhas = ["RANKING DOS INVESTIDORES"]
    for pos, (total, nome) in enumerate(lista[:10], start=1):
        linhas.append(f"{pos:>2}. {nome:<15} {brl(total):<15} "
                      f"({variacao(total, SALDO_INICIAL):+.2f}%)")
    return resposta(213, linhas)


def cmd_news(sessao, args):
    with trava:
        ultimas = noticias[-5:]
    if not ultimas:
        return resposta(214, "NENHUMA NOTÍCIA POR ENQUANTO")
    return resposta(214, ["ÚLTIMAS NOTÍCIAS"] + ultimas[::-1])


def cmd_trades(sessao, args):
    with trava:
        ultimas = negociacoes[-10:]
    if not ultimas:
        return resposta(217, "NENHUMA NEGOCIAÇÃO AINDA")
    return resposta(217, ["ÚLTIMAS NEGOCIAÇÕES"] + ultimas[::-1])   # mais recente primeiro


def cmd_help(sessao, args):
    return resposta(215, AJUDA)


# comando -> (função, precisa ter feito HELLO?)
COMANDOS = {
    "HELLO":     (cmd_hello, False),
    "LIST":      (cmd_list, False),
    "QUOTE":     (cmd_quote, False),
    "HISTORY":   (cmd_history, False),
    "BUY":       (cmd_buy, True),
    "SELL":      (cmd_sell, True),
    "PORTFOLIO": (cmd_portfolio, True),
    "RANKING":   (cmd_ranking, False),
    "NEWS":      (cmd_news, False),
    "TRADES":    (cmd_trades, False),
    "HELP":      (cmd_help, False),
}


def processar(linha, sessao):
    partes = linha.split()
    if not partes:
        return resposta(400, "COMANDO VAZIO")
    comando, args = partes[0].upper(), partes[1:]
    if comando not in COMANDOS:
        return resposta(400, f"COMANDO DESCONHECIDO: {comando} (digite HELP)")
    funcao, exige_login = COMANDOS[comando]
    if exige_login and not sessao["nome"]:
        return resposta(401, "IDENTIFIQUE-SE PRIMEIRO COM HELLO <apelido>")
    return funcao(sessao, args)


# =====================================================================
#                              PARTE DE REDE
# =====================================================================

def atender_cliente(sock_cliente, endereco):
    """Conversa com UM cliente. Roda numa thread só dele (PASSO 5 e 6)."""
    ip, porta = endereco
    rotulo = f"{ip}:{porta}"
    print(f"[+] Cliente conectou: {rotulo}")

    conexao = protocolo.Conexao(sock_cliente, apelido=rotulo)
    sessao = {"nome": None}   # estado desta conexão (quem é o jogador)

    try:
        # Pelo protocolo, o servidor fala primeiro: manda a saudação.
        protocolo.enviar_resposta(conexao, 100,
                                  ["BOLSA DE VALORES FICTÍCIA - BVF/1.0. DIGITE HELP"])

        # Laço principal: recebe UM pedido, processa, envia UMA resposta.
        while True:
            linha = conexao.receber_linha()
            if linha is None:                 # cliente fechou sem mandar BYE
                break
            linha = linha.strip().lstrip("﻿")   # ignora BOM, se vier
            print(f"    {rotulo} [{sessao['nome'] or '-'}] pediu: {linha}")

            if linha.upper() == "BYE":
                protocolo.enviar_resposta(conexao, 221, ["ATÉ LOGO! BONS INVESTIMENTOS"])
                break

            codigo, linhas = processar(linha, sessao)
            protocolo.enviar_resposta(conexao, codigo, linhas)

    except (ConnectionError, UnicodeDecodeError) as erro:
        print(f"[!] Erro com {rotulo}: {erro}")

    finally:
        # PASSO 6 - close(): encerra a conexão com este cliente.
        conexao.fechar()
        if sessao["nome"]:
            with trava:
                conectados.discard(sessao["nome"])
        print(f"[-] Cliente desconectou: {rotulo} ({sessao['nome'] or 'anônimo'})")


def main():
    # Thread que fica mexendo nos preços enquanto o servidor roda.
    threading.Thread(target=atualizar_mercado, daemon=True).start()

    # PASSO 1 - socket(): cria o socket.
    #   AF_INET     = endereços IPv4
    #   SOCK_STREAM = TCP
    servidor = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

    # Permite reabrir o servidor na mesma porta logo após fechá-lo
    # (sem isso o sistema às vezes diz "endereço já em uso" por um tempo).
    servidor.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

    # PASSO 2 - bind(): "prende" o socket a um IP e uma porta.
    servidor.bind((HOST, PORTA))

    # PASSO 3 - listen(): o socket passa a ser um socket de ESCUTA.
    #   O número é o tamanho da fila de conexões esperando o accept().
    servidor.listen(5)
    print(f"Bolsa aberta! Escutando em {HOST}:{PORTA}. Ctrl+C para encerrar.")

    # No Windows, o Ctrl+C não interrompe um accept() parado. Com um timeout
    # de 1 s, o accept() "acorda" a cada segundo e o Ctrl+C funciona.
    servidor.settimeout(1.0)

    try:
        while True:
            # PASSO 4 - accept(): espera um cliente conectar.
            #   Devolve um socket NOVO, exclusivo para esse cliente, e o
            #   endereço (IP, porta) dele. O socket 'servidor' continua
            #   livre para aceitar os próximos clientes.
            try:
                sock_cliente, endereco = servidor.accept()
            except socket.timeout:
                continue          # ninguém chegou neste segundo; tenta de novo

            sock_cliente.settimeout(None)   # o socket do cliente volta a ser bloqueante

            # Cada cliente ganha uma thread; assim um cliente lento não
            # trava o atendimento dos outros.
            threading.Thread(target=atender_cliente,
                             args=(sock_cliente, endereco),
                             daemon=True).start()

    except KeyboardInterrupt:
        print("\nBolsa fechada.")
    finally:
        servidor.close()


if __name__ == "__main__":
    main()
