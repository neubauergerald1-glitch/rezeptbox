#!/usr/bin/env python3
"""Erzeugt die App-Daten aus einem Abzug der Rezeptbox-Datenbank (claude.ai).

Aufrufe (aus dem Repository-Ordner):
  python3 tools/build_data.py missing --db DUMP_DIR [--limit 60]
      Gibt die Bild-IDs aus, deren Foto noch nicht in images/ liegt (neueste Rezepte zuerst).
  python3 tools/build_data.py add-images --src DOWNLOAD_DIR
      Kopiert heruntergeladene Fotos (<bild-id>.<endung>) nach images/.
  python3 tools/build_data.py build --db DUMP_DIR
      Schreibt data/recipes.json und data/meta.json.

DUMP_DIR ist der Ordner mit einer JSON-Datei pro Rezept (<rezept-id>.json), wie ihn
ArtifactData "list" mit out_dir unter .../recipes/ ablegt.
"""
import argparse, glob, json, os, shutil, sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG_DIR = os.path.join(ROOT, "images")
EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif")


def load_dump(db):
    out = []
    for f in sorted(glob.glob(os.path.join(db, "*.json"))):
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
        if isinstance(d, dict) and isinstance(d.get("data"), dict) and "title" not in d:
            d = d["data"]
        if not isinstance(d, dict) or not d.get("title"):
            continue
        d = {"id": os.path.basename(f)[:-5], **{k: v for k, v in d.items() if k != "id"}}
        out.append(d)
    if not out:
        sys.exit(f"Keine Rezepte in {db} gefunden – Abbruch, damit nichts gelöscht wird.")
    return out


def image_file(image_id):
    for e in EXTS:
        p = os.path.join(IMG_DIR, image_id + e)
        if os.path.exists(p):
            return "images/" + image_id + e
    return None


def as_list(v):
    if isinstance(v, list):
        return [str(x) for x in v if x not in (None, "")]
    return [] if v in (None, "") else [str(v)]


def clean(r):
    t = r.get("tags") if isinstance(r.get("tags"), dict) else {}
    r["tags"] = {g: as_list(t.get(g)) for g in ("kueche", "ernaehrung", "gang", "sport")}
    r["ingredients"] = as_list(r.get("ingredients"))
    r["steps"] = as_list(r.get("steps"))
    img_id = r.pop("imageId", None)
    path = image_file(img_id) if img_id else None
    if path:
        r["img"] = path
    else:
        r.pop("img", None)
    return r


def cmd_missing(a):
    recipes = load_dump(a.db)
    recipes.sort(key=lambda r: r.get("updatedAt") or r.get("createdAt") or "", reverse=True)
    seen, ids = set(), []
    for r in recipes:
        i = r.get("imageId")
        if i and i not in seen and not image_file(i):
            seen.add(i)
            ids.append(i)
    total = len(ids)
    for i in ids[: a.limit]:
        print(i)
    print(f"# {total} Fotos fehlen, {min(total, a.limit)} ausgegeben", file=sys.stderr)


def cmd_add_images(a):
    os.makedirs(IMG_DIR, exist_ok=True)
    n = 0
    for f in glob.glob(os.path.join(a.src, "*")):
        base, ext = os.path.splitext(os.path.basename(f))
        if ext.lower() in EXTS and len(base) == 32:
            shutil.copyfile(f, os.path.join(IMG_DIR, base + ext.lower()))
            n += 1
    print(f"{n} Fotos übernommen")


def cmd_build(a):
    recipes = [clean(r) for r in load_dump(a.db)]
    recipes.sort(key=lambda r: r["id"])
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "recipes.json"), "w", encoding="utf-8") as fh:
        json.dump(recipes, fh, ensure_ascii=False, separators=(",", ":"))
    meta = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "recipes": len(recipes),
        "withPhoto": sum(1 for r in recipes if r.get("img")),
    }
    with open(os.path.join(ROOT, "data", "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)
    print(json.dumps(meta, ensure_ascii=False))


p = argparse.ArgumentParser()
sub = p.add_subparsers(dest="cmd", required=True)
m = sub.add_parser("missing"); m.add_argument("--db", required=True); m.add_argument("--limit", type=int, default=60)
ai = sub.add_parser("add-images"); ai.add_argument("--src", required=True)
b = sub.add_parser("build"); b.add_argument("--db", required=True)
a = p.parse_args()
{"missing": cmd_missing, "add-images": cmd_add_images, "build": cmd_build}[a.cmd](a)
