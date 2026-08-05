import argparse
import os
import socket
import subprocess
import threading


def bridge(source, target):
    try:
        while data := source.recv(65536):
            target.write(data)
            target.flush()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            target.close()
        except OSError:
            pass


def handle(client, distro):
    process = subprocess.Popen(
        ["wsl.exe", "-d", distro, "--", "nc", "127.0.0.1", "5432"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    assert process.stdin and process.stdout
    outgoing = threading.Thread(target=bridge, args=(client, process.stdin), daemon=True)
    outgoing.start()
    try:
        while data := os.read(process.stdout.fileno(), 65536):
            client.sendall(data)
    except (ConnectionError, OSError):
        pass
    finally:
        client.close()
        process.terminate()
        process.wait()


def main():
    parser = argparse.ArgumentParser(description="Loopback-only Windows to WSL PostgreSQL forward")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--distro", required=True)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")

    with socket.create_server(("127.0.0.1", args.port)) as listener:
        while True:
            client, _ = listener.accept()
            threading.Thread(target=handle, args=(client, args.distro), daemon=True).start()


if __name__ == "__main__":
    main()
