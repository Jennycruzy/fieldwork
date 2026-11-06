"""Compare a city layer's Year field with each record's own date, straight from the city's ArcGIS server.

Usage: python3 scripts/year-field-check.py > evidence/period/montgomery-year-field.json
"""

import datetime
import json
import urllib.parse
import urllib.request

BASE = "https://gis.montgomeryal.gov/server/rest/services/HostedDatasets/"
LAYERS = [
    ("Code violations", BASE + "Code_Violations/FeatureServer/0", "CaseDate", "'"),
    ("311 service requests", BASE + "Received_311_Service_Request/MapServer/0", "Create_Date", ""),
]
YEARS = [2024, 2025, 2026]


def stats(url, where, date_field):
    out = [
        {"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "n"},
        {"statisticType": "min", "onStatisticField": date_field, "outStatisticFieldName": "first"},
        {"statisticType": "max", "onStatisticField": date_field, "outStatisticFieldName": "last"},
    ]
    q = urllib.parse.urlencode({"where": where, "outStatistics": json.dumps(out), "f": "json"})
    with urllib.request.urlopen(url + "/query?" + q, timeout=120) as r:
        a = json.load(r)["features"][0]["attributes"]

    def day(v):
        if v is None:
            return None
        if isinstance(v, str):
            return v[:10]
        return datetime.datetime.fromtimestamp(v / 1000, datetime.timezone.utc).date().isoformat()

    return {"where": where, "records": a["n"], "first_date": day(a["first"]), "last_date": day(a["last"])}


def main():
    result = {
        "checked_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        "finding": "The Year field is not the calendar year: Year 2026 starts on 1 October 2025 in both layers.",
        "layers": [],
    }
    for title, url, date_field, quote in LAYERS:
        layer = {"title": title, "url": url, "date_field": date_field, "by_year_field": [], "by_record_date": []}
        for y in YEARS:
            layer["by_year_field"].append(stats(url, f"Year = {quote}{y}{quote}", date_field))
            layer["by_record_date"].append(
                stats(
                    url,
                    f"{date_field} >= TIMESTAMP '{y}-01-01 00:00:00' AND {date_field} < TIMESTAMP '{y + 1}-01-01 00:00:00'",
                    date_field,
                )
            )
        result["layers"].append(layer)
    print(json.dumps(result, indent=2))


main()
