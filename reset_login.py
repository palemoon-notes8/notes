"""Set a new website password and secret sign-in address.

Use this if the password or the sign-in address is lost:

    python reset_login.py                      # makes a new random password and address
    python reset_login.py "my new password"    # uses your own password, new random address

It updates the two hashes in worker/index.js and prints the new password and address. Commit and
push the change to main; after the next deploy every device has to sign in again once.
Only hashes go into the code, so never commit the printed password or address anywhere.
"""

import hashlib
import re
import secrets
import sys
from pathlib import Path

WORKER = Path(__file__).with_name("worker") / "index.js"
LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main():
    password = sys.argv[1] if len(sys.argv) > 1 else "-".join(
        "".join(secrets.choice(LETTERS) for _ in range(4)) for _ in range(4))
    address = "enter-" + "".join(secrets.choice(LETTERS.lower()[:23] + "23456789") for _ in range(10))
    session_check = sha256(sha256("tenderone-session:" + password))
    path_hash = sha256("/" + address)

    code = WORKER.read_text(encoding="utf-8")
    code, n1 = re.subn(r"const SESSION_CHECK = '[0-9a-f]{64}';", f"const SESSION_CHECK = '{session_check}';", code)
    code, n2 = re.subn(r"const LOGIN_PATH_HASH = '[0-9a-f]{64}';", f"const LOGIN_PATH_HASH = '{path_hash}';", code)
    if n1 != 1 or n2 != 1:
        raise SystemExit("Could not find the password settings in worker/index.js")
    WORKER.write_text(code, encoding="utf-8")
    print("New sign-in address: https://<your website>/" + address)
    print("New password:        " + password)
    print("Now commit and push worker/index.js to main. Save these two somewhere safe.")


if __name__ == "__main__":
    main()
