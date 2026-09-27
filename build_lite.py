"""Build public/tenders-lite.json: the small file the website loads.

public/tenders.json keeps the full KPPP records (with `raw`) for history and
safety checks; the site only needs a handful of fields, so this drops the
duplicated raw payload and normalises dates and districts once, here, instead
of in every visitor's browser.
"""

import json
import re
from datetime import datetime
from pathlib import Path

SOURCE = Path("public/tenders.json")
TARGET = Path("public/tenders-lite.json")

# District -> district/taluk/town names (and common spellings) seen in KPPP office names and titles.
DISTRICTS = {
    "Bagalkot": ["bagalakote", "lokapur", "bagalkot", "bagalkote", "badami", "bilagi", "hungund", "jamkhandi", "mudhol", "guledgudda", "ilkal", "ilkal", "rabkavi", "banhatti", "terdal"],
    "Ballari": ["ballari", "bellary", "kurugodu", "kampli", "sandur", "siruguppa"],
    "Belagavi": ["ankalagi", "ghataprabha", "koujalagi", "belagavi", "belgaum", "athani", "bailhongal", "chikkodi", "gokak", "hukkeri", "khanapur", "mudalagi", "mudalgi", "nippani", "raibag", "ramdurg", "ramadurga", "savadatti", "saundatti", "kagawad", "kittur", "yaragatti"],
    "Bengaluru Rural": ["bengaluru rural", "bangalore rural", "devanahalli", "doddaballapur", "doddaballapura", "hoskote", "nelamangala"],
    "Bengaluru Urban": ["bengalore", "bccc", "bwcc", "becc", "bscc", "btm layout", "shanthinagar", "chikkapete", "yediyur", "madanayakanahalli", "bengaluru", "bangalore", "bbmp", "bwssb", "bda", "bmrcl", "anekal", "yelahanka", "kengeri", "mahadevapura"],
    "Bidar": ["bidar", "aurad", "basavakalyan", "bhalki", "humnabad", "chitgoppa", "hulsoor", "kamalnagar"],
    "Chamarajanagar": ["chamarajanagar", "chamarajanagara", "gundlupet", "kollegal", "yelandur", "hanur", "mahadeswara", "mahadeshwara"],
    "Chikkaballapur": ["chikkaballapur", "chikballapur", "bagepalli", "chintamani", "gauribidanur", "gudibande", "sidlaghatta", "shidlaghatta", "cheluru"],
    "Chikkamagaluru": ["chikkmagaluru", "chikkamagaluru", "chikmagalur", "chikkamagalur", "kadur", "koppa", "mudigere", "narasimharajapura", "n r pura", "sringeri", "shringeri", "tarikere", "ajjampura", "kalasa"],
    "Chitradurga": ["chitradurga", "challakere", "hiriyur", "holalkere", "hosadurga", "molakalmuru"],
    "Dakshina Kannada": ["bajpe", "dakshina kannada", "mangaluru", "mangalore", "bantwal", "belthangady", "belthangadi", "puttur", "sullia", "moodbidri", "mudabidri", "kadaba", "mulki", "ullal", "vitla"],
    "Davanagere": ["davanagere", "davangere", "channagiri", "harihar", "honnali", "jagalur", "nyamathi"],
    "Dharwad": ["dharwad", "hubballi", "hubli", "kalghatgi", "kalaghatagi", "kundgol", "kundagol", "navalgund", "alnavar", "annigeri"],
    "Gadag": ["gadag", "mundargi", "nargund", "naragund", "ron", "shirahatti", "gajendragad", "lakshmeshwar"],
    "Hassan": ["cr patna", "c r patna", "hassan", "alur", "arkalgud", "arakalagud", "arsikere", "arasikere", "belur", "channarayapatna", "holenarasipur", "sakleshpur", "sakaleshpur"],
    "Haveri": ["haveri", "byadgi", "hangal", "hanagal", "hirekerur", "ranebennur", "savanur", "shiggaon", "rattihalli"],
    "Kalaburagi": ["kalaburagi", "kalaburgi", "kalburgi", "gulbarga", "afzalpur", "aland", "chincholi", "chittapur", "jevargi", "sedam", "kalagi", "kamalapur", "shahabad", "yadrami"],
    "Kodagu": ["kodagu", "madikeri", "coorg", "somwarpet", "somavarapete", "virajpet", "virajpete", "kushalnagar", "ponnampet"],
    "Kolar": ["kolar", "kgf", "bangarpet", "bangarapet", "malur", "mulbagal", "srinivaspur"],
    "Koppal": ["munirabad", "koppal", "gangavathi", "gangavati", "kushtagi", "yelburga", "yelbarga", "kanakagiri", "karatagi", "kukanoor"],
    "Mandya": ["shivanasamudra", "shivanasamudram", "mandya", "krishnarajpet", "k r pet", "kr pet", "maddur", "malavalli", "nagamangala", "pandavapura", "srirangapatna", "srirangapattana"],
    "Mysuru": ["hunasur", "hootagalli", "nanjungud", "bogadi", "mysuru", "mysore", "heggadadevanakote", "h d kote", "hd kote", "hunsur", "krishnarajanagara", "k r nagar", "kr nagar", "nanjangud", "piriyapatna", "tirumakudal", "t narasipur", "narasipur", "narsipur", "saragur", "saligrama"],
    "Raichur": ["yeramarus", "hutti", "rodalabanda", "raichur", "devadurga", "lingasugur", "lingsugur", "manvi", "sindhanur", "sindhnur", "maski", "sirwar"],
    "Ramanagara": ["ramanagara", "ramanagaram", "channapatna", "kanakapura", "magadi", "harohalli"],
    "Shivamogga": ["shivamogga", "shimoga", "bhadravati", "bhadravathi", "hosanagara", "sagar", "shikaripura", "shikaripur", "soraba", "sorab", "thirthahalli", "tirthahalli", "jog"],
    "Tumakuru": ["tumakuru", "tumkur", "chikkanayakanahalli", "gubbi", "koratagere", "kunigal", "madhugiri", "pavagada", "sira", "tiptur", "turuvekere"],
    "Udupi": ["udupi", "karkala", "kundapur", "kundapura", "brahmavar", "byndoor", "baindur", "kapu", "kaup", "hebri"],
    "Uttara Kannada": ["gerusoppa", "uttara kannada", "karwar", "ankola", "bhatkal", "haliyal", "honnavar", "kumta", "mundgod", "siddapur", "sirsi", "supa", "joida", "yellapur", "dandeli"],
    "Vijayanagara": ["hampi", "vijayanagara", "hosapete", "hospet", "hagaribommanahalli", "hadagali", "harapanahalli", "kudligi", "kotturu", "kottur"],
    "Vijayapura": ["vijaypur", "vijayapura", "bijapur", "basavana bagewadi", "bagewadi", "indi", "muddebihal", "sindagi", "babaleshwar", "chadachan", "hipparagi", "kolhar", "nidagundi", "talikoti", "tikota", "almel"],
    "Yadgir": ["hunasagi", "yadgir", "yadagiri", "shahapur", "shorapur", "surpur", "gurmitkal", "hunsagi", "wadagera"],
}
# Check longer, more specific names first ("bengaluru rural" before "bengaluru").
MATCHERS = []
for _district, _aliases in DISTRICTS.items():
    for _alias in set(_aliases):
        # Local spellings add a short suffix ("Sagara", "Hunsuru", "Basavakalyana"); allow it
        # for longer names only, so short ones like "indi" don't match "india".
        tail = r"[a-z]{0,2}" if len(_alias) > 4 else r"[au]?"
        MATCHERS.append((len(_alias), re.compile(r"(?<![a-z])" + re.escape(_alias) + tail + r"(?![a-z])"), _district))
MATCHERS.sort(key=lambda item: -item[0])


def district_of(*texts):
    for text in texts:
        low = re.sub(r"[^a-z]+", " ", str(text or "").lower())
        for _, pattern, district in MATCHERS:
            if pattern.search(low):
                return district
    return ""


def iso_ist(value):
    """KPPP dates are 'dd-mm-yyyy HH:MM:SS' in India time."""
    try:
        return datetime.strptime(str(value).strip(), "%d-%m-%Y %H:%M:%S").strftime("%Y-%m-%dT%H:%M:%S+05:30")
    except Exception:
        return None


def positive(value):
    try:
        number = float(str(value).replace(",", "").replace("₹", "").strip())
        return round(number, 2) if number > 0 else None
    except Exception:
        return None


def slim(tender):
    raw = tender.get("raw") if isinstance(tender.get("raw"), dict) else {}
    title = str(tender.get("title") or raw.get("title") or "").strip()
    description = str(raw.get("description") or "").strip()
    office = str(raw.get("locationName") or tender.get("location") or "").strip()
    department = str(tender.get("department") or raw.get("deptName") or "").strip()
    record = {
        "id": str(tender.get("id") or raw.get("id") or ""),
        "nit": str(raw.get("nitId") or ""),
        "ref": str(tender.get("ref_no") or raw.get("tenderNumber") or ""),
        "title": title,
        "cat": str(tender.get("category") or raw.get("category") or "").upper(),
        "dept": department,
        "office": office,
        "district": district_of(tender.get("district"), tender.get("city"), office, title, description),
        "value": positive(tender.get("amount")),
        "emd": positive(tender.get("emd")),
        "fee": positive(tender.get("fee")),
        "published": iso_ist(tender.get("published_date") or raw.get("publishedDate")),
        "closing": iso_ist(tender.get("closing_date") or raw.get("tenderClosureDate")),
        "access": str(raw.get("invitingStrategyText") or "").strip(),
        "work": str(raw.get("workCategoryName") or "").strip(),
        "bidType": str(raw.get("tenderType") or "").strip(),
    }
    if description and description != title:
        record["desc"] = description
    return {k: v for k, v in record.items() if v not in (None, "")}


def main():
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    tenders = [slim(t) for t in data.get("tenders") or []]
    payload = {
        "generated_at": data.get("generated_at"),
        "count": len(tenders),
        "tenders": tenders,
    }
    TARGET.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    matched = sum(1 for t in tenders if t.get("district"))
    print(f"Wrote {TARGET} with {len(tenders)} tenders ({TARGET.stat().st_size / 1e6:.2f} MB); district found for {matched}.")


if __name__ == "__main__":
    main()
