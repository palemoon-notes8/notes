import json
import os
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from kppp_polite import make_session as polite_session


# ============================================================
# KPPP KARNATAKA TENDER COLLECTOR
# WORKS + GOODS + SERVICES
# ============================================================


BASE_URL = "https://kppp.karnataka.gov.in"

API_BASE = (
    BASE_URL
    + "/supplier-registration-service/v1/api"
)

OUTPUT_FILE = Path("public/tenders.json")


# ============================================================
# SETTINGS
# ============================================================

PAGE_SIZE = int(
    os.getenv(
        "KPPP_PAGE_SIZE",
        "100"
    )
)

PAGE_DELAY = float(os.getenv("KPPP_PAGE_DELAY", "4"))

# Hourly small updates ask for only a few new tenders at a time.
SMALL_PAGE_SIZE = int(os.getenv("KPPP_SMALL_PAGE_SIZE", "25"))

IST = timezone(timedelta(hours=5, minutes=30))

LAST_FULL_AT = None

MAX_PAGES = int(
    os.getenv(
        "KPPP_MAX_PAGES",
        "100"
    )
)

AUTH_TOKEN = os.getenv(
    "KPPP_AUTH_TOKEN",
    ""
).strip()


# ============================================================
# ACTUAL KPPP ENDPOINTS
# ============================================================

CATEGORY_ENDPOINTS = {

    "WORKS": (
        API_BASE
        + "/portal-service/works/search-eproc-tenders"
    ),

    "GOODS": (
        API_BASE
        + "/portal-service/search-eproc-tenders"
    ),

    "SERVICES": (
        API_BASE
        + "/portal-service/services/search-eproc-tenders"
    ),
}


# ============================================================
# HEADERS
# ============================================================

def get_headers():

    headers = {

        "Accept":
            "application/json, text/plain, */*",

        "Content-Type":
            "application/json",

        "Origin":
            BASE_URL,

        "Referer":
            BASE_URL + "/",

        "Post":
            "CONTRACTOR-EPROC-CONTRACTOR",

        "User-Agent": (
            "Mozilla/5.0 "
            "(Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 "
            "(KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        ),
    }

    # Token is optional for public KPPP portal searches.
    if AUTH_TOKEN:

        headers["Authorization"] = (
            "Bearer " + AUTH_TOKEN
        )

    return headers


# ============================================================
# HTTP SESSION WITH RETRY
# ============================================================

def create_session():

    # Gentle on KPPP: one request at a time with pauses when it is busy (kppp_polite.py).
    return polite_session(pool=2)


# ============================================================
# HELPER FUNCTIONS
# ============================================================

def pick(data, *keys, default=""):

    if not isinstance(data, dict):
        return default

    for key in keys:

        value = data.get(key)

        if value not in (
            None,
            ""
        ):

            return value

    return default


def to_number(value):

    if value in (
        None,
        ""
    ):

        return None

    try:

        value = str(value)

        value = value.replace(
            "₹",
            ""
        )

        value = value.replace(
            ",",
            ""
        )

        value = value.strip()

        return float(value)

    except Exception:

        return None


def find_tender_list(data):

    # KPPP often returns the array directly.
    if isinstance(
        data,
        list
    ):

        return data

    if not isinstance(
        data,
        dict
    ):

        return []

    possible_keys = [

        "content",

        "items",

        "results",

        "tenders",

        "records",

        "data",
    ]

    for key in possible_keys:

        value = data.get(key)

        if isinstance(
            value,
            list
        ):

            return value

        if isinstance(
            value,
            dict
        ):

            nested = find_tender_list(
                value
            )

            if nested:

                return nested

    return []


# ============================================================
# DATE PARSER
# ============================================================

def parse_date(value):

    if not value:

        return datetime.min

    formats = [

        "%d-%m-%Y %H:%M:%S",

        "%d-%m-%Y %H:%M",

        "%d-%m-%Y",

        "%Y-%m-%dT%H:%M:%S",

        "%Y-%m-%d",
    ]

    for fmt in formats:

        try:

            return datetime.strptime(
                str(value).strip(),
                fmt
            )

        except Exception:

            continue

    return datetime.min


# ============================================================
# NORMALIZE KPPP TENDER
# ============================================================

def normalize_tender(
    raw,
    category
):

    tender_id = str(

        pick(

            raw,

            "id",

            "tenderId",

            "tenderID",

            "tenderPk",

            "tenderNumber",

            default=""
        )

    ).strip()


    reference_number = str(

        pick(

            raw,

            "tenderNumber",

            "tenderNo",

            "tenderReferenceNumber",

            "referenceNumber",

            "nitNumber",

            default=tender_id
        )

    ).strip()


    title = str(

        pick(

            raw,

            "title",

            "tenderTitle",

            "description",

            "workDescription",

            "tenderDescription",

            "name",

            default="Tender"
        )

    ).strip()


    # IMPORTANT:
    # KPPP mainly returns department as "deptName"

    department = str(

        pick(

            raw,

            "deptName",

            "departmentName",

            "department",

            "departmentNameEn",

            "organisationName",

            "organisation",

            "organization",

            "procuringEntity",

            default="Karnataka Government"
        )

    ).strip()


    location = str(

        pick(

            raw,

            "locationName",

            "location",

            "placeOfWork",

            "districtName",

            "district",

            default="Karnataka"
        )

    ).strip()


    district = str(

        pick(

            raw,

            "districtName",

            "district",

            "district_name",

            default=""
        )

    ).strip()


    city = str(

        pick(

            raw,

            "cityName",

            "city",

            "townName",

            "town",

            "talukName",

            "taluk",

            default=""
        )

    ).strip()


    # IMPORTANT:
    # KPPP commonly uses "ecv"

    amount_raw = pick(

        raw,

        "ecv",

        "estimatedContractValue",

        "estimatedAmount",

        "estimatedTenderValue",

        "tenderValue",

        "estimatedCost",

        "provisionalAmount",

        "amount",

        default=""
    )


    emd_raw = pick(

        raw,

        "emdAmount",

        "emd",

        "emdValue",

        default=""
    )


    fee_raw = pick(

        raw,

        "tenderFee",

        "tenderFeeAmount",

        "fee",

        default=""
    )


    published_date = str(

        pick(

            raw,

            "publishedDate",

            "publishDate",

            "dateOfPublication",

            "tenderPublishDate",

            default=""
        )

    ).strip()


    closing_date = str(

        pick(

            raw,

            "tenderClosureDate",

            "closingDate",

            "bidSubmissionEndDate",

            "submissionEndDate",

            "lastDate",

            "tenderEndDate",

            default=""
        )

    ).strip()


    status = str(

        pick(

            raw,

            "status",

            default=""
        )

    ).strip()


    status_text = str(

        pick(

            raw,

            "statusText",

            default=status
        )

    ).strip()


    return {

        "id":
            tender_id,

        "ref_no":
            reference_number,

        "title":
            title,

        # CATEGORY IS TAKEN FROM THE ENDPOINT.
        # THIS PREVENTS EVERYTHING BECOMING GOODS.

        "category":
            category,

        "department":
            department,

        "location":
            location,

        "district":
            district,

        "city":
            city,

        "amount":
            to_number(
                amount_raw
            ),

        "amount_display": (
            str(amount_raw)

            if amount_raw
            not in (
                None,
                ""
            )

            else
            "Refer tender"
        ),

        "emd":
            to_number(
                emd_raw
            ),

        "fee":
            to_number(
                fee_raw
            ),

        "published_date":
            published_date,

        "closing_date":
            closing_date,

        "status":
            status,

        "status_text":
            status_text,

        "raw":
            raw,
    }


# ============================================================
# KPPP REQUEST PAYLOAD
# ============================================================

def build_payload(
    category,
    status="PUBLISHED"
):

    return {

        "category":
            category,

        "status":
            status,

        "title":
            "",
    }


# ============================================================
# MAKE ONE PAGE REQUEST
# ============================================================

def request_page(
    session,
    url,
    category,
    page,
    status
):

    return session.post(

        url,

        params={

            "page":
                page,

            "size":
                PAGE_SIZE,

            "order-by-tender-publish":
                "true",
        },

        json=build_payload(
            category,
            status
        ),

        headers=get_headers(),

        timeout=90,
    )


# ============================================================
# FETCH ONE CATEGORY
# ============================================================

def fetch_category(
    session,
    category,
    url,
    known=None
):

    print()
    print(
        "=" * 70
    )

    print(
        f"STARTING {category}"
    )

    print(
        f"ENDPOINT: {url}"
    )

    print(
        "=" * 70
    )


    rows = []

    seen = set()

    previous_page_keys = None

    expected_total = None


    # --------------------------------------------------------
    # First try PUBLISHED.
    # If KPPP rejects it with HTTP 400,
    # automatically fall back to ALL.
    # --------------------------------------------------------

    selected_status = (
        "PUBLISHED"
    )


    for page in range(
        MAX_PAGES
    ):

        print()
        print(
            f"{category} | "
            f"PAGE {page}"
        )


        response = request_page(

            session,

            url,

            category,

            page,

            selected_status
        )


        # ----------------------------------------------------
        # Some KPPP category endpoints may prefer ALL.
        # Automatically retry page 0.
        # ----------------------------------------------------

        if (
            page == 0
            and
            response.status_code == 400
            and
            selected_status == "PUBLISHED"
        ):

            print(
                f"{category}: "
                f"PUBLISHED returned HTTP 400."
            )

            print(
                f"{category}: "
                f"Retrying with status ALL..."
            )

            selected_status = (
                "ALL"
            )

            response = request_page(

                session,

                url,

                category,

                page,

                selected_status
            )


        print(
            f"{category} | "
            f"PAGE {page} | "
            f"HTTP {response.status_code}"
        )


        # ----------------------------------------------------
        # HANDLE ERRORS
        # ----------------------------------------------------

        if response.status_code != 200:

            print()
            print(
                "KPPP ERROR RESPONSE:"
            )

            print(
                response.text[:3000]
            )

            raise RuntimeError(

                f"{category} failed "
                f"on page {page}. "
                f"HTTP {response.status_code}"
            )


        # ----------------------------------------------------
        # X-TOTAL-COUNT
        # ----------------------------------------------------

        if expected_total is None:

            total_header = (
                response.headers.get(
                    "X-Total-Count"
                )
            )

            if total_header:

                try:

                    header_number = int(
                        total_header
                    )

                    # Ignore zero because some servers
                    # return zero when the header is
                    # unavailable/unreliable.

                    if header_number > 0:

                        expected_total = (
                            header_number
                        )

                        print(
                            f"{category} "
                            f"EXPECTED TOTAL: "
                            f"{expected_total}"
                        )

                except Exception:

                    expected_total = (
                        None
                    )


        # ----------------------------------------------------
        # JSON
        # ----------------------------------------------------

        try:

            data = response.json()

        except Exception:

            print()
            print(
                response.text[:3000]
            )

            raise RuntimeError(

                f"{category} page {page} "
                f"returned invalid JSON."
            )


        items = find_tender_list(
            data
        )


        print(
            f"{category} | "
            f"PAGE {page} | "
            f"RETURNED {len(items)}"
        )


        # ----------------------------------------------------
        # NO RESULTS = DONE
        # ----------------------------------------------------

        if not items:

            print(
                f"{category}: "
                f"NO MORE RESULTS."
            )

            break


        # ----------------------------------------------------
        # DETECT EXACT REPEATED PAGE
        # ----------------------------------------------------

        current_page_keys = set()

        for raw in items:

            raw_key = str(

                pick(

                    raw,

                    "id",

                    "tenderNumber",

                    "tenderNo",

                    default=""
                )

            )

            if raw_key:

                current_page_keys.add(
                    raw_key
                )


        if (
            previous_page_keys is not None
            and
            current_page_keys
            and
            current_page_keys
            ==
            previous_page_keys
        ):

            print(
                f"{category}: "
                f"KPPP REPEATED THE SAME PAGE."
            )

            print(
                f"{category}: "
                f"STOPPING PAGINATION."
            )

            break


        previous_page_keys = (
            current_page_keys
        )


        # ----------------------------------------------------
        # ADD UNIQUE TENDERS
        # ----------------------------------------------------

        new_records = 0

        unknown = 0


        for raw in items:

            tender = normalize_tender(

                raw,

                category
            )


            key = (

                tender["id"]

                or

                tender["ref_no"]

                or

                (
                    tender["title"],
                    tender[
                        "closing_date"
                    ]
                )
            )


            if key in seen:

                continue


            seen.add(
                key
            )

            rows.append(
                tender
            )

            new_records += 1

            if known is not None and str(tender["id"]) not in known:

                unknown += 1


        print(
            f"{category}: "
            f"{new_records} NEW"
        )

        print(
            f"{category}: "
            f"{len(rows)} TOTAL COLLECTED"
        )


        # ----------------------------------------------------
        # IF PAGE CONTAINED ONLY DUPLICATES, STOP.
        # ----------------------------------------------------

        if new_records == 0:

            print(
                f"{category}: "
                f"NO NEW RECORDS. STOPPING."
            )

            break


        # ----------------------------------------------------
        # SMALL UPDATE: newest first, so a page with nothing new
        # means the rest is already known. Stop asking KPPP.
        # ----------------------------------------------------

        if known is not None and unknown == 0:

            print(
                f"{category}: "
                f"CAUGHT UP WITH THE LAST LIST. STOPPING."
            )

            break


        # ----------------------------------------------------
        # BEST STOP CONDITION
        # ----------------------------------------------------

        if (
            expected_total is not None
            and
            len(rows) >= expected_total
        ):

            print(
                f"{category}: "
                f"REACHED X-TOTAL-COUNT "
                f"{expected_total}."
            )

            break


        # ----------------------------------------------------
        # NORMAL LAST PAGE
        # ----------------------------------------------------

        if len(items) < PAGE_SIZE:

            print(
                f"{category}: "
                f"LAST PAGE DETECTED."
            )

            break


        # KPPP blocks quick bursts of requests (HTTP 503), so pause between pages.
        time.sleep(
            PAGE_DELAY
        )


    print()
    print(
        "-" * 70
    )

    print(
        f"{category} FINISHED"
    )

    print(
        f"{category} TOTAL: "
        f"{len(rows)}"
    )

    print(
        "-" * 70
    )


    return rows


# ============================================================
# FETCH ALL 3 CATEGORIES
# ============================================================

def closing_passed(tender, now):

    try:

        closing = datetime.strptime(
            tender.get("closing_date") or "",
            "%d-%m-%Y %H:%M:%S"
        ).replace(tzinfo=IST)

    except ValueError:

        return False

    return closing < now


def previous_list():

    try:

        return json.loads(
            OUTPUT_FILE.read_text(encoding="utf-8")
        )

    except Exception:

        return None


def want_full(previous):

    """Small updates every hour; one slow full refresh a day (dates changed, cancelled tenders)."""

    if os.getenv("KPPP_FULL") == "1" or not previous or not previous.get("tenders"):

        return True

    try:

        last_full = datetime.fromisoformat(previous.get("last_full_at") or previous.get("generated_at") or "")

    except ValueError:

        return True

    now = datetime.now(timezone.utc)

    age_hours = (now - last_full).total_seconds() / 3600

    # Early morning in India (about 2-4 am) is the quietest time on KPPP.
    return age_hours >= 30 or (age_hours >= 12 and now.hour in (21, 22))


def fetch_all():

    global PAGE_SIZE, LAST_FULL_AT

    session = create_session()

    all_tenders = []

    category_results = {}

    previous = previous_list()

    full = want_full(previous)

    known_by_category = {}

    if full:

        LAST_FULL_AT = datetime.now(timezone.utc).isoformat()

        print("FULL REFRESH (once a day)")

    else:

        LAST_FULL_AT = previous.get("last_full_at")

        PAGE_SIZE = SMALL_PAGE_SIZE

        for tender in previous["tenders"]:

            known_by_category.setdefault(tender["category"], {})[str(tender["id"])] = tender

        print(f"SMALL UPDATE: only new tenders, {PAGE_SIZE} per page")


    for (
        category,
        endpoint
    ) in CATEGORY_ENDPOINTS.items():


        known = None if full else known_by_category.get(category, {})

        category_rows = fetch_category(

            session,

            category,

            endpoint,

            known
        )

        if known is not None:

            # Keep the tenders already known that are still open.
            now = datetime.now(IST)

            fresh_ids = {str(t["id"]) for t in category_rows}

            kept = [t for tid, t in known.items() if tid not in fresh_ids and not closing_passed(t, now)]

            print(f"{category}: {len(category_rows)} fetched + {len(kept)} kept from the last list")

            category_rows = category_rows + kept


        category_results[
            category
        ] = len(
            category_rows
        )


        all_tenders.extend(
            category_rows
        )


    print()
    print(
        "=" * 70
    )

    print(
        "RAW CATEGORY RESULTS"
    )

    print(
        "=" * 70
    )


    for category in [

        "WORKS",

        "GOODS",

        "SERVICES"

    ]:

        print(

            f"{category}: "
            f"{category_results.get(category, 0)}"
        )


    return all_tenders


# ============================================================
# MAIN
# ============================================================

def main():

    print()
    print(
        "============================================================"
    )

    print(
        "KPPP KARNATAKA TENDER COLLECTOR"
    )

    print(
        "WORKS + GOODS + SERVICES"
    )

    print(
        "============================================================"
    )


    start_time = time.time()


    tenders = fetch_all()


    if not tenders:

        raise RuntimeError(

            "KPPP returned ZERO tenders. "
            "Existing tenders.json "
            "WAS NOT overwritten."
        )


    # ========================================================
    # CATEGORY COUNTS
    # ========================================================

    counts = Counter(

        tender["category"]

        for tender in tenders
    )


    works_count = counts.get(

        "WORKS",

        0
    )


    goods_count = counts.get(

        "GOODS",

        0
    )


    services_count = counts.get(

        "SERVICES",

        0
    )


    print()
    print(
        "============================================================"
    )

    print(
        "FINAL CATEGORY COUNTS"
    )

    print(
        "============================================================"
    )


    print(
        f"WORKS    : "
        f"{works_count}"
    )

    print(
        f"GOODS    : "
        f"{goods_count}"
    )

    print(
        f"SERVICES : "
        f"{services_count}"
    )

    print(
        f"TOTAL    : "
        f"{len(tenders)}"
    )


    # ========================================================
    # SAFETY CHECK
    # Do NOT destroy the working database if one endpoint fails.
    # ========================================================

    if works_count == 0:

        raise RuntimeError(

            "WORKS returned 0 tenders. "
            "Existing database WAS NOT overwritten."
        )


    if goods_count == 0:

        raise RuntimeError(

            "GOODS returned 0 tenders. "
            "Existing database WAS NOT overwritten."
        )


    if services_count == 0:

        raise RuntimeError(

            "SERVICES returned 0 tenders. "
            "Existing database WAS NOT overwritten."
        )


    # ========================================================
    # SORT NEWEST FIRST
    # ========================================================

    tenders.sort(

        key=lambda tender: parse_date(

            tender.get(
                "published_date",
                ""
            )
        ),

        reverse=True
    )


    # ========================================================
    # CREATE OUTPUT
    # ========================================================

    output = {

        "generated_at": (
            datetime.now(
                timezone.utc
            ).isoformat()
        ),

        "source":
            BASE_URL,

        "last_full_at":
            LAST_FULL_AT,

        "count":
            len(tenders),

        "category_counts": {

            "WORKS":
                works_count,

            "GOODS":
                goods_count,

            "SERVICES":
                services_count,
        },

        "tenders":
            tenders,
    }


    # ========================================================
    # WRITE SAFELY
    # ========================================================

    OUTPUT_FILE.parent.mkdir(

        parents=True,

        exist_ok=True
    )


    temporary_file = (
        OUTPUT_FILE.with_suffix(
            ".tmp"
        )
    )


    temporary_file.write_text(

        json.dumps(

            output,

            ensure_ascii=False,

            indent=2
        ),

        encoding="utf-8"
    )


    temporary_file.replace(
        OUTPUT_FILE
    )


    # ========================================================
    # FINISH
    # ========================================================

    elapsed = (
        time.time()
        -
        start_time
    )


    print()
    print(
        "============================================================"
    )

    print(
        "SUCCESS"
    )

    print(
        "============================================================"
    )

    print(
        f"TOTAL TENDERS : "
        f"{len(tenders)}"
    )

    print(
        f"WORKS         : "
        f"{works_count}"
    )

    print(
        f"GOODS         : "
        f"{goods_count}"
    )

    print(
        f"SERVICES      : "
        f"{services_count}"
    )

    print(
        f"SAVED TO      : "
        f"{OUTPUT_FILE}"
    )

    print(
        f"TIME          : "
        f"{elapsed:.1f} seconds"
    )

    print(
        "============================================================"
    )


# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":

    main()
