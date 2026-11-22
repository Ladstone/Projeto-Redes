"""
Cliente da Bolsa de Valores Fictícia (protocolo BVF/1.0).

Uso:  python cliente.py [host] [porta] [--debug]
      (padrão: 127.0.0.1 5000)

O ciclo de vida de um socket CLIENTE TCP é:

    1. socket()    cria o socket
    2. connect()   conecta no servidor (aqui acontece o "aperto de mão"
                   de 3 vias do TCP: SYN, SYN-ACK, ACK)
    3. send/recv   troca mensagens
    4. close()     encerra a conexão
"""

import socket
import sys

import protocolo

# ------------------------------------------------------ argumentos da linha de comando
argumentos = [a for a in sys.argv[1:] if a != "--debug"]
protocolo.DEBUG = "--debug" in sys.argv
HOST = argumentos[0] if len(argumentos) > 0 else "127.0.0.1"
PORTA = int(argumentos[1]) if len(argumentos) > 1 else protocolo.PORTA_PADRAO


def mostrar(codigo, linhas):
    prefixo = "ERRO " if codigo >= 400 else ""
    print(f"[{codigo}] {prefixo}{linhas[0]}")
    for linha in linhas[1:]:
        print("      " + linha)


def main():
    # PASSO 1 - socket(): cria o socket.
    #   AF_INET     = endereços IPv4
    #   SOCK_STREAM = TCP (fluxo de bytes confiável e ordenado)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

    # PASSO 2 - connect(): conecta no endereço (IP, porta) do servidor.
    #   O sistema escolhe sozinho uma porta local livre para o cliente.
    print(f"Conectando em {HOST}:{PORTA}...")
    try:
        sock.connect((HOST, PORTA))
    except ConnectionRefusedError:
        print("Conexão recusada. O servidor está rodando nesse endereço/porta?")
        sock.close()
        return
    ip_local, porta_local = sock.getsockname()
    print(f"Conectado! Minha ponta da conexão é {ip_local}:{porta_local}\n")

    conexao = protocolo.Conexao(sock, apelido="cliente")

    try:
        # PASSO 3 - troca de mensagens.
        # Pelo protocolo, o servidor fala primeiro: manda a saudação 100.
        resposta = protocolo.receber_resposta(conexao)
        if resposta is None:
            print("O servidor fechou a conexão.")
            return
        mostrar(*resposta)

        while True:
            try:
                comando = input("> ").strip()
            except (EOFError, KeyboardInterrupt):
                comando = "BYE"
                print()
            if not comando:
                continue

            # envia UMA linha com o pedido...
            conexao.enviar_linha(comando)

            # ...e espera a resposta completa (pode ter várias linhas)
            resposta = protocolo.receber_resposta(conexao)
            if resposta is None:
                print("O servidor fechou a conexão.")
                break
            codigo, linhas = resposta
            mostrar(codigo, linhas)

            if codigo == 221:   # 221 = servidor confirmou o BYE
                break

    except ConnectionError as erro:
        print(f"Conexão perdida: {erro}")

    finally:
        # PASSO 4 - close(): encerra a conexão (o TCP manda o FIN ao servidor).
        conexao.fechar()
        print("Conexão encerrada.")


if __name__ == "__main__":
    main()
