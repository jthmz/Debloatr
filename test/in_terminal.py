#!/usr/bin/env python3
"""Run a command inside a pseudo-terminal, as if a person were at the keyboard.

    in_terminal.py COLUMNS ANSWERS command [args...]

ANSWERS is a comma-separated list of lines to type, one each time the command
stops at a prompt (output that ends in ": "). What the terminal showed is
printed on stdout and the command's exit status is passed on.

debloat.sh behaves differently on a terminal (colour, layout fitted to the
width, prompts that expect a typed Enter); this is how the tests reach that.
"""
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time


def main():
    columns = int(sys.argv[1])
    answers = [a for a in sys.argv[2].split(",") if a]
    command = sys.argv[3:]

    pid, master = pty.fork()
    if pid == 0:
        # In the child, before the command starts, so the size is never read
        # before it is set.
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, columns, 0, 0))
        os.environ["TERM"] = "xterm-256color"
        os.environ.pop("NO_COLOR", None)
        os.execvp(command[0], command)

    shown = b""
    deadline = time.time() + 120
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            shown += data
        elif answers and shown.endswith(b": "):
            os.write(master, (answers.pop(0) + "\n").encode())

    _, status = os.waitpid(pid, 0)
    sys.stdout.write(shown.decode(errors="replace").replace("\r\n", "\n"))
    sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)


if __name__ == "__main__":
    main()
