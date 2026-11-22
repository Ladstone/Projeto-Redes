"""
ponte_web.py - liga o NAVEGADOR ao servidor da bolsa.

Por que esta ponte existe?
    Um navegador não consegue abrir uma conexão TCP "crua" com o nosso
    servidor: por segurança, páginas web só falam HTTP (e WebSocket).
    Então este programa fica no meio, traduzindo:

        Navegador  --HTTP + JSON-->  ponte_web.py  --TCP + protocolo BVF-->  servidor.py
                   <---------------                <------------------------

    Para o servidor, a ponte é só mais um CLIENTE TCP, igual ao cliente.py:
    para cada pessoa que entra pelo navegador, a ponte abre UMA conexão TCP
    com o servidor e repassa os comandos (HELLO, LIST, BUY...) do jeitinho
    que o protocolo manda. O servidor não sabe que existe um navegador.

Uso:
    python ponte_web.py [--porta-web 8080] [--servidor 127.0.0.1:5000] [--debug]

Depois abra http://localhost:8080 no navegador. Outras máquinas da rede
podem abrir http://<IP-desta-máquina>:8080.

Só usa a biblioteca padrão do Python.
"""

import argparse
import json
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import protocolo

PASTA_WEB = Path(__file__).parent / "web"
ARQUIVOS = {                       # rota -> (arquivo, tipo de conteúdo)
    "/":          ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js":    ("app.js", "application/javascript; charset=utf-8"),
}
TEMPO_OCIOSO = 20       # s sem notícias do navegador -> fecha a conexão TCP dele
MAX_COMANDOS = 12       # comandos por requisição HTTP

parser = argparse.ArgumentParser(description="Ponte HTTP <-> protocolo BVF")
parser.add_argument("--porta-web", type=int, default=8080)
parser.add_argument("--servidor", default=f"127.0.0.1:{protocolo.PORTA_PADRAO}",
                    help="endereço do servidor da bolsa (ip:porta)")
parser.add_argument("--debug", action="store_true", help="mostra os bytes trocados com o servidor")
ARGS = parser.parse_args()
protocolo.DEBUG = ARGS.debug
SERVIDOR_HOST, _, _porta = ARGS.servidor.rpartition(":")
SERVIDOR_PORTA = int(_porta)


# ======================================================================
#  SESSÕES: cada navegador logado = uma conexão TCP com o servidor
# ======================================================================

class Sessao:
    def __init__(self, conexao, apelido):
        self.conexao = conexao
        self.apelido = apelido
        self.trava = threading.Lock()    # um comando por vez nesta conexão
        self.ultimo_uso = time.time()

    def pedir(self, comando):
        """Envia um comando pelo TCP e devolve (codigo, linhas)."""
        with self.trava:
            self.ultimo_uso = time.time()
            self.conexao.enviar_linha(comando)
            resposta = protocolo.receber_resposta(self.conexao)
            if resposta is None:
                raise ConnectionError("o servidor fechou a conexão")
            return resposta

    def fechar(self):
        with self.trava:
            try:
                self.conexao.enviar_linha("BYE")
                protocolo.receber_resposta(self.conexao)
            except OSError:
                pass
            self.conexao.fechar()


sessoes = {}                         # token -> Sessao
trava_sessoes = threading.Lock()


def abrir_sessao(apelido):
    """Abre a conexão TCP com o servidor e faz o HELLO.
    Devolve (token ou None, lista do tráfego trocado)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)     # 1. socket()
    sock.settimeout(5)
    sock.connect((SERVIDOR_HOST, SERVIDOR_PORTA))                 # 2. connect()
    conexao = protocolo.Conexao(sock, apelido=f"ponte:{apelido}")

    trafego = []
    saudacao = protocolo.receber_resposta(conexao)               # 3. o servidor fala primeiro
    if saudacao is None:
        conexao.fechar()
        raise ConnectionError("o servidor fechou a conexão")
    trafego.append({"comando": None, "codigo": saudacao[0], "linhas": saudacao[1]})

    comando = f"HELLO {apelido}"
    conexao.enviar_linha(comando)
    codigo, linhas = protocolo.receber_resposta(conexao) or (0, ["sem resposta"])
    trafego.append({"comando": comando, "codigo": codigo, "linhas": linhas})

    if codigo != 200:
        conexao.fechar()
        return None, trafego

    token = secrets.token_hex(16)
    with trava_sessoes:
        sessoes[token] = Sessao(conexao, apelido)
    print(f"[+] {apelido} entrou pelo navegador")
    return token, trafego


def encerrar_sessao(token):
    with trava_sessoes:
        sessao = sessoes.pop(token, None)
    if sessao:
        sessao.fechar()
        print(f"[-] {sessao.apelido} saiu")


def faxineiro():
    """Fecha conexões de navegadores que sumiram sem clicar em Sair."""
    while True:
        time.sleep(5)
        limite = time.time() - TEMPO_OCIOSO
        with trava_sessoes:
            ociosas = [t for t, s in sessoes.items() if s.ultimo_uso < limite]
        for token in ociosas:
            encerrar_sessao(token)


# ======================================================================
#  HTTP: o que o navegador pode pedir
# ======================================================================

class Ponte(BaseHTTPRequestHandler):
    def log_message(self, formato, *args):
        pass    # silencia o log padrão (seria uma linha a cada 2 s por navegador)

    # ---------------------------------------------------------- respostas
    def enviar_json(self, status, dados):
        corpo = json.dumps(dados, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(corpo)

    # ---------------------------------------------------------- arquivos
    def do_GET(self):
        caminho = self.path.split("?")[0]
        if caminho == "/api/info":
            return self.enviar_json(200, {"servidor": f"{SERVIDOR_HOST}:{SERVIDOR_PORTA}"})
        if caminho not in ARQUIVOS:
            return self.enviar_json(404, {"erro": "não encontrado"})
        nome, tipo = ARQUIVOS[caminho]
        corpo = (PASTA_WEB / nome).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(corpo)

    # ---------------------------------------------------------- API
    def do_POST(self):
        try:
            tamanho = int(self.headers.get("Content-Length", 0))
            dados = json.loads(self.rfile.read(tamanho) or b"{}")
        except ValueError:
            return self.enviar_json(400, {"erro": "JSON inválido"})

        rotas = {
            "/api/entrar": self.api_entrar,
            "/api/comandos": self.api_comandos,
            "/api/sair": self.api_sair,
        }
        rota = rotas.get(self.path)
        if rota is None:
            return self.enviar_json(404, {"erro": "rota desconhecida"})
        rota(dados)

    def api_entrar(self, dados):
        apelido = str(dados.get("apelido", "")).strip()
        try:
            token, trafego = abrir_sessao(apelido)
        except OSError as erro:
            return self.enviar_json(502, {
                "erro": f"Não consegui falar com o servidor da bolsa em "
                        f"{SERVIDOR_HOST}:{SERVIDOR_PORTA} ({erro})."})
        self.enviar_json(200, {"token": token, "apelido": apelido, "trafego": trafego})

    def api_comandos(self, dados):
        with trava_sessoes:
            sessao = sessoes.get(dados.get("token"))
        if sessao is None:
            return self.enviar_json(401, {"erro": "sessão expirada"})

        comandos = dados.get("comandos", [])[:MAX_COMANDOS]
        resultados = []
        for comando in comandos:
            comando = str(comando)
            # Uma mensagem do protocolo é UMA linha. Se deixássemos passar um
            # \r\n aqui, o navegador conseguiria enfiar vários comandos num só.
            if "\r" in comando or "\n" in comando or comando.strip().upper() == "BYE":
                resultados.append({"comando": comando, "codigo": 400,
                                   "linhas": ["COMANDO NÃO PERMITIDO PELA PONTE"]})
                continue
            try:
                codigo, linhas = sessao.pedir(comando)
            except OSError:
                encerrar_sessao(dados.get("token"))
                return self.enviar_json(410, {"erro": "conexão com o servidor perdida"})
            resultados.append({"comando": comando, "codigo": codigo, "linhas": linhas})
        self.enviar_json(200, {"resultados": resultados})

    def api_sair(self, dados):
        encerrar_sessao(dados.get("token"))
        self.enviar_json(200, {"ok": True})


def enderecos_locais():
    try:
        return [ip for ip in socket.gethostbyname_ex(socket.gethostname())[2]
                if not ip.startswith("127.")]
    except OSError:
        return []


def main():
    threading.Thread(target=faxineiro, daemon=True).start()
    servidor_http = ThreadingHTTPServer(("0.0.0.0", ARGS.porta_web), Ponte)
    servidor_http.daemon_threads = True
    print(f"Ponte web ligada ao servidor da bolsa em {SERVIDOR_HOST}:{SERVIDOR_PORTA}")
    print(f"Abra no navegador:  http://localhost:{ARGS.porta_web}")
    for ip in enderecos_locais():
        print(f"     ou na rede:    http://{ip}:{ARGS.porta_web}")
    print("Ctrl+C para encerrar.")
    try:
        servidor_http.serve_forever()
    except KeyboardInterrupt:
        print("\nPonte desligada.")
    finally:
        with trava_sessoes:
            tokens = list(sessoes)
        for token in tokens:
            encerrar_sessao(token)
        servidor_http.server_close()


if __name__ == "__main__":
    main()
