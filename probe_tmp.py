import json
import sys
import urllib.request

B = "http://127.0.0.1:8103/api"
for arg in sys.argv[1:]:
    path, _, n = arg.partition("|")
    try:
        with urllib.request.urlopen(B + path) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        print(path, e.code, e.read()[:300])
        continue
    print(path)
    print(json.dumps(d)[: int(n or 1500)])
    print()
