import json
from pathlib import Path

PATH = Path("public/tenders.json")

AMOUNT_KEYS = (
    "ecv",
    "estimatedContractValue",
    "estimatedAmount",
    "estimatedTenderValue",
    "tenderValue",
    "estimatedCost",
    "amount",
)
EMD_KEYS = (
    "emdAmount",
    "emd",
    "emdValue",
    "earnestMoneyDeposit",
    "earnestMoneyDepositAmount",
    "earnestMoney",
)
FEE_KEYS = (
    "tenderFee",
    "tenderFeeAmount",
    "fee",
    "documentFee",
    "processingFee",
)


def positive_number(value):
    if value is None or value == "":
        return None
    try:
        cleaned = str(value).replace("₹", "").replace(",", "").strip()
        number = float(cleaned)
        return number if number > 0 else None
    except Exception:
        return None


def best_positive(raw, keys, current=None):
    if isinstance(raw, dict):
        for key in keys:
            number = positive_number(raw.get(key))
            if number is not None:
                return number
    return positive_number(current)


def main():
    data = json.loads(PATH.read_text(encoding="utf-8"))
    tenders = data.get("tenders") or []

    recovered = {"amount": 0, "emd": 0, "fee": 0}
    improved = {"amount": 0, "emd": 0, "fee": 0}

    for tender in tenders:
        raw = tender.get("raw") if isinstance(tender.get("raw"), dict) else {}

        for field, keys in (
            ("amount", AMOUNT_KEYS),
            ("emd", EMD_KEYS),
            ("fee", FEE_KEYS),
        ):
            before = positive_number(tender.get(field))
            best = best_positive(raw, keys, tender.get(field))
            if best is None:
                continue
            if before is None:
                recovered[field] += 1
            if before != best:
                improved[field] += 1
                tender[field] = best
                if field == "amount":
                    tender["amount_display"] = str(best)

    PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("KPPP financial-field repair complete")
    print("Recovered missing/zero Amount:", recovered["amount"])
    print("Recovered missing/zero EMD   :", recovered["emd"])
    print("Recovered missing/zero Fee   :", recovered["fee"])
    print("Improved Amount fields        :", improved["amount"])
    print("Improved EMD fields           :", improved["emd"])
    print("Improved Fee fields           :", improved["fee"])


if __name__ == "__main__":
    main()
