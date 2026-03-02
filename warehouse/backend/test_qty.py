import requests

# Let's test if the backend API now accepts quantity updates properly
print("Testing PATCH to /receiving/lines/1 (PO-11)...")
res = requests.patch("http://127.0.0.1:8000/receiving/lines/1", json={"quantity": 25})
print(f"Status Code: {res.status_code}")
print(f"Response: {res.json()}")

# Fetch to verify
res2 = requests.get("http://127.0.0.1:8000/api/inventory?q=PO-11")
data = res2.json()
for row in data.get("rows", []):
    print(f"Line {row['line_id']} -> Qty: {row['quantity']}")
