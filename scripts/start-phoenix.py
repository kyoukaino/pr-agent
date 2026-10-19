import os
import sys

os.environ["PHOENIX_PORT"] = "6006"
os.environ["PHOENIX_HOST"] = "127.0.0.1"

from phoenix.server.main import main

if __name__ == "__main__":
    print("Launching Phoenix Server on http://127.0.0.1:6006 ...", flush=True)
    sys.argv = ["phoenix", "serve"]
    main()
