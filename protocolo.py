"""
protocolo.py - a parte de REDE do projeto, compartilhada por cliente e servidor.

Aqui NÃO há nada sobre ações ou bolsa de valores. Este arquivo só resolve
um problema: como mandar e receber MENSAGENS (linhas de texto) por um
socket TCP.

-------------------------------------------------------------------------
POR QUE ISSO É NECESSÁRIO?  (o problema do "enquadramento" das mensagens)
-------------------------------------------------------------------------
O TCP entrega um FLUXO DE BYTES, não mensagens. Se o cliente manda

        "HELLO ana\\r\\n"   e depois   "LIST\\r\\n"

o servidor pode receber num único recv():   b"HELLO ana\\r\\nLIST\\r\\n"
ou picado em vários:                        b"HEL"  b"LO an"  b"a\\r\\nLIST\\r\\n"

O TCP garante que os bytes chegam TODOS e NA ORDEM, mas não diz onde uma
mensagem termina e a próxima começa. Quem define isso é o NOSSO protocolo:
cada mensagem termina com os bytes \\r\\n (CR LF), igual a HTTP, SMTP e FTP.

Por isso guardamos os bytes recebidos num BUFFER e só entregamos uma
linha quando o \\r\\n dela já chegou.

Rode cliente ou servidor com --debug para ver os bytes de verdade.
"""

PORTA_PADRAO = 5000
CODIFICACAO = "utf-8"     # texto <-> bytes
FIM_DE_LINHA = b"\r\n"    # marca o fim de cada mensagem
TAMANHO_RECV = 1024       # quantos bytes pedimos ao sistema por recv()

DEBUG = False             # True = imprime cada send()/recv() na tela


class Conexao:
    """Embrulha um socket TCP já conectado e troca LINHAS de texto por ele."""

    def __init__(self, sock, apelido="?"):
        self.sock = sock          # o socket do sistema operacional
        self.buffer = b""         # bytes que já chegaram mas ainda não viraram linha
        self.apelido = apelido    # só para identificar as mensagens de debug

    # --------------------------------------------------------------- envio
    def enviar_linha(self, texto):
        # 1) texto -> bytes, e acrescenta o marcador de fim de mensagem
        dados = texto.encode(CODIFICACAO) + FIM_DE_LINHA

        # 2) send() pode enviar só PARTE dos bytes (ele devolve quantos
        #    conseguiu). Por isso repetimos até mandar tudo.
        total_enviado = 0
        while total_enviado < len(dados):
            enviados = self.sock.send(dados[total_enviado:])
            if enviados == 0:
                raise ConnectionError("a conexão foi fechada durante o envio")
            if DEBUG:
                print(f"    [{self.apelido}] send() -> {enviados} bytes: "
                      f"{dados[total_enviado:total_enviado + enviados]!r}")
            total_enviado += enviados

    # ------------------------------------------------------------ recepção
    def receber_linha(self):
        """Devolve a próxima linha (sem o \\r\\n) ou None se a conexão fechou."""

        # 1) Enquanto não houver um \r\n completo no buffer, pede mais bytes.
        while FIM_DE_LINHA not in self.buffer:
            pedaco = self.sock.recv(TAMANHO_RECV)   # BLOQUEIA até chegar algo
            if DEBUG:
                print(f"    [{self.apelido}] recv() <- {len(pedaco)} bytes: {pedaco!r}")

            # recv() devolver b"" (zero bytes) significa: o outro lado
            # fechou a conexão. É assim que o TCP avisa o fim.
            if pedaco == b"":
                return None
            self.buffer += pedaco

        # 2) Corta a primeira linha do buffer. O que sobrar (talvez o começo
        #    da próxima mensagem) fica guardado para a próxima chamada.
        linha, self.buffer = self.buffer.split(FIM_DE_LINHA, 1)

        # 3) bytes -> texto
        return linha.decode(CODIFICACAO)

    def fechar(self):
        self.sock.close()


# -------------------------------------------------------------------------
# RESPOSTAS DO SERVIDOR
#
# Toda resposta começa com um código de 3 dígitos. Uma resposta pode ter
# várias linhas; para o cliente saber quando ela acaba usamos a regra do
# SMTP/FTP:
#
#     210-linha 1          hífen depois do código  = ainda vem mais
#     210-linha 2
#     210 última linha     espaço depois do código = acabou
# -------------------------------------------------------------------------

def enviar_resposta(conexao, codigo, linhas):
    for i, linha in enumerate(linhas):
        separador = " " if i == len(linhas) - 1 else "-"
        conexao.enviar_linha(f"{codigo}{separador}{linha}")


def receber_resposta(conexao):
    """Lê uma resposta inteira. Devolve (codigo, [linhas]) ou None se fechou."""
    linhas = []
    while True:
        linha = conexao.receber_linha()
        if linha is None:
            return None
        codigo, separador, texto = linha[:3], linha[3:4], linha[4:]
        linhas.append(texto)
        if separador != "-":           # espaço = última linha da resposta
            return int(codigo), linhas
